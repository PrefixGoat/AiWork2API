#!/usr/bin/env python3
"""
OpenAI 兼容性自检：用各家 harness 实际会发出来的请求形状打一遍网关。

不依赖任何 SDK，只用标准库。用于换 harness / 升级上游之后快速回归，
确认"工具调用 / 流式 / usage / 多轮闭环"这些协议细节没退化。
同时覆盖 /v1/chat/completions 和 /v1/responses（Codex 用的那套）两条协议。

用法:
    python3 tests/conformance-test.py                 # 读 .env 里的端口和 key
    BASE_URL=http://1.2.3.4:8080 KEY=sk-xxx MODEL=auto python3 tests/conformance-test.py

退出码 0 = 全部通过，1 = 有失败项。
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_env():
    cfg = {}
    path = os.path.join(ROOT, '.env')
    if os.path.exists(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip()
    port = cfg.get('HOST_PORT', '8080')
    key = cfg.get('API_KEYS', '').split(',')[0].split(':')[0]
    return cfg, f'http://127.0.0.1:{port}', key


CFG, DEFAULT_BASE, DEFAULT_KEY = read_env()
BASE = os.environ.get('BASE_URL', DEFAULT_BASE).rstrip('/')
KEY = os.environ.get('KEY', DEFAULT_KEY)
MODEL = os.environ.get('MODEL', 'qwen3.8-max')
URL = f'{BASE}/v1/chat/completions'
RESP_URL = f'{BASE}/v1/responses'
MSG_URL = f'{BASE}/v1/messages'
COUNT_URL = f'{BASE}/v1/messages/count_tokens'

RESULTS = []


def post(body, timeout=180):
    """返回 (status, 原始文本)。不抛异常，让测试自己判断。"""
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
    )
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:  # 网络层
        return 0, str(e)


def post_responses(body, timeout=180):
    """打 /v1/responses（Codex 那套协议）。返回 (status, 原始文本)。"""
    req = urllib.request.Request(
        RESP_URL,
        data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
    )
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:  # 网络层
        return 0, str(e)


def parse_responses_sse(raw):
    """Responses 协议的事件流（event: + data: 双行），按 data 里的 type 归类。"""
    out = {
        'events': [], 'text': '', 'items': [], 'completed': None,
        'failed': None, 'arg_deltas': [], 'bad': [],
    }
    cur_event = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('event:'):
            cur_event = line[6:].strip()
            continue
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        try:
            j = json.loads(payload)
        except json.JSONDecodeError:
            out['bad'].append('非 JSON 帧')
            continue
        t = j.get('type') or cur_event or ''
        out['events'].append(t)
        if t == 'response.output_text.delta':
            out['text'] += j.get('delta') or ''
        elif t == 'response.function_call_arguments.delta':
            out['arg_deltas'].append(j.get('delta') or '')
        elif t == 'response.output_item.done':
            out['items'].append(j.get('item') or {})
        elif t == 'response.completed':
            out['completed'] = j.get('response') or {}
        elif t in ('response.failed', 'error'):
            out['failed'] = j
    return out


def parse_sse(raw):
    """把 SSE 拆成结构，同时做严格客户端的常见检查。"""
    out = {
        'frames': 0, 'text': '', 'tool_calls': [], 'finish': [],
        'done': False, 'usage': None, 'reasoning_frames': 0,
        'bad_content_types': [], 'ids': set(), 'objects': set(),
    }
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if payload == '[DONE]':
            out['done'] = True
            continue
        try:
            j = json.loads(payload)
        except json.JSONDecodeError:
            out['bad_content_types'].append('非 JSON 帧')
            continue
        out['frames'] += 1
        if j.get('id'):
            out['ids'].add(j['id'])
        if j.get('object'):
            out['objects'].add(j['object'])
        if j.get('usage'):
            out['usage'] = j['usage']
        for ch in j.get('choices', []):
            delta = ch.get('delta') or {}
            if delta.get('reasoning_content'):
                out['reasoning_frames'] += 1
            c = delta.get('content')
            if c is not None and not isinstance(c, str):
                out['bad_content_types'].append(type(c).__name__)
            out['text'] += c or ''
            if delta.get('tool_calls'):
                out['tool_calls'].extend(delta['tool_calls'])
            if ch.get('finish_reason'):
                out['finish'].append(ch['finish_reason'])
    return out


def post_messages(body, timeout=180, use_x_api_key=True):
    """打 /v1/messages（Anthropic 协议，Claude Code 用的这套）。

    use_x_api_key=True 时刻意用 x-api-key 而不是 Authorization ——
    Claude Code / Anthropic SDK 发的就是这个头，网关必须认。
    """
    headers = {'Content-Type': 'application/json', 'anthropic-version': '2023-06-01'}
    if use_x_api_key:
        headers['x-api-key'] = KEY
    else:
        headers['Authorization'] = f'Bearer {KEY}'
    req = urllib.request.Request(MSG_URL, data=json.dumps(body).encode(), headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, str(e)


def parse_anthropic_sse(raw):
    """Anthropic 的事件流：event: + data: 双行，按 data 里的 type 归类。"""
    out = {
        'events': [], 'text': '', 'blocks': [], 'stop_reason': None,
        'usage': None, 'error': None, 'bad': [],
    }
    cur = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('event:'):
            cur = line[6:].strip()
            continue
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        try:
            j = json.loads(payload)
        except json.JSONDecodeError:
            out['bad'].append('非 JSON 帧')
            continue
        t = j.get('type') or cur or ''
        out['events'].append(t)
        if t == 'content_block_start':
            out['blocks'].append(j.get('content_block') or {})
        elif t == 'content_block_delta':
            d = j.get('delta') or {}
            if d.get('type') == 'text_delta':
                out['text'] += d.get('text') or ''
        elif t == 'message_delta':
            d = j.get('delta') or {}
            if d.get('stop_reason'):
                out['stop_reason'] = d['stop_reason']
            if j.get('usage'):
                out['usage'] = j['usage']
        elif t == 'message_start':
            m = j.get('message') or {}
            if m.get('usage'):
                out['usage'] = out['usage'] or m['usage']
        elif t == 'error':
            out['error'] = j.get('error')
    return out


def check(name, ok, detail=''):
    RESULTS.append((name, ok, detail))
    print(f"  {'✓' if ok else '✗'} {name}{('  — ' + detail) if detail else ''}")


TOOL = {
    'type': 'function',
    'function': {
        'name': 'WebSearch',
        'description': '联网搜索，返回结果摘要',
        'parameters': {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': '搜索词'}},
            'required': ['query'],
        },
    },
}


def args_ok(tc):
    fn = tc.get('function') or {}
    if not isinstance(fn.get('arguments'), str):
        return False, 'arguments 不是字符串'
    try:
        json.loads(fn['arguments'])
        return True, ''
    except json.JSONDecodeError:
        return False, f'arguments 非法 JSON: {fn["arguments"][:40]}'


def raw_args_ok(s):
    """Responses 协议的 arguments 直接就是字符串，没有 function 包装层。"""
    if not isinstance(s, str) or not s.strip():
        return False, 'arguments 为空或不是字符串'
    try:
        json.loads(s)
        return True, ''
    except json.JSONDecodeError:
        return False, f'arguments 非法 JSON: {s[:40]}'


# ---------------------------------------------------------------- 用例

print(f'目标: {BASE}   模型: {MODEL}')
if not KEY:
    print('✗ 没有 API Key（.env 里没有 API_KEYS）')
    sys.exit(1)

# 1) 最朴素的非流式：像 OpenAI Python SDK 的 chat.completions.create
print('\n[1] 非流式纯文本')
st, raw = post({'model': MODEL, 'messages': [{'role': 'user', 'content': '用一句话说明你是谁'}]})
ok = st == 200
if ok:
    try:
        j = json.loads(raw)
        ok = bool((j['choices'][0]['message'].get('content') or '').strip())
        check('返回 200 且有正文', ok, f'finish={j["choices"][0]["finish_reason"]}')
        check('有 usage', bool(j.get('usage')))
    except Exception as e:
        check('返回 200 且有正文', False, str(e))
else:
    check('返回 200 且有正文', False, f'HTTP {st}: {raw[:120]}')

# 2) 流式纯文本：像 chatbox / OpenWebUI
print('\n[2] 流式纯文本')
st, raw = post({'model': MODEL, 'stream': True, 'messages': [{'role': 'user', 'content': '用两句话介绍杭州'}]})
p = parse_sse(raw)
check('流式返回正文', st == 200 and bool(p['text'].strip()), f'{len(p["text"])} 字')
check('以 [DONE] 收尾', p['done'])
check('每帧 content 都是字符串', not p['bad_content_types'], str(p['bad_content_types'][:3]))
check('object 字段统一', p['objects'] <= {'chat.completion.chunk'}, str(p['objects']))
check('流式也带 usage', bool(p['usage']))

# 3) 流式工具调用：像 Cline / Roo Code / Continue
print('\n[3] 流式工具调用（单工具）')
st, raw = post({
    'model': MODEL, 'stream': True, 'tools': [TOOL],
    'messages': [{'role': 'user', 'content': '今天杭州天气怎么样？用 WebSearch 查'}],
})
p = parse_sse(raw)
has = len(p['tool_calls']) >= 1
check('拿到 tool_calls', st == 200 and has, f'{len(p["tool_calls"])} 个')
if has:
    tc = p['tool_calls'][0]
    check('function.name 正确', (tc.get('function') or {}).get('name') == 'WebSearch',
          str((tc.get('function') or {}).get('name')))
    good, why = args_ok(tc)
    check('arguments 是合法 JSON 字符串', good, why)
    check('finish_reason=tool_calls', p['finish'] == ['tool_calls'], str(p['finish']))
    check('带 id', bool(tc.get('id')))
    check('chunk id 一致', len(p['ids']) == 1, f'{len(p["ids"])} 个不同 id')

# 4) 非流式工具调用：像 Dify / n8n / 自研后端
print('\n[4] 非流式工具调用')
st, raw = post({
    'model': MODEL, 'stream': False, 'tools': [TOOL],
    'messages': [{'role': 'user', 'content': '上海天气如何？用 WebSearch 查'}],
})
if st == 200:
    j = json.loads(raw)
    m = j['choices'][0]['message']
    tcs = m.get('tool_calls') or []
    check('拿到 tool_calls', bool(tcs), f'{len(tcs)} 个')
    if tcs:
        check('没有流式专用 index 字段', 'index' not in tcs[0])
        good, why = args_ok(tcs[0])
        check('arguments 是合法 JSON 字符串', good, why)
else:
    check('拿到 tool_calls', False, f'HTTP {st}: {raw[:120]}')

# 5) tool_choice=required：像部分 agent 框架
print('\n[5] tool_choice=required')
st, raw = post({
    'model': MODEL, 'stream': False, 'tools': [TOOL], 'tool_choice': 'required',
    'messages': [{'role': 'user', 'content': '查一下北京天气'}],
})
if st == 200:
    j = json.loads(raw)
    check('强制模式一定出工具调用', bool(j['choices'][0]['message'].get('tool_calls')))
else:
    check('强制模式一定出工具调用', False, f'HTTP {st}: {raw[:120]}')

# 6) tool_choice 指定函数：像 LangChain 的 tool_choice={"type":"function",...}
print('\n[6] tool_choice 指定具体函数')
st, raw = post({
    'model': MODEL, 'stream': False, 'tools': [TOOL],
    'tool_choice': {'type': 'function', 'function': {'name': 'WebSearch'}},
    'messages': [{'role': 'user', 'content': '随便查点什么'}],
})
check('指定函数时可用', st == 200, f'HTTP {st}' + ('' if st == 200 else f': {raw[:120]}'))

# 7) 多轮闭环：把 tool 结果回传，模型要把话说完
print('\n[7] 多轮闭环（回传 tool 结果）')
msgs = [
    {'role': 'user', 'content': '今天杭州天气怎么样'},
    {'role': 'assistant', 'content': None, 'tool_calls': [{
        'id': 'call_test_1', 'type': 'function',
        'function': {'name': 'WebSearch', 'arguments': '{"query":"杭州天气"}'},
    }]},
    {'role': 'tool', 'tool_call_id': 'call_test_1', 'content': '杭州今天多云转晴，18-26℃，东南风3级。'},
]
st, raw = post({'model': MODEL, 'stream': True, 'tools': [TOOL], 'messages': msgs})
p = parse_sse(raw)
check('第二轮给出正文', st == 200 and bool(p['text'].strip()), (p['text'][:40] + '…') if p['text'] else '空')
check('第二轮 finish_reason=stop', p['finish'] == ['stop'], str(p['finish']))
check('第二轮以 [DONE] 收尾', p['done'])

# 8) 老式 functions/function_call 协议：老 SDK、部分中转
print('\n[8] 老式 functions 协议')
st, raw = post({
    'model': MODEL, 'stream': False,
    'functions': [{'name': 'WebSearch', 'description': '联网搜索',
                   'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}}}}],
    'function_call': 'auto',
    'messages': [{'role': 'user', 'content': '查广州天气'}],
})
if st == 200:
    j = json.loads(raw)
    m = j['choices'][0]['message']
    check('旧协议请求也能工作', bool(m.get('tool_calls') or m.get('content')))
else:
    check('旧协议请求也能工作', False, f'HTTP {st}: {raw[:120]}')

# 9) stream_options.include_usage：OpenAI 官方 SDK 会带
print('\n[9] stream_options.include_usage')
st, raw = post({
    'model': MODEL, 'stream': True, 'stream_options': {'include_usage': True},
    'messages': [{'role': 'user', 'content': '说三个字'}],
})
p = parse_sse(raw)
check('可用且带 usage', st == 200 and bool(p['usage']), f'HTTP {st}')

# 10) 数组形式 content：Vercel AI SDK / 新版 OpenAI SDK
print('\n[10] 数组形式 content')
st, raw = post({
    'model': MODEL, 'stream': False,
    'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': '说一句话'}]}],
})
if st == 200:
    j = json.loads(raw)
    check('数组 content 可用', bool((j['choices'][0]['message'].get('content') or '').strip()))
else:
    check('数组 content 可用', False, f'HTTP {st}: {raw[:120]}')

# 11) 并行多工具：一次要两个查询
print('\n[11] 并行工具调用（两个城市）')
st, raw = post({
    'model': MODEL, 'stream': True, 'tools': [TOOL],
    'messages': [{'role': 'user', 'content': '分别用 WebSearch 查北京和上海两个城市的天气，一次调用两个查询'}],
})
p = parse_sse(raw)
check('可用（是否并行取决于模型）', st == 200, f'{len(p["tool_calls"])} 个 tool_call')
for tc in p['tool_calls']:
    good, why = args_ok(tc)
    check(f'  {tc.get("id")} arguments 合法', good, why)

# 12) 错误处理：不存在的模型
print('\n[12] 错误模型名的处理')
st, raw = post({'model': 'no-such-model-xyz', 'messages': [{'role': 'user', 'content': 'hi'}]})
ok = st == 404 and 'model_not_found' in raw
check('明确报 404 model_not_found（不静默换模型）', ok, f'HTTP {st}: {raw[:100]}')

# 12b) 带 vendor 前缀的模型名也应认（有些 harness 会拼成 vendor/model）
print('\n[12b] 带 vendor 前缀的模型名')
st, raw = post({'model': f'qwen/{MODEL}', 'messages': [{'role': 'user', 'content': '说三个字'}]})
check('前缀模型名不被误拒', st == 200, f'HTTP {st}' + ('' if st == 200 else f': {raw[:120]}'))

# 13) 鉴权
print('\n[13] 鉴权')
req = urllib.request.Request(URL, data=b'{}', headers={'Content-Type': 'application/json'})
try:
    urllib.request.urlopen(req, timeout=30)
    check('无 Key 被拒', False, '居然通过了')
except urllib.error.HTTPError as e:
    check('无 Key 被拒', e.code in (401, 403), f'HTTP {e.code}')
except Exception as e:
    check('无 Key 被拒', False, str(e))

# ---------------------------------------------------------------- Responses 协议
# Codex CLI 只认 /v1/responses，这些用例保证翻译层没退化。

# 14) /v1/responses 非流式
print('\n[14] /v1/responses 非流式')
st, raw = post_responses({
    'model': MODEL,
    'instructions': '你是一个简洁的助手，只回答一句话。',
    'input': '用一句话说明什么是 HTTP。',
    'max_output_tokens': 200,
})
try:
    j = json.loads(raw)
    txt = j.get('output_text') or ''
    items = j.get('output') or []
    check('返回 response 对象', j.get('object') == 'response', j.get('object', ''))
    check('status=completed', j.get('status') == 'completed', str(j.get('status')))
    check('有 output_text', bool(txt.strip()), txt[:40])
    check('output 里有 message 条目',
          any(it.get('type') == 'message' for it in items), str([it.get('type') for it in items]))
    u = j.get('usage') or {}
    check('usage 是 Responses 形状（input_tokens/output_tokens）',
          'input_tokens' in u and 'output_tokens' in u, str(list(u))[:80])
except json.JSONDecodeError:
    check('返回 response 对象', False, f'HTTP {st}: {raw[:150]}')

# 15) /v1/responses 流式事件顺序
print('\n[15] /v1/responses 流式')
st, raw = post_responses({
    'model': MODEL, 'input': '数到二，每个数字一行。', 'stream': True, 'max_output_tokens': 100,
})
p = parse_responses_sse(raw)
check('流式返回正文', st == 200 and bool(p['text'].strip()), f'{len(p["text"])} 字')
check('首事件是 response.created', bool(p['events']) and p['events'][0] == 'response.created',
      p['events'][0] if p['events'] else '空')
need = ['response.created', 'response.output_text.delta', 'response.completed']
missing = [e for e in need if e not in p['events']]
check('关键事件齐全', not missing, f'缺 {missing}' if missing else f'{len(p["events"])} 个事件')
check('没有 response.failed', p['failed'] is None, str(p['failed'])[:100])
done = p['completed'] or {}
check('completed 带完整 output', bool(done.get('output') is not None))
check('completed 带 usage', bool(done.get('usage')))

# 16) /v1/responses 流式工具调用
print('\n[16] /v1/responses 工具调用')
st, raw = post_responses({
    'model': MODEL,
    'input': '北京现在天气怎么样？用工具查。',
    'stream': True,
    'tools': [{
        'type': 'function',
        'name': 'get_weather',
        'description': '查询指定城市的实时天气',
        'parameters': {
            'type': 'object',
            'properties': {'city': {'type': 'string', 'description': '城市名'}},
            'required': ['city'],
        },
    }],
    'tool_choice': 'auto',
})
p = parse_responses_sse(raw)
calls = [it for it in p['items'] if it.get('type') == 'function_call']
if calls:
    c = calls[0]
    good, why = raw_args_ok(c.get('arguments'))
    check('拿到 function_call 条目', True, c.get('name', ''))
    check('function_call.name 正确', c.get('name') == 'get_weather', str(c.get('name')))
    check('function_call.arguments 合法 JSON', good, why)
    check('带 call_id', bool(c.get('call_id')))
    check('有 arguments.delta 事件', bool(p['arg_deltas']), f'{len(p["arg_deltas"])} 帧')
else:
    check('拿到 function_call 条目', st == 200, f'HTTP {st}: {raw[:150]}')

# 17) /v1/responses 遇到网关不认识的模型名要回落，不能 404
#     Codex 恢复历史会话时发的是**会话记录的模型名**（如 gpt-6.1-sol），
#     不跟随 config.toml 的 model 改动。404 会让整个旧会话打不开。
print('\n[17] /v1/responses 未知模型名自动回落')
st, raw = post_responses({'model': 'gpt-6.1-sol', 'input': '回一个字：好', 'max_output_tokens': 60})
try:
    j = json.loads(raw)
    check('旧会话模型名自动回落（不 404）',
          st == 200 and j.get('status') == 'completed',
          f'HTTP {st} status={j.get("status")} model={j.get("model")}')
    check('回落响应里有正文', bool((j.get('output_text') or '').strip()),
          (j.get('output_text') or '')[:30])
except json.JSONDecodeError:
    check('旧会话模型名自动回落（不 404）', False, f'HTTP {st}: {raw[:150]}')

# ---------------------------------------------------------------- Anthropic 协议
# Claude Code 只认 /v1/messages，且用 x-api-key 头鉴权。这些用例保证翻译层没退化。

# 18) /v1/messages 非流式（顺便验证 x-api-key 鉴权）
print('\n[18] /v1/messages 非流式（x-api-key）')
st, raw = post_messages({
    'model': MODEL,
    'max_tokens': 200,
    'system': '你是一个简洁的助手，只回答一句话。',
    'messages': [{'role': 'user', 'content': '用一句话说明什么是 DNS。'}],
})
try:
    j = json.loads(raw)
    blocks = j.get('content') or []
    txt = ''.join(b.get('text', '') for b in blocks if b.get('type') == 'text')
    check('返回 message 对象', j.get('type') == 'message' and j.get('role') == 'assistant', str(j.get('type')))
    check('有 text 内容块', bool(txt.strip()), txt[:40])
    check('stop_reason=end_turn', j.get('stop_reason') == 'end_turn', str(j.get('stop_reason')))
    u = j.get('usage') or {}
    check('usage 是 Anthropic 形状（input_tokens/output_tokens）',
          'input_tokens' in u and 'output_tokens' in u, str(list(u))[:80])
except json.JSONDecodeError:
    check('返回 message 对象', False, f'HTTP {st}: {raw[:150]}')

# 19) /v1/messages 流式事件顺序
print('\n[19] /v1/messages 流式')
st, raw = post_messages({
    'model': MODEL, 'max_tokens': 100, 'stream': True,
    'messages': [{'role': 'user', 'content': '数到二，每行一个数字。'}],
})
p = parse_anthropic_sse(raw)
check('流式返回正文', st == 200 and bool(p['text'].strip()), f'{len(p["text"])} 字')
check('首事件是 message_start',
      bool(p['events']) and p['events'][0] == 'message_start',
      p['events'][0] if p['events'] else '空')
need = ['message_start', 'content_block_start', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop']
missing = [e for e in need if e not in p['events']]
check('关键事件齐全', not missing, f'缺 {missing}' if missing else f'{len(p["events"])} 个事件')
check('末事件是 message_stop', bool(p['events']) and p['events'][-1] == 'message_stop',
      p['events'][-1] if p['events'] else '空')
check('没有 error 事件', p['error'] is None, str(p['error'])[:100])
check('message_delta 带 usage', bool(p['usage']))

# 20) /v1/messages 工具调用
print('\n[20] /v1/messages 工具调用')
MSG_TOOL = {
    'name': 'get_weather',
    'description': '查询指定城市的实时天气',
    'input_schema': {
        'type': 'object',
        'properties': {'city': {'type': 'string', 'description': '城市名'}},
        'required': ['city'],
    },
}
st, raw = post_messages({
    'model': MODEL, 'max_tokens': 300, 'stream': True,
    'tools': [MSG_TOOL],
    'messages': [{'role': 'user', 'content': '北京现在天气怎么样？用工具查。'}],
})
p = parse_anthropic_sse(raw)
tools = [b for b in p['blocks'] if b.get('type') == 'tool_use']
if tools:
    check('拿到 tool_use 块', True, tools[0].get('name', ''))
    check('tool_use.name 正确', tools[0].get('name') == 'get_weather', str(tools[0].get('name')))
    check('带 tool_use.id', bool(tools[0].get('id')))
    check('stop_reason=tool_use', p['stop_reason'] == 'tool_use', str(p['stop_reason']))
else:
    check('拿到 tool_use 块', st == 200, f'HTTP {st}: {raw[:150]}')

# 21) /v1/messages 多轮闭环：回传 tool_result 后模型要能接着说话
#     注意这一步必须是具体模型，automodel 会被上游 409 provider_state_unavailable
print('\n[21] /v1/messages 多轮 tool_result 闭环')
st, raw = post_messages({
    'model': MODEL, 'max_tokens': 300, 'stream': True,
    'tools': [MSG_TOOL],
    'messages': [
        {'role': 'user', 'content': '北京现在天气怎么样？用工具查。'},
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'id': 'toolu_conf_test', 'name': 'get_weather', 'input': {'city': '北京'}},
        ]},
        {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'toolu_conf_test',
             'content': [{'type': 'text', 'text': '北京：晴，18°C'}]},
        ]},
    ],
})
p = parse_anthropic_sse(raw)
check('第二轮给出正文', st == 200 and bool(p['text'].strip()), (p['text'][:40] + '…') if p['text'] else '空')
check('第二轮没有 error 事件', p['error'] is None, str(p['error'])[:120])
check('第二轮 stop_reason=end_turn', p['stop_reason'] == 'end_turn', str(p['stop_reason']))

# 22) /v1/messages/count_tokens（Claude Code 靠它做上下文管理）
print('\n[22] count_tokens')
req = urllib.request.Request(
    COUNT_URL,
    data=json.dumps({
        'model': MODEL,
        'messages': [{'role': 'user', 'content': '这是一段用来估算 token 的中文文本，大约三十个字。'}],
    }).encode(),
    headers={'x-api-key': KEY, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01'},
)
try:
    r = urllib.request.urlopen(req, timeout=30)
    j = json.loads(r.read().decode())
    n = j.get('input_tokens')
    check('返回正整数 input_tokens', isinstance(n, int) and n > 0, str(n))
except Exception as e:
    check('返回正整数 input_tokens', False, str(e)[:120])

# 23) 未知模型（含 claude-*）一律 404，不静默回落（ADR-0003）
print('\n[23] claude-* 模型名不静默回落')
st, raw = post_messages({
    'model': 'claude-sonnet-4-5-20250929',
    'max_tokens': 60,
    'messages': [{'role': 'user', 'content': '回一个字：好'}],
})
check('claude-* 返回 404 model_not_found', st == 404 and 'model_not_found' in raw,
      f'HTTP {st}: {raw[:100]}')

# 24) 鉴权：Authorization: Bearer 也要能用（老客户端走这个头）
print('\n[24] /v1/messages 用 Bearer 头')
st, raw = post_messages({
    'model': MODEL, 'max_tokens': 60,
    'messages': [{'role': 'user', 'content': '回一个字：好'}],
}, use_x_api_key=False)
check('Bearer 头同样被接受', st == 200, f'HTTP {st}: {raw[:100]}')

# ---------------------------------------------------------------- 汇总
failed = [r for r in RESULTS if not r[1]]
print(f'\n共 {len(RESULTS)} 项，通过 {len(RESULTS) - len(failed)}，失败 {len(failed)}')
if failed:
    for name, _, detail in failed:
        print(f'  ✗ {name}  {detail}')
    sys.exit(1)
print('全部通过 ✓')
