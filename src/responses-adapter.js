'use strict';
/**
 * OpenAI Responses API (/v1/responses) -> Chat Completions 适配层
 * ---------------------------------------------------------------------------
 * 为什么需要这一层：
 *   Codex CLI 从 0.4x 起彻底删掉了 Chat Completions 支持，二进制里直接写着
 *     `wire_api = "chat"` is no longer supported.
 *   所以它只会请求 POST /v1/responses，走的是另一套协议：
 *     - 请求体是 instructions / input[] / tools[扁平结构] / max_output_tokens
 *     - 响应是 output[] 里的 message / function_call 条目
 *     - 流式是 response.created -> response.output_text.delta -> response.completed 这类事件
 *   上游只提供 /v1/chat/completions，因此必须在网关里做双向翻译。
 *
 * 做法：
 *   1) translateRequest 把 Responses 请求体翻成 Chat Completions 请求体；
 *   2) 交给 api-bridge 里已有的直连/agent 路径（复用工具调用合并、reasoning 重试、
 *      会话指纹、用量统计等全部既有能力，不再重写一遍）；
 *   3) 用一个内存 sink 假装成 http.ServerResponse 把它的输出收回来，再翻译成
 *      Responses 的 JSON 或 SSE 事件。
 *
 * 这样做的代价是多一次 JSON 序列化/反序列化（可忽略），
 * 换来的是"任何对 chat 路径的修复自动对 Codex 生效"，不会出现两套逻辑走偏。
 */

const { isObj, str, newId, createSink, readBody: readBodyShared, sendJson, sendError, getAllowedAccounts, extractMigrationFlags, isToolSearchType, emitConsumedTrace, dedupeJoin, unsupportedToolsError, unsupportedListError, collectDeclaredToolNames, resolveToolChoice, degradeChoiceForEmptyTools, emitDegradedChoiceTrace, consumeDeferLoading } = require('./adapter-common');
const thinking = require('./thinking');

// --------------------------------------------------------------------------
// 请求翻译：Responses -> Chat Completions
// --------------------------------------------------------------------------

// Responses 的内容块 -> Chat Completions 的内容块
function partToChat(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!isObj(part)) return null;
  const t = str(part.type);
  if (t === 'input_text' || t === 'output_text' || t === 'text' || t === 'summary_text') {
    return { type: 'text', text: str(part.text) };
  }
  // 同上，但某些实现会把 type 省掉只给 text
  if (!t && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (t === 'input_image' || t === 'image_url') {
    let url = part.image_url;
    if (isObj(url)) url = url.url;
    if (!url) url = part.url;
    if (!url) return null;
    const img = { url: str(url) };
    const detail = part.detail || (isObj(part.image_url) && part.image_url.detail);
    if (detail) img.detail = detail;
    return { type: 'image_url', image_url: img };
  }
  if (t === 'input_file' || t === 'file' || t === 'input_audio' || t === 'audio') {
    // 这些无法用 Chat Completions 表达，退化成一句文字说明，别让模型对着空气回答
    const name = part.filename || part.file_id || part.name || t;
    return { type: 'text', text: `[附件 ${name}：当前网关不支持该类型，内容未送达]` };
  }
  if (t === 'refusal') return { type: 'text', text: str(part.refusal) };
  return null;
}

function contentToChat(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return str(content);
  const parts = [];
  for (const p of content) {
    const q = partToChat(p);
    if (q) parts.push(q);
  }
  if (!parts.length) return '';
  // 纯文本就压成字符串：绝大多数后端对 string 的处理更稳
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

// function_call_output 的 output 字段可能是字符串 / 内容块数组 / 对象
function outputToText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'number' || typeof output === 'boolean') return String(output);
  if (Array.isArray(output)) {
    return output.map((p) => {
      if (typeof p === 'string') return p;
      if (!isObj(p)) return str(p);
      if (typeof p.text === 'string') return p.text;
      if (typeof p.content === 'string') return p.content;
      return JSON.stringify(p);
    }).join('');
  }
  if (isObj(output)) {
    if (typeof output.text === 'string') return output.text;
    if (typeof output.content === 'string') return output.content;
    return JSON.stringify(output);
  }
  return str(output);
}

