// 助手的工具调用（ai/tool-call.js）：openai / anthropic / gemini 三种格式的请求、响应解析和多轮回放，不支持工具调用时的判断，
// 再用真实模式（INKDOVE_LLM_MOCK=0）对着本地假服务器把整个提问走一遍，看 llm_calls 的记法。不发真实的模型请求。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { LlmError } from '../src/ai/llm.js';
import { chatWithTools, probeToolSupport, toGeminiSchema, ToolsUnsupportedError, TOOLS_UNSUPPORTED_MESSAGE } from '../src/ai/tool-call.js';
import { startApp, waitFor } from './helpers.js';

const KEY = 'fake-key-for-tests';

/** 本地假 LLM 服务：记录请求，按 handler 回复 */
async function startFakeLlm() {
  const state = { requests: [], handler: null };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const rec = { method: req.method, path: req.url, headers: req.headers, body };
    state.requests.push(rec);
    const [status, data] = await state.handler(rec);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    last: () => state.requests.at(-1),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

const TOOLS = [
  {
    name: 'get_overview',
    description: '查概况数字。参数 start_date、group_by；返回 totals。',
    parameters: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        group_by: { type: 'string', enum: ['none', 'account'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['start_date'],
    },
  },
  { name: 'list_accounts', description: '列出号码和状态。没有参数；返回 items。', parameters: { type: 'object', properties: {} } },
];

const base = { apiKey: KEY, model: 'm-1', system: '系统提示', tools: TOOLS, timeoutMs: 5000, retryBaseMs: 5 };
const question = [{ role: 'user', text: '今天怎么样' }];

/** 第二轮的中立消息：问题、上一步的工具调用（带 raw）、工具结果（一个成功一个出错） */
function secondRound(first) {
  return [
    ...question,
    { role: 'assistant', text: first.text, toolCalls: first.toolCalls, raw: first.raw },
    {
      role: 'tool',
      results: [
        { id: first.toolCalls[0].id, name: first.toolCalls[0].name, content: '{"totals":{"newCustomers":3}}', isError: false, idFromModel: first.toolCalls[0].idFromModel },
        { id: first.toolCalls[1].id, name: first.toolCalls[1].name, content: '参数不对', isError: true, idFromModel: first.toolCalls[1].idFromModel },
      ],
    },
  ];
}

describe('工具调用：三种接口格式', () => {
  let f;
  before(async () => {
    f = await startFakeLlm();
  });
  after(() => f.close());

  it('openai：tools 是 function 定义；arguments 是 JSON 字符串；回放时 content 为 null、每个结果一条 role:tool', async () => {
    f.state.handler = () => [
      200,
      {
        model: 'gpt-x',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: '先查概况',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'get_overview', arguments: '{"start_date":"2026-10-14"}' } },
                { id: 'call_b', type: 'function', function: { name: 'list_accounts', arguments: '{not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      },
    ];
    const r = await chatWithTools({ ...base, format: 'openai', baseUrl: `${f.url}/v1`, messages: question });
    const req = f.last();
    assert.equal(req.path, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.body.tool_choice, 'auto');
    assert.equal(req.body.max_tokens, undefined);
    assert.deepEqual(req.body.tools[0], { type: 'function', function: { name: 'get_overview', description: TOOLS[0].description, parameters: TOOLS[0].parameters } });
    assert.deepEqual(req.body.tools[1].function.parameters, { type: 'object', properties: {} });
    assert.deepEqual(req.body.messages, [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '今天怎么样' },
    ]);
    assert.equal(r.text, '');
    assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 30 });
    assert.deepEqual(r.toolCalls[0], { id: 'call_a', name: 'get_overview', args: { start_date: '2026-10-14' }, rawArgs: '{"start_date":"2026-10-14"}', idFromModel: true });
    assert.equal(r.toolCalls[1].argsError, '参数不是合法的 JSON 对象');

    f.state.handler = () => [200, { choices: [{ message: { role: 'assistant', content: '今天有 3 个新客户' } }] }];
    const r2 = await chatWithTools({ ...base, format: 'openai', baseUrl: `${f.url}/v1`, messages: secondRound(r), toolChoice: 'none' });
    assert.equal(r2.text, '今天有 3 个新客户');
    assert.deepEqual(r2.toolCalls, []);
    const body = f.last().body;
    assert.equal(body.tool_choice, 'none');
    assert.deepEqual(body.messages.slice(2), [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'get_overview', arguments: '{"start_date":"2026-10-14"}' } },
          { id: 'call_b', type: 'function', function: { name: 'list_accounts', arguments: '{not json' } },
        ],
        reasoning_content: '先查概况',
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"totals":{"newCustomers":3}}' },
      { role: 'tool', tool_call_id: 'call_b', content: '错误：参数不对' },
    ]);
  });

  it('anthropic：tools 用 input_schema；回放时助手 content 原样带回（含 thinking），结果全放在下一条 user 消息里', async () => {
    const blocks = [
      { type: 'thinking', thinking: '要查概况', signature: 'sig-thinking-1' },
      { type: 'text', text: '我查一下。' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_overview', input: { start_date: '2026-10-14' } },
      { type: 'tool_use', id: 'toolu_2', name: 'list_accounts', input: {} },
    ];
    f.state.handler = () => [200, { model: 'claude-x', content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 20 } }];
    const r = await chatWithTools({ ...base, format: 'anthropic', baseUrl: f.url, messages: question });
    const req = f.last();
    assert.equal(req.path, '/v1/messages');
    assert.equal(req.headers['x-api-key'], KEY);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.body.system, '系统提示');
    assert.equal(req.body.max_tokens, 4096);
    assert.deepEqual(req.body.tool_choice, { type: 'auto' });
    assert.deepEqual(req.body.tools, [
      { name: 'get_overview', description: TOOLS[0].description, input_schema: TOOLS[0].parameters },
      { name: 'list_accounts', description: TOOLS[1].description, input_schema: { type: 'object', properties: {} } },
    ]);
    assert.equal(r.text, '我查一下。');
    assert.deepEqual(
      r.toolCalls.map((c) => [c.id, c.name, c.args]),
      [
        ['toolu_1', 'get_overview', { start_date: '2026-10-14' }],
        ['toolu_2', 'list_accounts', {}],
      ],
    );
    assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 20 });

    f.state.handler = () => [200, { content: [{ type: 'text', text: '今天有 3 个新客户' }], stop_reason: 'end_turn' }];
    const r2 = await chatWithTools({ ...base, format: 'anthropic', baseUrl: f.url, messages: secondRound(r), toolChoice: 'none' });
    assert.equal(r2.text, '今天有 3 个新客户');
    const body = f.last().body;
    // 历史里有 tool_use，所以要它直接回答时也带着 tools，只把 tool_choice 设成 none
    assert.equal(body.tools.length, 2);
    assert.deepEqual(body.tool_choice, { type: 'none' });
    assert.deepEqual(body.messages, [
      { role: 'user', content: '今天怎么样' },
      { role: 'assistant', content: blocks },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"totals":{"newCustomers":3}}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '参数不对', is_error: true },
        ],
      },
    ]);
  });

  it('gemini：functionDeclarations 用大写类型、字符串枚举带 format:enum、没参数的不带 parameters；回放带 thoughtSignature、functionResponse 带 id', async () => {
    const parts = [
      { text: '想一想', thought: true },
      { functionCall: { id: 'fc-1', name: 'get_overview', args: { start_date: '2026-10-14' } }, thoughtSignature: 'sig-gemini-1' },
      { functionCall: { name: 'list_accounts', args: {} } },
    ];
    f.state.handler = () => [
      200,
      { modelVersion: 'gemini-x-001', candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12 } },
    ];
    const r = await chatWithTools({ ...base, format: 'gemini', baseUrl: f.url, model: 'gemini-x', messages: question });
    const req = f.last();
    assert.equal(req.path, '/v1beta/models/gemini-x:generateContent');
    assert.equal(req.headers['x-goog-api-key'], KEY);
    assert.deepEqual(req.body.systemInstruction, { parts: [{ text: '系统提示' }] });
    assert.deepEqual(req.body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    assert.equal(req.body.generationConfig.responseMimeType, undefined, '函数调用不能和 responseMimeType 一起用');
    assert.ok(req.body.generationConfig.maxOutputTokens >= 8192);
    assert.deepEqual(req.body.tools, [
      {
        functionDeclarations: [
          {
            name: 'get_overview',
            description: TOOLS[0].description,
            parameters: {
              type: 'OBJECT',
              properties: {
                start_date: { type: 'STRING', description: 'YYYY-MM-DD' },
                group_by: { type: 'STRING', enum: ['none', 'account'], format: 'enum' },
                limit: { type: 'INTEGER', minimum: 1, maximum: 20 },
              },
              required: ['start_date'],
            },
          },
          { name: 'list_accounts', description: TOOLS[1].description },
        ],
      },
    ]);
    assert.equal(r.text, '', '思考部分不算回答');
    assert.equal(r.model, 'gemini-x-001');
    assert.deepEqual(
      r.toolCalls.map((c) => [c.id, c.name, c.idFromModel]),
      [
        ['fc-1', 'get_overview', true],
        ['gemini_call_1', 'list_accounts', false],
      ],
    );
    assert.deepEqual(r.usage, { inputTokens: 80, outputTokens: 12 });

    f.state.handler = () => [200, { candidates: [{ content: { role: 'model', parts: [{ text: '今天有 3 个新客户' }] }, finishReason: 'STOP' }] }];
    const r2 = await chatWithTools({ ...base, format: 'gemini', baseUrl: f.url, model: 'gemini-x', messages: secondRound(r), toolChoice: 'none' });
    assert.equal(r2.text, '今天有 3 个新客户');
    const body = f.last().body;
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    assert.deepEqual(body.contents, [
      { role: 'user', parts: [{ text: '今天怎么样' }] },
      { role: 'model', parts },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc-1', name: 'get_overview', response: { output: '{"totals":{"newCustomers":3}}' } } },
          { functionResponse: { name: 'list_accounts', response: { error: '参数不对' } } },
        ],
      },
    ]);
  });

  it('gemini：生成的工具调用不对时报错，不当成回答', async () => {
    f.state.handler = () => [200, { candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }];
    await assert.rejects(chatWithTools({ ...base, format: 'gemini', baseUrl: f.url, messages: question }), (e) => e instanceof LlmError && /MALFORMED_FUNCTION_CALL/.test(e.message));
  });

  it('toGeminiSchema：只留认识的字段', () => {
    assert.deepEqual(toGeminiSchema({ type: 'array', items: { type: 'string' }, additionalProperties: false, default: [] }), { type: 'ARRAY', items: { type: 'STRING' } });
  });
});

