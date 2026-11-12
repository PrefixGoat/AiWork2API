'use strict';
/**
 * Anthropic Messages API (/v1/messages) -> Chat Completions 适配层
 * ---------------------------------------------------------------------------
 * 给谁用：Claude Code（含 CC Switch 里配的 Claude 供应商卡）、任何 Anthropic 协议客户端。
 *
 * 为什么需要：
 *   Claude Code 只认 Anthropic 的 Messages 协议，端点是 {ANTHROPIC_BASE_URL}/v1/messages，
 *   请求体是 system / messages[content blocks] / tools[input_schema]，
 *   响应是 content[] 里的 text / tool_use 块，流式走 message_start -> content_block_delta
 *   -> message_delta -> message_stop。上游只提供 chat.completions，所以必须双向翻译。
 *
 * 做法与 responses-adapter.js 完全一致：
 *   请求翻成 chat.completions -> 交给 api-bridge 既有直连/agent 路径（用假 ServerResponse 收回来）
 *   -> 再翻回 Anthropic 的事件流。这样子复用了工具合并、reasoning 重试、会话指纹、用量统计，
 *   不会出现两套逻辑各自漂移。
 *
 * 额外处理的两件事（Claude Code 特有）：
 *   1) 模型名：Claude Code 固定发 claude-* 系列名，网关模型表里没有。
 *      按 ADR-0003 与其他协议一致返回 404，不静默回落；客户端需配 model_aliases
 *      或把 ANTHROPIC_MODEL 改成真实模型 ID。
 *   2) POST /v1/messages/count_tokens：Claude Code 靠它做上下文管理，上游没这个端点，
 *      用字符估算兜住（宁可略偏大，否则真要超限时才发现）。
 */

const {
  isObj, str, newId, createSink, readBody: readBodyShared, sendJson,
  estimateTokens, friendlyUpstreamError, getAllowedAccounts, extractMigrationFlags, isToolSearchType, emitConsumedTrace, unsupportedToolsError, unsupportedListError, collectDeclaredToolNames, resolveToolChoice, degradeChoiceForEmptyTools, emitDegradedChoiceTrace, consumeDeferLoading,
} = require('./adapter-common');
const thinking = require('./thinking');

// --------------------------------------------------------------------------
// 请求翻译：Anthropic Messages -> Chat Completions
// --------------------------------------------------------------------------

// Anthropic 的 image block：{source:{type:'base64',media_type,data}} 或 {source:{type:'url',url}}
function imageBlockToChat(block) {
  const src = isObj(block.source) ? block.source : {};
  if (src.type === 'base64' && src.data) {
    const media = str(src.media_type) || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${media};base64,${str(src.data)}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: str(src.url) } };
  }
  return null;
}

// tool_result 的 content 可能是字符串，也可能是 [{type:'text',text}] 数组
function toolResultToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (!isObj(p)) return str(p);
      if (p.type === 'image') return '[图片结果已省略]';
      if (typeof p.text === 'string') return p.text;
      return JSON.stringify(p);
    }).join('\n');
  }
  if (isObj(content) && typeof content.text === 'string') return content.text;
  return JSON.stringify(content);
}

/**
 * 主翻译入口。
 * @returns {{chat: object, notes: object}}
 */