// Responses 的 function 工具是扁平结构 {type,name,description,parameters}；
// Chat Completions 要套一层 {type:'function', function:{...}}。
function toolsToChat(tools, notes) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!isObj(t)) continue;
    const type = str(t.type) || 'function';
    if (type === 'function') {
      const fn = isObj(t.function) ? t.function : t;
      const name = fn.name || t.name;
      if (!name) continue;
      // ADR-0021: defer_loading 是 Claude Code 的按需加载标记，上游白名单必拒。
      // 白名单重建本就剥掉它，这里显式留痕，让"假开关"在日志里可见；
      // 写入侧收敛到 adapter-common 的 consumeDeferLoading（domain 表达扁平/嵌套差异）。
      consumeDeferLoading(t, notes, 'responses');
      out.push({
        type: 'function',
        function: {
          name: str(name),
          description: str(fn.description),
          parameters: isObj(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
        },
      });
      continue;
    }
    // custom 类工具（Codex 的 apply_patch 用的就是它）本质是"整段文本进、整段文本出"，
    // 可以无损地映射成只有一个字符串参数 function，模型照样能调。
    if (type === 'custom' && t.name) {
      const props = (isObj(t.format) && isObj(t.format.definition)) ? {} : {};
      out.push({
        type: 'function',
        function: {
          name: str(t.name),
          description: str(t.description) || `${t.name}（自由文本工具）`,
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: '该工具的完整输入内容，按原样给出' },
            },
            required: ['input'],
            ...props,
          },
        },
      });
      if (notes) notes.customTools.push(str(t.name));
      continue;
    }
    // ADR-0021: tool_search 一族消费——检索在 Anthropic 服务端单次调用内完成，
    // 网关以工具前置加载等价替代（全部工具定义进上游上下文），因此不 400。
    // 客户端变体（tool_search_tool_regex / tool_search_tool_bm25 及日期后缀）一律认。
    // 判定收敛到 adapter-common 的 isToolSearchType，域参数 'responses' 额外认裸类型。
    if (isToolSearchType(type, 'responses')) {
      if (notes) notes.consumedTools.push(type);
      continue;
    }
    // local_shell / web_search / file_search / computer_use 这类是未实现的厂商特定功能或服务端内置工具
    // Issue #07 & US-46: 严禁静默丢弃或伪造成功，明确记录为 unsupportedTools 返回 400
    if (notes) {
      notes.unsupportedTools.push(type);
      notes.droppedTools.push(type);
    }
  }
  return out;
}

function toolChoiceToChat(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
    return undefined;
  }
  if (isObj(tc)) {
    const name = tc.name || (isObj(tc.function) && tc.function.name);
    if (name) return { type: 'function', function: { name: str(name) } };
    if (tc.type === 'function' && !name) return 'required';
  }
  return undefined;
}

// text.format -> response_format
function textFormatToChat(text) {
  if (!isObj(text) || !isObj(text.format)) return undefined;
  const f = text.format;
  if (f.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: str(f.name) || 'output',
        schema: isObj(f.schema) ? f.schema : { type: 'object' },
        strict: f.strict === true,
      },
    };
  }
  if (f.type === 'json_object') return { type: 'json_object' };
  return undefined;
}

/**
 * 主翻译入口。
 * @returns {{chat: object, notes: object}}
 */