describe('工具调用：不支持时的判断', () => {
  let f;
  before(async () => {
    f = await startFakeLlm();
  });
  after(() => f.close());

  it('接口 400 且提到 tools：抛 ToolsUnsupportedError，给用户的话固定', async () => {
    f.state.handler = () => [400, { error: { message: 'This model does not support tools' } }];
    await assert.rejects(chatWithTools({ ...base, format: 'openai', baseUrl: f.url, messages: question }), (e) => {
      assert.ok(e instanceof ToolsUnsupportedError);
      assert.equal(e.code, 'tools_unsupported');
      assert.equal(e.message, TOOLS_UNSUPPORTED_MESSAGE);
      assert.match(e.detail, /400/);
      assert.ok(!e.detail.includes(KEY));
      return true;
    });
  });

  it('401、429 即使提到 function 也照常报错，不算不支持', async () => {
    for (const status of [401, 429]) {
      f.state.handler = () => [status, { error: { message: 'function call quota' } }];
      await assert.rejects(chatWithTools({ ...base, format: 'anthropic', baseUrl: f.url, messages: question, retryBaseMs: 1 }), (e) => e instanceof LlmError && !(e instanceof ToolsUnsupportedError));
    }
  });

  it('中转丢了 tools、模型把调用写成文字：当不支持', async () => {
    for (const text of ['<tool_call>{"name":"get_overview"}</tool_call>', '好的，我来调用 get_overview(start_date="2026-10-14")', '{"tool_calls":[{"name":"list_accounts"}]}']) {
      f.state.handler = () => [200, { choices: [{ message: { role: 'assistant', content: text } }] }];
      await assert.rejects(chatWithTools({ ...base, format: 'openai', baseUrl: f.url, messages: question }), ToolsUnsupportedError, text);
    }
    // 普通回答照常
    f.state.handler = () => [200, { choices: [{ message: { role: 'assistant', content: '今天有 3 个新客户' } }] }];
    assert.equal((await chatWithTools({ ...base, format: 'openai', baseUrl: f.url, messages: question })).text, '今天有 3 个新客户');
  });

  it('probeToolSupport：只给一个没参数的 inkdove_ping，调了算支持，回文字算不支持', async () => {
    f.state.handler = () => [200, { content: [{ type: 'tool_use', id: 'toolu_p', name: 'inkdove_ping', input: {} }], usage: { input_tokens: 5, output_tokens: 3 } }];
    const ok = await probeToolSupport({ format: 'anthropic', baseUrl: f.url, apiKey: KEY, model: 'm-1', timeoutMs: 5000 });
    assert.equal(ok.supported, true);
    assert.deepEqual(
      f.last().body.tools.map((t) => t.name),
      ['inkdove_ping'],
    );
    assert.deepEqual(f.last().body.tools[0].input_schema, { type: 'object', properties: {} });
    f.state.handler = () => [200, { content: [{ type: 'text', text: '好的' }] }];
    const no = await probeToolSupport({ format: 'anthropic', baseUrl: f.url, apiKey: KEY, model: 'm-1', timeoutMs: 5000 });
    assert.equal(no.supported, false);
    f.state.handler = () => [400, { error: { message: 'tool use is not supported' } }];
    assert.equal((await probeToolSupport({ format: 'anthropic', baseUrl: f.url, apiKey: KEY, model: 'm-1', timeoutMs: 5000 })).supported, false);
    // 鉴权之类的错误照常抛出
    f.state.handler = () => [401, { error: { message: 'bad key' } }];
    await assert.rejects(probeToolSupport({ format: 'anthropic', baseUrl: f.url, apiKey: KEY, model: 'm-1', timeoutMs: 5000 }), LlmError);
  });
});