function translateRequest(body, ctx) {
  // ADR-0021：tool_search 一族是「消费」（有等价替代=工具前置加载），与「丢弃」
  // （无替代 capability，仍 400）区分。consumedTools / consumedBlocks / consumedFields
  // 只增不删旧键，供日志留痕与测试断言。
  const notes = { droppedBlocks: [], unsupportedTools: [], toolResults: 0, consumedTools: [], consumedBlocks: [], consumedFields: [], degradedToolChoice: null };
  // 历史里迁移自真实 Anthropic 会话的检索痕迹：客户端零执行，直接消费即可
  const TOOL_SEARCH_BLOCK_TYPES = new Set(['tool_reference', 'server_tool_use', 'tool_search_tool_result']);
  const messages = [];

  // 原始声明的工具名（含 tool_search 条目的类型名）：区分「被消费」与「笔误」（降级 vs 透传）
  const declaredToolNames = collectDeclaredToolNames(body.tools, 'messages');

  // ---- system：字符串或 [{type:'text',text}] ----
  let systemText = '';
  if (typeof body.system === 'string') {
    systemText = body.system;
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (systemText.trim()) messages.push({ role: 'system', content: systemText });

  // ---- messages ----
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObj(m)) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content;

    // 纯字符串直接过
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      messages.push({ role, content: content == null ? '' : JSON.stringify(content) });
      continue;
    }

    if (role === 'assistant') {
      // assistant 里可能有 thinking / text / tool_use 混排：thinking 转回
      // reasoning_content 随历史回传（ADR-0022：思考模式下工具多轮，上游要求
      // 带上本轮思考，否则 400）；text 拼正文，tool_use 进 tool_calls。
      let text = '';
      let thinkingTxt = '';
      let sawConsumedBlock = false; // 本条 assistant 消费过痕迹块：纯痕迹消息不残留空 assistant
      const toolCalls = [];
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text') { text += str(b.text); continue; }
        if (b.type === 'tool_use') {
          toolCalls.push({
            id: str(b.id) || newId('call'),
            type: 'function',
            function: {
              name: str(b.name),
              arguments: JSON.stringify(isObj(b.input) ? b.input : {}),
            },
          });
          continue;
        }
        if (b.type === 'thinking') {
          const t = str(b.thinking);
          if (t) thinkingTxt = thinkingTxt ? `${thinkingTxt}\n${t}` : t;
          continue;
        }
        // redacted_thinking 是密文，没有明文可回传；跳过但不计入 droppedBlocks，
        // 否则带历史思考的正常多轮会被 400 打断。
        if (b.type === 'redacted_thinking') continue;
        // ADR-0021 / 票据 01:21：三类检索痕迹块一律消费（不进 droppedBlocks，
        // :739 会据此 400）。server_tool_use 不做 name 判定——它是任意 server
        // tool 的调用块，其配对的 web_search_tool_result 等 result 块不在消费
        // 集合内，仍按丢弃 → 400，故整条 web_search 插曲请求照旧被拒绝（与
        // 旧行为一致）；tool search 插曲的 use + result 则成对消费，上游看到
        // 省略该插曲的连贯历史。
        if (TOOL_SEARCH_BLOCK_TYPES.has(b.type)) {
          notes.consumedBlocks.push(str(b.type));
          sawConsumedBlock = true;
          continue;
        }
        notes.droppedBlocks.push(`assistant:${str(b.type)}`);
      }
      // 纯痕迹 assistant（无 text/思考/工具调用）不再补 content:'' 空消息，
      // 与 user 分支的纯痕迹抑制对称；纯 thinking 消息仍保留 reasoning_content 回传。
      if (!text && !thinkingTxt && !toolCalls.length && sawConsumedBlock) continue;
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (thinkingTxt) msg.reasoning_content = thinkingTxt;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // user：text / image 合并成一条；tool_result 必须拆成独立的 role:"tool" 消息
    const parts = [];
    const toolMsgs = [];
    let sawConsumedBlock = false; // 本条消息里消费过 tool-search 痕迹块
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text') { parts.push({ type: 'text', text: str(b.text) }); continue; }
      if (b.type === 'image') {
        const img = imageBlockToChat(b);
        if (img) parts.push(img);
        continue;
      }
      if (b.type === 'tool_result') {
        let txt = toolResultToText(b.content);
        if (b.is_error === true) txt = `[工具执行报错] ${txt}`;
        toolMsgs.push({ role: 'tool', tool_call_id: str(b.tool_use_id), content: txt });
        notes.toolResults++;
        continue;
      }
      // ADR-0021：检索痕迹块消费（不进 droppedBlocks），纯块消息不残留空 user 消息
      if (TOOL_SEARCH_BLOCK_TYPES.has(b.type)) {
        notes.consumedBlocks.push(str(b.type));
        sawConsumedBlock = true;
        continue;
      }
      notes.droppedBlocks.push(`user:${str(b.type)}`);
    }
    // 顺序要求：tool 结果必须紧跟在带 tool_calls 的 assistant 之后。
    // Anthropic 允许把 tool_result 和文本混在同一个 user 消息里，这里先放 tool，再放文本。
    for (const t of toolMsgs) messages.push(t);
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text');
      messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
    } else if (!toolMsgs.length && !sawConsumedBlock) {
      // 消费了痕迹块后全空的消息不再补空 user 消息（ADR-0021）；
      // 原生空 content 的兜底行为保持不变。
      messages.push({ role: 'user', content: '' });
    }
  }

  const chat = { messages };
  if (body.model) chat.model = body.model;

  // ---- tools：input_schema -> parameters ----
  const tools = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObj(t)) continue;
    const type = str(t.type);
    // ADR-0021：Messages 侧 tool_search 一族（regex/bm25 及日期后缀变体）
    // 整体消费，不 400。判定必须放在 computer_/bash_/text_editor_ 之前，
    // 避免 server tool 条目（无 input_schema）误落 unsupportedTools 分支。
    // 判定收敛到 adapter-common 的 isToolSearchType，域参数保留 ADR-0021:23
    // 的划分（裸 tool_search 归 Responses，Messages 不消费、本地拒绝）。
    if (isToolSearchType(type, 'messages')) {
      notes.consumedTools.push(type);
      continue;
    }
    if (type && (type.startsWith('computer_') || type.startsWith('bash_') || type.startsWith('text_editor_'))) {
      notes.unsupportedTools.push(type);
      continue;
    }
    if (!t.name || !isObj(t.input_schema)) {
      notes.unsupportedTools.push(str(t.type) || str(t.name) || 'unknown_tool');
      notes.droppedBlocks.push(`tool:${str(t.type) || str(t.name)}`);
      continue;
    }
    // defer_loading 显式消费：适配器从零白名单构建（不 spread 客户端 wrapper），
    // 只拷贝协议内字段（name/description/input_schema），该开关不会出现在
    // 翻译结果里。工具判定与消费留痕已收敛到 adapter-common 的共享函数，
    // 协议差异通过 domain 参数显式表达；原生 chat 路径才需要整体重建剥 wrapper 层。
    consumeDeferLoading(t, notes, 'messages');
    tools.push({
      type: 'function',
      function: {
        name: str(t.name),
        description: str(t.description),
        parameters: t.input_schema,
      },
    });
  }
  // tool_choice 只在有工具下发时才翻译：tools 被 tool_search 全量消费后为空，
  // 此时再带 tool_choice / parallel_tool_calls 会被上游按「无 tools 却指定工具选择」
  // 拒绝（400）。已知限制：客户端指定的工具被消费后，tool_choice 的意图随之丢失，
  // 请求按纯文本对话继续。有工具时 auto/any/none/tool 四类语义与 AC6 保持不变。
  if (tools.length) {
    chat.tools = tools;
    const tc = body.tool_choice;
    if (isObj(tc)) {
      if (tc.type === 'auto') chat.tool_choice = 'auto';
      else if (tc.type === 'any') chat.tool_choice = 'required';
      else if (tc.type === 'none') chat.tool_choice = 'none';
      else if (tc.type === 'tool' && tc.name) {
        const resolved = resolveToolChoice(tools, str(tc.name), notes, declaredToolNames);
        if (resolved) chat.tool_choice = resolved;
      }
      if (typeof tc.disable_parallel_tool_use === 'boolean') {
        chat.parallel_tool_calls = !tc.disable_parallel_tool_use;
      }
    }
  } else if (isObj(body.tool_choice)) {
    // tools 全空：tool_choice 无法下发；仅当确有消费时记降级（any/tool 属「指定意图」）
    degradeChoiceForEmptyTools(notes, body.tool_choice.type === 'any'
      ? 'any'
      : (body.tool_choice.type === 'tool' && body.tool_choice.name ? str(body.tool_choice.name) : null));
  }

  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    chat.stop = body.stop_sequences.slice(0, 4);
  }

  // thinking：Anthropic 的预算制 → 统一档位（ADR-0022）。这里只写内部档位词，
  // 直连路径（runDirectPath）会统一翻成上游方言；off 档同样会转成显式关闭。
  if (isObj(body.thinking)) {
    const lvl = thinking.levelFromThinking(body.thinking);
    if (lvl) chat.reasoning_effort = lvl;
  }

  // 上游只在使用 include_usage 时才回 usage；Claude Code 不传，替它要上，
  // 否则拿不到 token 数，前端与统计都会是 0。
  if (body.stream === true) {
    chat.stream = true;
    chat.stream_options = { include_usage: true };
  } else {
    chat.stream = false;
  }

  // ADR-0004 & Issue #06: 保留不透明账号状态与会话上下文可重建性标记
  Object.assign(chat, extractMigrationFlags(body));

  return { chat, notes };
}