function translateRequest(body) {
  const notes = { droppedTools: [], unsupportedTools: [], customTools: [], unknownInput: [], consumedTools: [], consumedInput: [], consumedFields: [], previousResponseId: null, degradedToolChoice: null };
  const messages = [];

  // 原始声明的工具名（含 tool_search 条目的类型名）：区分「被消费」与「笔误」（降级 vs 透传）
  const declaredToolNames = collectDeclaredToolNames(body.tools, 'responses');

  // instructions 就是 Responses 版的 system prompt
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item == null) continue;
      if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
      if (!isObj(item)) continue;

      const type = str(item.type) || (item.role ? 'message' : '');

      if (type === 'message' || (!type && item.role)) {
        const role = item.role === 'assistant' ? 'assistant'
          : (item.role === 'system' || item.role === 'developer') ? 'system' : 'user';
        messages.push({ role, content: contentToChat(item.content) });
        continue;
      }

      if (type === 'function_call') {
        // 同一轮的多次工具调用要合并进同一条 assistant 消息的 tool_calls 里
        let last = messages[messages.length - 1];
        if (!last || last.role !== 'assistant') {
          last = { role: 'assistant', content: null };
          messages.push(last);
        }
        if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
        last.tool_calls.push({
          id: str(item.call_id || item.id) || newId('call'),
          type: 'function',
          function: {
            name: str(item.name),
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
          },
        });
        continue;
      }

      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: str(item.call_id || item.id),
          content: outputToText(item.output),
        });
        continue;
      }

      if (type === 'custom_tool_call') {
        // 把 custom 工具的调用回放成普通的 function_call，参数名用 input
        let last = messages[messages.length - 1];
        if (!last || last.role !== 'assistant') {
          last = { role: 'assistant', content: null };
          messages.push(last);
        }
        if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
        last.tool_calls.push({
          id: str(item.call_id || item.id) || newId('call'),
          type: 'function',
          function: {
            name: str(item.name),
            arguments: JSON.stringify({ input: str(item.input) }),
          },
        });
        continue;
      }

      // reasoning / item_reference / web_search_call 等：对 Chat Completions 没有意义，跳过
      if (type === 'reasoning' || type === 'compaction') continue;
      // ADR-0021: 历史 input 里的 tool search 痕迹消费——检索插曲已被前置加载等价替代，
      // 上游看到的是省略该插曲的连贯历史，不进 unknownInput。若 input 全是痕迹条目
      // 且无 instructions，这里会得到空 messages 发上游，由上游返回 400——属「上游拒绝」
      // （GLOSSARY.md）而非本地拒绝；极边缘（Codex 恒有 instructions），不做兜底填充。
      if (type === 'tool_search_call' || type === 'tool_search_output' || type === 'tool_reference') {
        notes.consumedInput.push(type);
        continue;
      }
      notes.unknownInput.push(type || '(无 type)');
    }
  } else if (input != null) {
    messages.push({ role: 'user', content: str(input) });
  }

  const chat = { messages };
  if (body.model) chat.model = body.model;

  const tools = toolsToChat(body.tools, notes);
  if (tools.length) {
    chat.tools = tools;
    const tc = toolChoiceToChat(body.tool_choice);
    if (tc !== undefined) {
      const name = tc && tc.type === 'function' && tc.function ? tc.function.name : null;
      const resolved = name ? resolveToolChoice(tools, name, notes, declaredToolNames) : tc;
      if (resolved) chat.tool_choice = resolved;
    }
    if (typeof body.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = body.parallel_tool_calls;
  } else if (isObj(body.tool_choice)) {
    // tools 全空：tool_choice 无法下发；仅当确有消费时记降级（required / 具名 均属指定意图）
    const label = body.tool_choice.name || (body.tool_choice.type === 'function' ? 'required' : null);
    degradeChoiceForEmptyTools(notes, label ? str(label) : null);
  }

  if (typeof body.max_output_tokens === 'number' && body.max_output_tokens > 0) {
    chat.max_tokens = body.max_output_tokens;
  }
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;

  const rf = textFormatToChat(body.text);
  if (rf) chat.response_format = rf;

  // 思考强度：统一档位层（ADR-0022）。认识的外来词先归一成内部档位，
  // 直连路径再翻成上游方言；不认识的词原样保留，交给上游自己的归一化。
  // 不再有 REASONING 门槛——档位映射是默认行为，REASONING 只管响应侧剥不剥。
  if (isObj(body.reasoning) && body.reasoning.effort) {
    notes.reasoningEffort = str(body.reasoning.effort);
    const lvl = thinking.levelFromEffort(body.reasoning.effort);
    chat.reasoning_effort = lvl || str(body.reasoning.effort).trim();
  }

  // 上游只在使用 include_usage 时才回 usage；Codex 不会传，这里替它要上，
  // 保证网关的用量统计和 Codex 的 token 显示都有真实数字。
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
// 响应翻译：Chat Completions -> Responses
// --------------------------------------------------------------------------
function mapUsage(u) {
  const src = isObj(u) ? u : {};
  const prompt = Number(src.prompt_tokens || 0);
  const completion = Number(src.completion_tokens || 0);
  const total = Number(src.total_tokens || prompt + completion);
  const cached = (isObj(src.prompt_tokens_details) && Number(src.prompt_tokens_details.cached_tokens))
    || Number(src.prompt_cache_hit_tokens || 0);
  const reasoning = (isObj(src.completion_tokens_details) && Number(src.completion_tokens_details.reasoning_tokens)) || 0;
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total,
  };
}

function emptyUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
}

function responseShell({ id, model, created, status, output, usage, store, error }) {
  const o = {
    id,
    object: 'response',
    created_at: created,
    status,
    background: false,
    error: error || null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: model || 'unknown',
    output: output || [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: store !== false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: usage || null,
    user: null,
    metadata: {},
  };
  // output_text 是 SDK 的便捷聚合字段
  o.output_text = (output || [])
    .filter((it) => it.type === 'message' && Array.isArray(it.content))
    .map((it) => it.content.filter((c) => c.type === 'output_text').map((c) => c.text).join(''))
    .join('');
  return o;
}

// --------------------------------------------------------------------------
// 入口
// --------------------------------------------------------------------------
function createResponsesAdapter(deps) {
  const { log, run, checkModel, resolveModel, maxBodyBytes, dump, debugDump, responseHistoryManager } = deps;
  const MAX_BODY = maxBodyBytes || 20 * 1024 * 1024;

  function readBody(req) { return readBodyShared(req, MAX_BODY); }

  // ---- SSE 写出（Responses 用 event: + data: 双行，和 OpenAI 一致）----
  function sse(res, event, obj) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  // ------------------------------------------------------------------
  // 流式：把 chat chunk 流翻译成 Responses 事件流
  // ------------------------------------------------------------------
  function runStreaming(req, res, chat, keyName, meta) {
    return new Promise((resolve) => {
      const rid = newId('resp');
    const created = Math.floor(Date.now() / 1000);
    let started = false;
    let finished = false;
    let model = chat.model || 'unknown';
    let usage = null;
    let sawAny = false;
    let lastFinish = null;

    // 输出条目状态
    let outputIndex = 0;
    const finalItems = [];          // 已完成条目（按顺序）
    let textItem = null;            // 当前文本条目 {id, index, text}
    let textClosed = false;
    let reasoningBuf = '';          // 思考内容，正文为空时兜底
    const toolAcc = new Map();      // chat 的 tool_calls index -> {id,name,args}

    function start() {
      if (started) return;
      started = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const shell = responseShell({
        id: rid, model, created, status: 'in_progress', output: [], usage: null, store: meta.store,
      });
      sse(res, 'response.created', { type: 'response.created', response: shell });
      sse(res, 'response.in_progress', { type: 'response.in_progress', response: shell });
    }

    function ensureTextItem() {
      if (textClosed) return null;   // 已经收尾，不再开新条目
      if (textItem) return textItem;
      textItem = { id: newId('msg'), index: outputIndex++, text: '' };
      start();
      sse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: textItem.index,
        item: { type: 'message', id: textItem.id, role: 'assistant', status: 'in_progress', content: [] },
      });
      sse(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      return textItem;
    }

    function pushText(piece) {
      if (!piece) return;
      const it = ensureTextItem();
      if (!it) return;
      it.text += piece;
      sawAny = true;
      sse(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: it.id,
        output_index: it.index,
        content_index: 0,
        delta: piece,
      });
    }

    function closeText() {
      if (!textItem || textClosed) return;
      textClosed = true;
      const it = textItem;
      sse(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: it.id, output_index: it.index, content_index: 0, text: it.text,
      });
      sse(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: it.id, output_index: it.index, content_index: 0,
        part: { type: 'output_text', text: it.text, annotations: [] },
      });
      const item = {
        type: 'message', id: it.id, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: it.text, annotations: [] }],
      };
      sse(res, 'response.output_item.done', {
        type: 'response.output_item.done', output_index: it.index, item,
      });
      finalItems.push(item);
      textItem = null;
    }

    function flushTools() {
      if (!toolAcc.size) return;
      const calls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
      toolAcc.clear();
      for (const [, c] of calls) {
        const itemId = newId('fc');
        const callId = c.id || newId('call');
        const args = c.args || '{}';
        const oi = outputIndex++;
        sse(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: oi,
          item: {
            type: 'function_call', id: itemId, call_id: callId,
            name: c.name || '', arguments: '', status: 'in_progress',
          },
        });
        sse(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: itemId, output_index: oi, delta: args,
        });
        sse(res, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: itemId, output_index: oi, arguments: args,
        });
        const item = {
          type: 'function_call', id: itemId, call_id: callId,
          name: c.name || '', arguments: args, status: 'completed',
        };
        sse(res, 'response.output_item.done', {
          type: 'response.output_item.done', output_index: oi, item,
        });
        finalItems.push(item);
        sawAny = true;
      }
    }

    function finishOk() {
      if (finished) return;
      start();
      // 整轮一个字的正文都没有、只有思考内容时兜底，否则 Codex 拿到空回复
      if (!sawAny && !toolAcc.size && reasoningBuf.trim()) {
        pushText(reasoningBuf);
      }
      closeText();
      flushTools();
      // 全空也要给一条消息，否则 Codex 认为没有任何输出
      if (!finalItems.length) {
        const it = { id: newId('msg'), index: outputIndex++, text: '' };
        textItem = it;
        textClosed = false;
        closeText();
      }
      finished = true;
      const shell = responseShell({
        id: rid, model, created, status: 'completed',
        output: finalItems, usage: usage ? mapUsage(usage) : emptyUsage(), store: meta.store,
      });

      // 记录流式生成历史 (Issue #08 / US 48)
      if (responseHistoryManager) {
        const textContent = finalItems
          .filter((it) => it.type === 'message' && Array.isArray(it.content))
          .map((it) => it.content.filter((c) => c.type === 'output_text').map((c) => c.text).join(''))
          .join('');
        const toolCalls = finalItems
          .filter((it) => it.type === 'function_call')
          .map((it, idx) => ({
            id: it.call_id || it.id || `call_${idx}`,
            type: 'function',
            function: { name: it.name, arguments: it.arguments || '{}' },
          }));
        const assistantMsg = { role: 'assistant', content: textContent };
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
        const turnMessages = [...chat.messages, assistantMsg];

        responseHistoryManager.record({
          id: rid,
          keyId: req.__keyId || (req.__key && req.__key.id) || keyName,
          model: shell.model,
          messages: turnMessages,
          output: finalItems,
          usage: shell.usage,
          store: meta.store,
        });
      }

      sse(res, 'response.completed', { type: 'response.completed', response: shell });
      res.end();
      resolve();
      log('[responses] stream done id=%s model=%s items=%d text=%d tools=%d finish=%s usage=%j',
        rid, model, finalItems.length,
        finalItems.reduce((n, it) => n + (it.type === 'message' ? (it.content[0] ? it.content[0].text.length : 0) : 0), 0),
        finalItems.filter((it) => it.type === 'function_call').length, lastFinish, usage);
    }

    function finishFail(message, code) {
      if (finished) return;
      finished = true;
      if (!started) {
        sendError(res, 502, message, code || 'upstream_error', 'upstream_error');
        resolve();
        return;
      }
      const shell = responseShell({
        id: rid, model, created, status: 'failed', output: finalItems, usage: null, store: meta.store,
        error: { code: code || 'upstream_error', message },
      });
      sse(res, 'response.failed', { type: 'response.failed', response: shell });
      res.end();
      resolve();
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
      if (typeof delta.content === 'string' && delta.content) pushText(delta.content);
      if (typeof delta.reasoning_content === 'string') reasoningBuf += delta.reasoning_content;

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
      // 正文先落地，工具调用统一在收尾时按顺序补发
      if (ch.finish_reason && textItem) closeText();
    }

    const sink = createSink((chunk) => {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        try { handleBlock(block); } catch (e) { log('[responses] chunk 翻译失败: %s', e.message); }
      }
    });
    sink.onEnd = () => {
      if (buf.trim()) { try { handleBlock(buf); } catch { /* ignore */ } }
      if (finished) return;
      if (sink.statusCode !== 200) {
        finishFail(`上游返回 ${sink.statusCode}`, `upstream_${sink.statusCode}`);
        return;
      }
      finishOk();
    };

      if (typeof res.on === 'function') {
        res.once('close', () => {
          if (!finished) {
            finished = true;
            resolve();
          }
        });
        res.once('finish', () => {
          resolve();
        });
      }

      // 先把 200 和 response.created 发出去，再等上游。
      // 不能等第一个 chunk 才发头：历史会话的上下文可能十几万 token，上游要算十几秒，
      // 客户端在这段时间里一个字节都收不到，会先把自己的 idle 计时器跑满报 "request timed out"。
      // OpenAI 自己的实现也是立刻回 response.created，出错时用 response.failed 事件表达。
      start();

      try {
        run(req, sink, chat, keyName);
      } catch (e) {
        log('[responses] 调用上游失败: %s', e.message);
        finishFail('网关内部错误: ' + e.message, 'internal_error');
      }
    });
  }

  // ------------------------------------------------------------------
  // 非流式
  // ------------------------------------------------------------------
  function runOnce(req, res, chat, keyName, meta) {
    return new Promise((resolve) => {
      const rid = newId('resp');
      const created = Math.floor(Date.now() / 1000);
      let raw = '';
      const sink = createSink((chunk) => { raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); });

      sink.onEnd = () => {
        try {
          if (sink.statusCode !== 200) {
            // 上游错误体本身就是 OpenAI 风格，尽量原样带回，客户端能看懂
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch { /* ignore */ }
            if (parsed && parsed.error) {
              sendJson(res, sink.statusCode, parsed);
            } else {
              sendError(res, sink.statusCode === 200 ? 502 : sink.statusCode,
                raw.slice(0, 500) || '上游返回空响应', 'upstream_error', 'upstream_error');
            }
            resolve();
            return;
          }
          let j = null;
          try { j = JSON.parse(raw); } catch { /* ignore */ }
          if (!j || !Array.isArray(j.choices)) {
            sendError(res, 502, '上游返回了无法解析的内容：' + raw.slice(0, 300), 'bad_upstream_response', 'upstream_error');
            resolve();
            return;
          }
          const ch = j.choices[0] || {};
          const m = ch.message || {};
          const output = [];
          const text = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join('') : '';
          const calls = Array.isArray(m.tool_calls) ? m.tool_calls
            : (m.function_call ? [{ id: '', type: 'function', function: m.function_call }] : []);
          const finalText = text;
          if (finalText) {
            output.push({
              type: 'message', id: newId('msg'), role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: finalText, annotations: [] }],
            });
          }
          for (const tc of calls) {
            const fn = tc.function || {};
            output.push({
              type: 'function_call',
              id: newId('fc'),
              call_id: tc.id || newId('call'),
              name: str(fn.name),
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
              status: 'completed',
            });
          }
          const shell = responseShell({
            id: rid, model: j.model || chat.model, created, status: 'completed',
            output, usage: j.usage ? mapUsage(j.usage) : emptyUsage(), store: meta.store,
          });

          // 记录非流式生成历史 (Issue #08 / US 48)
          if (responseHistoryManager) {
            const textContent = (output || [])
              .filter((it) => it.type === 'message' && Array.isArray(it.content))
              .map((it) => it.content.filter((c) => c.type === 'output_text').map((c) => c.text).join(''))
              .join('');
            const toolCalls = (output || [])
              .filter((it) => it.type === 'function_call')
              .map((it, idx) => ({
                id: it.call_id || it.id || `call_${idx}`,
                type: 'function',
                function: { name: it.name, arguments: it.arguments || '{}' },
              }));
            const assistantMsg = { role: 'assistant', content: textContent };
            if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
            const turnMessages = [...chat.messages, assistantMsg];

            responseHistoryManager.record({
              id: rid,
              keyId: req.__keyId || (req.__key && req.__key.id) || keyName,
              model: shell.model,
              messages: turnMessages,
              output,
              usage: shell.usage,
              store: meta.store,
            });
          }

          sendJson(res, 200, shell);
          log('[responses] done id=%s model=%s items=%d usage=%j', rid, shell.model, output.length, j.usage);
        } finally {
          resolve();
        }
      };

      if (typeof res.on === 'function') {
        res.once('close', resolve);
        res.once('finish', resolve);
      }

      try {
        run(req, sink, chat, keyName);
      } catch (e) {
        log('[responses] 调用上游失败: %s', e.message);
        sendError(res, 500, '网关内部错误: ' + e.message, 'internal_error', 'server_error');
        resolve();
      }
    });
  }

  // ------------------------------------------------------------------
  // 主处理
  // ------------------------------------------------------------------
  async function handle(req, res, keyName) {
    const { body, tooLarge, decodeError, unsupportedEncoding } = await readBody(req);
    if (tooLarge) {
      sendError(res, 413, `请求体超过 ${Math.round(MAX_BODY / 1024 / 1024)}MB 上限`, 'body_too_large');
      return;
    }
    if (unsupportedEncoding) {
      sendError(res, 415, `无法解压请求体（Content-Encoding）: ${decodeError}`, 'unsupported_content_encoding');
      return;
    }
    if (decodeError) {
      sendError(res, 400, `请求体解压失败: ${decodeError}`, 'decompression_failed');
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      sendError(res, 400, '请求体不是合法 JSON', 'bad_json');
      return;
    }
    if (!isObj(parsed)) {
      sendError(res, 400, '请求体必须是 JSON 对象', 'bad_json');
      return;
    }

    // 模型解析与校验（ADR-0003: 废除静默回落，支持显式别名，未知模型返回 404）
    if (resolveModel) {
      const allowed = getAllowedAccounts(req);
      const mRes = resolveModel(parsed.model, allowed);
      if (!mRes.ok) {
        sendError(res, mRes.status || 404, mRes.message, mRes.code || 'model_not_found');
        return;
      }
      parsed.model = mRes.actualModel;
      req.__resolvedModel = mRes;
    } else if (checkModel) {
      const unknown = checkModel(parsed.model);
      if (unknown) {
        sendError(res, 404, `未知模型 "${unknown}"。可用的模型见 GET /v1/models。`, 'model_not_found');
        return;
      }
    }

    const { chat, notes } = translateRequest(parsed);

    // Issue #07 & US-46: 对未实现的厂商特定功能或工具类型返回明确错误，严禁静默丢弃
    // 守卫 / 文案 / 错误码收敛在 adapter-common 的 unsupportedToolsError；
    // 此处只保留 sendError 这一发送载体的差异。
    const unsupported = unsupportedToolsError(notes);
    if (unsupported) {
      sendError(res, 400, unsupported.message, unsupported.code);
      return;
    }

    const unknownInputError = unsupportedListError(notes.unknownInput, {
      code: 'unsupported_input_type',
      message: (list) => `不支持的 input 条目类型: ${list}。网关不提供未实现能力的静默丢弃。`,
    });
    if (unknownInputError) {
      sendError(res, 400, unknownInputError.message, unknownInputError.code);
      return;
    }

    // tool_choice 降级留痕放在本地拒绝之后：被 400 拒绝的请求不再声称「已降级」
    emitDegradedChoiceTrace(log, notes.degradedToolChoice, 'responses');

    // ADR-0021: 消费必须留痕——与丢弃/本地拒绝在日志里可区分；
    // 守卫/去重/格式化/按域键名全部收敛在 adapter-common 的 emitConsumedTrace。
    emitConsumedTrace(log, notes, 'responses');

    // previous_response_id：把上一轮的消息接回去 (ADR-0003, Issue #08, US 48 & US 49)
    if (typeof parsed.previous_response_id === 'string' && parsed.previous_response_id) {
      const callerKeyId = req.__keyId || (req.__key && req.__key.id) || keyName;
      if (responseHistoryManager) {
        const histRes = responseHistoryManager.get(parsed.previous_response_id, callerKeyId);
        if (!histRes.ok) {
          sendError(res, histRes.status, histRes.message, histRes.code);
          return;
        }
        chat.messages = [...histRes.entry.messages, ...chat.messages];
        log('[responses] 接上 previous_response_id=%s（%d 条历史）',
          parsed.previous_response_id, histRes.entry.messages.length);
      } else {
        sendError(res, 400, 'Server-side response history continuation is not enabled', 'history_disabled');
        return;
      }
    }

    if (notes.droppedTools.length) {
      log('[responses] ⚠ 丢弃服务端内置工具: %s（网关没有对应执行能力）',
        dedupeJoin(notes.droppedTools));
    }
    if (notes.customTools.length) {
      log('[responses] custom 工具已映射为单参数 function: %s',
        dedupeJoin(notes.customTools));
    }
    if (notes.unknownInput.length) {
      log('[responses] 跳过无法映射的 input 条目: %s',
        dedupeJoin(notes.unknownInput, 8));
    }

    if (debugDump && typeof dump === 'function') {
      dump(`responses-${Date.now()}-req.json`, JSON.stringify({
        model: parsed.model, stream: !!parsed.stream,
        instructions_chars: typeof parsed.instructions === 'string' ? parsed.instructions.length : 0,
        input_items: Array.isArray(parsed.input)
          ? parsed.input.map((it) => (isObj(it) ? (it.type || it.role || '?') : typeof it))
          : typeof parsed.input,
        // 原始 tools 结构原样留档：Codex 这类客户端的工具格式变化很快，
        // 出问题时靠这份 dump 才能判断是新类型还是我们映射错了
        tools_raw: parsed.tools,
        dropped_tools: notes.droppedTools,
        chat_messages: chat.messages.length,
        chat_tools: (chat.tools || []).length,
      }, null, 2));
    }

    const meta = {
      store: parsed.store === true,
      storeMessages: parsed.store === true ? chat.messages : null,
    };

    if (parsed.stream === true) return runStreaming(req, res, chat, keyName, meta);
    return runOnce(req, res, chat, keyName, meta);
  }

  // GET /v1/responses/:id —— Codex 在 store=true 时会回来取 (Issue #08 / US 48 & US 49)
  function handleGet(req, res, pathname) {
    const id = pathname.replace(/^\/v1\/responses\//, '');
    const callerKeyId = req.__keyId || (req.__key && req.__key.id) || req.__keyName || 'default';
    if (!responseHistoryManager) {
      sendError(res, 400, 'Server-side response history continuation is not enabled', 'history_disabled');
      return;
    }
    const histRes = responseHistoryManager.get(id, callerKeyId);
    if (!histRes.ok) {
      sendError(res, histRes.status, histRes.message, histRes.code);
      return;
    }
    const rec = histRes.entry;
    sendJson(res, 200, responseShell({
      id: rec.id,
      model: rec.model,
      created: Math.floor(rec.createdAt / 1000),
      status: rec.status || 'completed',
      output: rec.output || [],
      usage: rec.usage || emptyUsage(),
      store: true,
    }));
  }

  // POST /v1/responses/compact —— Codex 的上下文压缩端点。
  // 它期望拿到一个 encrypted_content 的 compaction 条目，网关无法伪造，
  // 明确返回 501 并说明原因，好过返回一个格式不对的 200 让 Codex 崩掉。
  function handleCompact(req, res) {
    readBody(req).then(() => {
      sendJson(res, 501, {
        error: {
          message: '网关不支持 /v1/responses/compact（上下文压缩需要 OpenAI 服务端的 compaction 格式，网关无法生成）。'
            + '请在 Codex 里避免触发自动压缩，或改用支持 Chat Completions 的客户端。',
          type: 'not_implemented', code: 'compact_not_supported',
        },
      });
    });
  }

  return { handle, handleGet, handleCompact, translateRequest };
}

module.exports = { createResponsesAdapter, translateRequest, mapUsage, responseShell };