describe('助手：真实模式对着假服务器走完一次提问', () => {
  let f;
  let t;
  before(async () => {
    f = await startFakeLlm();
    t = await startApp({ env: { INKDOVE_LLM_MOCK: '0' } });
    await t.login();
    await t.createAccount({ name: '销售一号' });
  });
  after(async () => {
    await t.close();
    await f.close();
  });

  const setModel = (model) => t.req('PUT', '/api/settings', { body: { llm: { format: 'anthropic', baseUrl: f.url, apiKey: KEY, model } } });
  async function ask(q) {
    const r = await t.req('POST', '/api/assistant/ask', { body: { question: q, tz: 'Asia/Shanghai' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let m;
    await waitFor(
      async () => {
        m = (await t.req('GET', `/api/assistant/chats/${r.body.chat.id}/messages/${r.body.message.id}`)).body;
        return m.status !== 'running';
      },
      { timeout: 6000 },
    );
    return m;
  }
  const assistantCalls = () => t.ctx.db.prepare("SELECT * FROM llm_calls WHERE purpose = 'assistant' ORDER BY rowid").all();

  it('anthropic：先调 list_accounts，再按结果回答；每次模型调用记一条 assistant，带 token', async () => {
    await setModel('claude-x');
    f.state.requests.length = 0;
    f.state.handler = (rec) => {
      const lastMsg = rec.body.messages.at(-1);
      if (Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === 'tool_result') {
        return [200, { model: 'claude-x', content: [{ type: 'text', text: '现在有 1 个号：销售一号。' }], stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 15 } }];
      }
      return [200, { model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_9', name: 'list_accounts', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 200, output_tokens: 10 } }];
    };
    const m = await ask('我们有哪些号');
    assert.equal(m.status, 'done', JSON.stringify(m));
    assert.equal(m.answer, '现在有 1 个号：销售一号。');
    assert.equal(f.state.requests.length, 2);
    const second = f.state.requests[1].body;
    assert.match(second.system, /Asia\/Shanghai/);
    const result = second.messages.at(-1).content[0];
    assert.equal(result.tool_use_id, 'toolu_9');
    assert.match(result.content, /销售一号/);
    const rows = assistantCalls();
    assert.deepEqual(
      rows.map((r) => [r.format, r.model, r.input_tokens, r.output_tokens, r.ok, r.account_id, r.conversation_id]),
      [
        ['anthropic', 'claude-x', 200, 10, 1, null, null],
        ['anthropic', 'claude-x', 300, 15, 1, null, null],
      ],
    );
  });

  it('中转悄悄丢掉 tools、模型直接编答案：检查一次，没调工具就提示不支持；同一配置之后直接提示', async () => {
    await setModel('claude-silent');
    f.state.requests.length = 0;
    f.state.handler = () => [200, { model: 'claude-silent', content: [{ type: 'text', text: '今天有 99 个新客户' }], stop_reason: 'end_turn' }];
    const m = await ask('今天有多少新客户');
    assert.equal(m.status, 'failed');
    assert.equal(m.error, TOOLS_UNSUPPORTED_MESSAGE);
    assert.equal(m.answer, null);
    assert.equal(f.state.requests.length, 2, '一次提问加一次检查');
    assert.deepEqual(
      f.state.requests[1].body.tools.map((x) => x.name),
      ['inkdove_ping'],
    );
    const again = await ask('再问一次');
    assert.equal(again.error, TOOLS_UNSUPPORTED_MESSAGE);
    assert.equal(f.state.requests.length, 2, '已知不支持就不再请求');
  });

  it('接口直接拒绝 tools：同样的提示', async () => {
    await setModel('claude-notools');
    f.state.handler = () => [400, { error: { type: 'invalid_request_error', message: 'tools: not supported by this relay' } }];
    const m = await ask('我们有哪些号');
    assert.equal(m.status, 'failed');
    assert.equal(m.errorCode, 'tools_unsupported');
    assert.equal(m.error, TOOLS_UNSUPPORTED_MESSAGE);
  });

  it('其他接口错误照实说，不说成不支持', async () => {
    await setModel('claude-broken');
    f.state.handler = () => [401, { error: { message: 'invalid x-api-key' } }];
    const m = await ask('我们有哪些号');
    assert.equal(m.status, 'failed');
    assert.equal(m.errorCode, 'llm_error');
    assert.match(m.error, /模型调用失败.*401/);
    assert.ok(!m.error.includes(KEY));
  });
});