// --------------------------------------------------------------------------
// 响应翻译：Chat Completions -> Anthropic Messages
// --------------------------------------------------------------------------
function mapUsage(u) {
  const src = isObj(u) ? u : {};
  const input = Number(src.prompt_tokens || 0);
  const output = Number(src.completion_tokens || 0);
  const cached = (isObj(src.prompt_tokens_details) && Number(src.prompt_tokens_details.cached_tokens))
    || Number(src.prompt_cache_hit_tokens || 0);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function emptyUsage(inputEstimate) {
  return {
    input_tokens: inputEstimate || 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

// chat 的 finish_reason -> Anthropic 的 stop_reason
function mapStopReason(finish, hasTools) {
  if (hasTools) return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop') return 'end_turn';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  return 'end_turn';
}

function messageShell({ id, model, content, stopReason, stopSequence, usage }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: model || 'unknown',
    content: content || [],
    stop_reason: stopReason || 'end_turn',
    stop_sequence: stopSequence || null,
    usage: usage || emptyUsage(),
  };
}

// --------------------------------------------------------------------------
// 入口
// --------------------------------------------------------------------------
function createMessagesAdapter(deps) {
  const { log, run, checkModel, resolveModel, maxBodyBytes, dump, debugDump } = deps;
  const MAX_BODY = maxBodyBytes || 20 * 1024 * 1024;

  // Anthropic 的 SSE 也是 event: + data: 双行
  function sse(res, obj) {
    if (res.writableEnded) return;
    res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  // ------------------------------------------------------------------
  // 流式：chat chunk 流 -> Anthropic 事件序列
  // ------------------------------------------------------------------
  function runStreaming(req, res, chat, keyName, meta) {
    const mid = newId('msg');
    let started = false;
    let finished = false;
    let model = chat.model || 'unknown';
    let usage = null;
    let lastFinish = null;
    let sawAny = false;
    let reasoningBuf = '';

    let nextIndex = 0;
    let textOpen = false;
    let textIndex = -1;
    let thinkingOpen = false;
    let thinkingIndex = -1;
    let sawThinking = false;   // 思考块已经发过：不再走「思考兜底成正文」
    const toolAcc = new Map(); // chat 的 tool_calls index -> {id,name,args}
    let sawTextLen = 0;        // 正文长度，仅为日志
    let sawToolBlocks = 0;     // 本轮产出了几个 tool_use 块

    function start() {
      if (started) return;
      started = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sse(res, {
        type: 'message_start',
        message: messageShell({
          id: mid, model, content: [],
          stopReason: null, stopSequence: null,
          usage: emptyUsage(meta.inputEstimate),
        }),
      });
    }

    // Anthropic 一次只允许一个打开的块；开新块前必须把 thinking 块收掉，
    // 收尾带 signature_delta（空串），客户端回传历史时块形状才完整（ADR-0022）。
    function closeThinking() {
      if (!thinkingOpen) return;
      thinkingOpen = false;
      sse(res, { type: 'content_block_delta', index: thinkingIndex, delta: { type: 'signature_delta', signature: '' } });
      sse(res, { type: 'content_block_stop', index: thinkingIndex });
    }

    function openText() {
      if (textOpen) return;
      closeThinking();
      start();
      textOpen = true;
      textIndex = nextIndex++;
      sse(res, { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
    }

    function closeText() {
      if (!textOpen) return;
      textOpen = false;
      sse(res, { type: 'content_block_stop', index: textIndex });
    }

    function pushText(piece) {
      if (!piece) return;
      openText();
      sawAny = true;
      sse(res, {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: piece },
      });
    }

    function flushTools() {
      if (!toolAcc.size) return;
      closeThinking();
      start();
      const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
      toolAcc.clear();
      for (const [, c] of calls) {
        const idx = nextIndex++;
        const tid = str(c.id) || newId('toolu');
        sse(res, {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: tid, name: str(c.name), input: {} },
        });
        const args = str(c.args) || '{}';
        sse(res, {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: args },
        });
        sse(res, { type: 'content_block_stop', index: idx });
        sawAny = true;
      }
    }

    function finishOk() {
      if (finished) return;
      start();
      closeThinking();
      // 整轮没有正文、没有思考块、没有工具时才把思考兜底成正文，否则 Claude Code 会显示空回复
      if (!sawAny && !toolAcc.size && !sawThinking && reasoningBuf.trim()) pushText(reasoningBuf);
      closeText();
      flushTools();
      // 什么都没有也给一个空文本块，避免客户端卡在"正在输入"
      if (!sawAny && !nextIndex) {
        openText();
        closeText();
      }
      finished = true;
      // flushTools 会清空 toolAcc，所以 stop_reason 要用清空前记下的数量判断
      const stopReason = mapStopReason(lastFinish, sawToolBlocks > 0);
      sse(res, {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage ? mapUsage(usage) : emptyUsage(meta.inputEstimate),
      });
      sse(res, { type: 'message_stop' });
      res.end();
      log('[messages] stream done id=%s model=%s blocks=%d text=%d tools=%d stop=%s usage=%j',
        mid, model, nextIndex, sawTextLen, sawToolBlocks, stopReason, usage);
    }

    function finishFail(message, code) {
      if (finished) return;
      finished = true;
      if (!started) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'api_error', message },
        });
        return;
      }
      sse(res, { type: 'error', error: { type: 'api_error', message: str(message) || str(code) } });
      res.end();
    }

    // ---- chat chunk 处理 ----
    let buf = '';
    function handleBlock(block) {
      const lines = block.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (!lines.length) return;
      const payload = lines.join('\n');
      if (payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j.error) {
        finishFail(j.error.message || 'stream interrupted', j.error.code || 'stream_interrupted');
        return;
      }
      if (j.model) model = j.model;
      if (j.usage) usage = j.usage;
      const ch = Array.isArray(j.choices) ? j.choices[0] : null;
      if (!ch) return;

      const delta = ch.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        sawTextLen += delta.content.length;
        pushText(delta.content);
      }
      // ADR-0022：上游思考草稿 → Anthropic thinking 块实时转发。
      // REASONING=off 时 runDirectPath 已经剥掉 reasoning_content，到这里就是没有。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningBuf += delta.reasoning_content;
        if (!thinkingOpen) {
          start();
          thinkingOpen = true;
          sawThinking = true;
          thinkingIndex = nextIndex++;
          sse(res, { type: 'content_block_start', index: thinkingIndex, content_block: { type: 'thinking', thinking: '' } });
        }
        sse(res, { type: 'content_block_delta', index: thinkingIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue;
          const i = tc.index == null ? 0 : tc.index;
          const cur = toolAcc.get(i) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
          toolAcc.set(i, cur);
        }
      }
      if (delta.function_call && typeof delta.function_call === 'object') {
        const fc = delta.function_call;
        const cur = toolAcc.get(0) || { id: '', name: '', args: '' };
        if (fc.name) cur.name += fc.name;
        if (fc.arguments) cur.args += typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments);
        toolAcc.set(0, cur);
      }
      if (ch.finish_reason) lastFinish = ch.finish_reason;
    }

    // 非 200 时上游回的是 JSON 错误体，不是 SSE，单独收起来用于生成可读报错
    let rawErr = '';
    const sink = createSink((chunk) => {
      const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (sink.statusCode !== 200) { rawErr += s; return; }
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        try { handleBlock(block); } catch (e) { log('[messages] chunk 翻译失败: %s', e.message); }
      }
    });
    sink.onEnd = () => {
      if (buf.trim()) { try { handleBlock(buf); } catch { /* ignore */ } }
      if (finished) return;
      if (sink.statusCode !== 200) {
        log('[messages] 上游 %d: %s', sink.statusCode, rawErr.replace(/\s+/g, ' ').slice(0, 300));
        finishFail(friendlyUpstreamError(sink.statusCode, rawErr, chat.model), `upstream_${sink.statusCode}`);
        return;
      }
      sawToolBlocks = toolAcc.size;
      finishOk();
    };

    try {
      run(req, sink, chat, keyName);
    } catch (e) {
      log('[messages] 调用上游失败: %s', e.message);
      finishFail('网关内部错误: ' + e.message, 'internal_error');
    }
  }

  // ------------------------------------------------------------------
  // 非流式
  // ------------------------------------------------------------------
  function runOnce(req, res, chat, keyName, meta) {
    const mid = newId('msg');
    let raw = '';
    const sink = createSink((chunk) => { raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); });

    sink.onEnd = () => {
      if (sink.statusCode !== 200) {
        sendJson(res, sink.statusCode === 200 ? 502 : sink.statusCode, {
          type: 'error',
          error: {
            type: sink.statusCode === 429 ? 'rate_limit_error' : 'api_error',
            message: friendlyUpstreamError(sink.statusCode, raw, chat.model),
          },
        });
        return;
      }
      let j = null;
      try { j = JSON.parse(raw); } catch { /* ignore */ }
      if (!j || !Array.isArray(j.choices)) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'api_error', message: '上游返回了无法解析的内容：' + raw.slice(0, 300) },
        });
        return;
      }
      const ch = j.choices[0] || {};
      const m = ch.message || {};
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join('') : '';
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls
        : (m.function_call ? [{ id: '', type: 'function', function: m.function_call }] : []);
      const finalText = text;
      const content = [];
      // ADR-0022：上游思考草稿 → 首个 thinking 块（REASONING=off 时上游已被剥，到这里为空）
      if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) {
        content.push({ type: 'thinking', thinking: m.reasoning_content, signature: '' });
      }
      if (finalText) content.push({ type: 'text', text: finalText });
      for (const tc of calls) {
        const fn = tc.function || {};
        let input = {};
        const rawArgs = fn.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          try { input = JSON.parse(rawArgs); } catch { input = { _raw: rawArgs }; }
        } else if (isObj(rawArgs)) {
          input = rawArgs;
        }
        content.push({
          type: 'tool_use',
          id: str(tc.id) || newId('toolu'),
          name: str(fn.name),
          input,
        });
      }
      if (!content.length) content.push({ type: 'text', text: '' });

      sendJson(res, 200, messageShell({
        id: mid,
        model: j.model || chat.model,
        content,
        stopReason: mapStopReason(ch.finish_reason, calls.length > 0),
        stopSequence: null,
        usage: j.usage ? mapUsage(j.usage) : emptyUsage(meta.inputEstimate),
      }));
      log('[messages] done id=%s model=%s blocks=%d usage=%j', mid, j.model || chat.model, content.length, j.usage);
    };

    try {
      run(req, sink, chat, keyName);
    } catch (e) {
      log('[messages] 调用上游失败: %s', e.message);
      sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: '网关内部错误: ' + e.message } });
    }
  }

  // ------------------------------------------------------------------
  // 主处理
  // ------------------------------------------------------------------
  async function handle(req, res, keyName) {
    const { body, tooLarge, decodeError, unsupportedEncoding } = await readBodyShared(req, MAX_BODY);
    if (tooLarge) {
      sendJson(res, 413, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `请求体超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB 上限`, code: 'body_too_large' },
      });
      return;
    }
    if (unsupportedEncoding) {
      sendJson(res, 415, { type: 'error', error: { type: 'invalid_request_error', message: `无法解压请求体（Content-Encoding）: ${decodeError}`, code: 'unsupported_content_encoding' } });
      return;
    }
    if (decodeError) {
      sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `请求体解压失败: ${decodeError}`, code: 'decompression_failed' } });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '请求体不是合法 JSON' } });
      return;
    }
    if (!isObj(parsed)) {
      sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '请求体必须是 JSON 对象' } });
      return;
    }

    const { chat, notes } = translateRequest(parsed, {});

    // Issue #07 & US-46: 对未实现的厂商特定功能或工具类型返回明确错误，严禁静默丢弃
    // 守卫 / 文案 / 错误码收敛在 adapter-common 的 unsupportedToolsError；
    // 此处只保留 Anthropic 错误对象这一发送载体的差异。
    const unsupported = unsupportedToolsError(notes);
    if (unsupported) {
      sendJson(res, 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: unsupported.message,
          code: unsupported.code,
        },
      });
      return;
    }

    // 模型解析与校验（ADR-0003: 废除静默回落，支持显式别名，未知模型返回 404）
    if (resolveModel) {
      const allowed = getAllowedAccounts(req);
      const mRes = resolveModel(parsed.model || chat.model, allowed);
      if (!mRes.ok) {
        sendJson(res, mRes.status || 404, {
          type: 'error',
          error: {
            type: 'not_found_error',
            message: mRes.message,
            code: mRes.code || 'model_not_found',
          },
        });
        return;
      }
      chat.model = mRes.actualModel;
      req.__resolvedModel = mRes;
    } else if (checkModel) {
      const unknown = checkModel(chat.model);
      if (unknown) {
        sendJson(res, 404, {
          type: 'error',
          error: {
            type: 'not_found_error',
            message: `未知模型 "${unknown}"。可用的模型见 GET /v1/models。`,
            code: 'model_not_found',
          },
        });
        return;
      }
    }

    const droppedBlocksError = unsupportedListError(notes.droppedBlocks, {
      code: 'unsupported_content_block_type',
      message: (list) => `不支持的内容块类型: ${list}`,
    });
    if (droppedBlocksError) {
      log('[messages] 拒绝不支持的内容块类型: %s', droppedBlocksError.list);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: droppedBlocksError.message,
          code: droppedBlocksError.code,
        },
      }));
      return;
    }

    // ADR-0021：tool-search 消费留痕（与 droppedBlocks 的 400/拒绝日志可区分）；
    // tool_choice 降级留痕放在全部本地拒绝/404 之后：被拒绝的请求不再声称「已降级」
    emitDegradedChoiceTrace(log, notes.degradedToolChoice, 'messages');

    // 守卫/去重/格式化/按域键名全部收敛在 adapter-common 的 emitConsumedTrace。
    emitConsumedTrace(log, notes, 'messages');

    // message_start 里就要给 input_tokens，此时上游还没回，只能估算
    const inputEstimate = chat.messages.reduce(
      (n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
      0,
    ) + estimateTokens(JSON.stringify(chat.tools || []));

    if (debugDump && typeof dump === 'function') {
      dump(`messages-${Date.now()}-req.json`, JSON.stringify({
        model_raw: parsed.model, model_used: chat.model, stream: !!parsed.stream,
        max_tokens: parsed.max_tokens, tool_choice: parsed.tool_choice,
        thinking: parsed.thinking || null,
        messages_in: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        block_types: Array.isArray(parsed.messages)
          ? [...new Set(parsed.messages.flatMap((m) => (Array.isArray(m.content)
            ? m.content.map((b) => (isObj(b) ? b.type : typeof b)) : ['string'])))]
          : [],
        tools: (parsed.tools || []).map((t) => str(t.name)),
        chat_messages: chat.messages.length,
        chat_tools: (chat.tools || []).length,
        input_estimate: inputEstimate,
      }, null, 2));
    }

    const meta = { inputEstimate };
    if (parsed.stream === true) { runStreaming(req, res, chat, keyName, meta); return; }
    runOnce(req, res, chat, keyName, meta);
  }

  // POST /v1/messages/count_tokens
  // Claude Code 用它判断上下文占用、决定何时自动压缩。上游没有这个端点，
  // 只能估算；偏大一点比偏小安全（偏小会在真要超限时才发现）。
  async function handleCountTokens(req, res) {
    const { body } = await readBodyShared(req, MAX_BODY);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 按空请求处理 */ }
    const { chat } = translateRequest(isObj(parsed) ? parsed : {}, {});
    let n = 0;
    for (const m of chat.messages) {
      n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
      if (Array.isArray(m.tool_calls)) n += estimateTokens(JSON.stringify(m.tool_calls));
    }
    n += estimateTokens(JSON.stringify(chat.tools || []));
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Token-Count-Method', 'heuristic-estimate');
    }
    sendJson(res, 200, {
      input_tokens: Math.max(1, n),
      heuristic_estimate: true,
      note: 'Tokens counted using gateway local heuristic estimator',
    });
  }

  return { handle, handleCountTokens, translateRequest };
}

module.exports = { createMessagesAdapter, translateRequest, mapUsage, mapStopReason };
