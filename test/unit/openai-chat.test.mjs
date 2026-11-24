// Unit tests for the OpenAI-compatible remote chat client
// (src/main/openai-chat.ts), including the tools-unsupported fallback.
// Run: npm run build && npm run test:unit
// All code, comments, log messages and docs in this project are English only.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  mergeSseDeltas,
  openAiChatStream,
  parseOpenAiSseText,
  parseSseDataLine,
} from '../../dist/main/openai-chat.js';

test('parseSseDataLine: content, tool-call deltas, [DONE], and junk', () => {
  assert.deepEqual(
    parseSseDataLine('data: {"choices":[{"delta":{"content":"Hello"}}]}'),
    { content: 'Hello' },
  );
  assert.deepEqual(
    parseSseDataLine(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"email_search","arguments":"{\\"q"}}]}}]}',
    ),
    { toolCallIndex: 0, toolCallId: 'call_1', toolCallName: 'email_search', toolCallArgs: '{"q' },
  );
  assert.equal(parseSseDataLine('data: [DONE]'), null);
  assert.equal(parseSseDataLine(': keep-alive'), null);
  assert.equal(parseSseDataLine('not sse at all'), null);
  assert.equal(parseSseDataLine('data: {broken json'), null);
});

test('mergeSseDeltas: reassembles chunked tool-call arguments in order', () => {
  const out = mergeSseDeltas([
    { content: 'Checking ' },
    { content: 'mail. ' },
    { toolCallIndex: 1, toolCallId: 'call_b', toolCallName: 'email_read', toolCallArgs: '{"uid":' },
    { toolCallIndex: 0, toolCallId: 'call_a', toolCallName: 'email_search', toolCallArgs: '{"query":"sw' },
    { toolCallIndex: 0, toolCallArgs: 'im"}' },
    { toolCallIndex: 1, toolCallArgs: '42}' },
  ]);
  assert.equal(out.content, 'Checking mail. ');
  assert.equal(out.toolCalls.length, 2);
  assert.equal(out.toolCalls[0].function.name, 'email_search');
  assert.deepEqual(out.toolCalls[0].function.arguments, { query: 'swim' });
  assert.equal(out.toolCalls[1].function.name, 'email_read');
  assert.deepEqual(out.toolCalls[1].function.arguments, { uid: 42 });
});

test('parseOpenAiSseText: parses a full SSE transcript', () => {
  const text = [
    'data: {"choices":[{"delta":{"content":"I will "}}]}',
    'data: {"choices":[{"delta":{"content":"search."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"email_search","arguments":"{\\"query\\":\\"swim\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n');
  const out = parseOpenAiSseText(text);
  assert.equal(out.content, 'I will search.');
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0].function.arguments, { query: 'swim' });
});

/** Spin up a stub OpenAI-compatible server. `handler` sees each request. */
function startStub(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

const MESSAGES = [
  { role: 'user', content: 'Search my mail for swim schedules.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'email_search', arguments: { query: 'swim' } } }],
  },
  { role: 'tool', content: '{"ok":true,"count":2}' },
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'email_search',
      description: 'Search email.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

test('openAiChatStream: SSE tool-call flow, with tool_call_id mapping', async () => {
  const seen = [];
  const { server, baseUrl } = await startStub((req, res, body) => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      [
        'data: {"choices":[{"delta":{"content":"Found "}}]}',
        'data: {"choices":[{"delta":{"content":"two messages."}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"email_search","arguments":"{\\"query\\":\\"swim\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        '',
      ].join('\n'),
    );
  });
  try {
    const tokens = [];
    const out = await openAiChatStream({
      baseUrl,
      apiKey: 'sk-stub',
      model: 'stub-model',
      messages: MESSAGES,
      tools: TOOLS,
      onToken: (t) => tokens.push(t),
    });
    assert.equal(out.content, 'Found two messages.');
    assert.equal(out.toolsUnsupported, false);
    assert.equal(out.toolCalls.length, 1);
    assert.deepEqual(out.toolCalls[0].function.arguments, { query: 'swim' });
    assert.deepEqual(tokens, ['Found ', 'two messages.']);

    // The request carried the conversation with matching tool_call_ids.
    const sent = seen[0].messages;
    assert.equal(sent[1].tool_calls[0].id, 'call_1');
    assert.equal(sent[2].role, 'tool');
    assert.equal(sent[2].tool_call_id, 'call_1');
    assert.equal(seen[0].model, 'stub-model');
    assert.ok(Array.isArray(seen[0].tools));
  } finally {
    server.close();
  }
});

test('openAiChatStream: endpoint rejecting tools falls back without them', async () => {
  const seen = [];
  const { server, baseUrl } = await startStub((req, res, body) => {
    const parsed = JSON.parse(body);
    seen.push(parsed);
    if (parsed.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model does not support tools or function calling.', code: 'unsupported' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"I cannot use tools, but here is the answer."}}]}\ndata: [DONE]\n\n');
  });
  try {
    const out = await openAiChatStream({
      baseUrl,
      apiKey: 'sk-stub',
      model: 'stub-model',
      messages: [{ role: 'user', content: 'Hi.' }],
      tools: TOOLS,
    });
    assert.equal(out.toolsUnsupported, true);
    assert.equal(out.toolCalls.length, 0);
    assert.match(out.content, /cannot use tools/);
    assert.equal(seen.length, 2);
    assert.ok('tools' in seen[0]);
    assert.ok(!('tools' in seen[1]));
  } finally {
    server.close();
  }
});

test('openAiChatStream: non-streaming JSON response is parsed', async () => {
  const { server, baseUrl } = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Plain JSON answer.' }, finish_reason: 'stop' }],
      }),
    );
  });
  try {
    const out = await openAiChatStream({
      baseUrl,
      apiKey: 'sk-stub',
      model: 'stub-model',
      messages: [{ role: 'user', content: 'Hi.' }],
    });
    assert.equal(out.content, 'Plain JSON answer.');
    assert.equal(out.toolsUnsupported, false);
  } finally {
    server.close();
  }
});

test('openAiChatStream: auth failure throws with the status', async () => {
  const { server, baseUrl } = await startStub((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }));
  });
  try {
    await assert.rejects(
      () =>
        openAiChatStream({
          baseUrl,
          apiKey: 'sk-wrong',
          model: 'stub-model',
          messages: [{ role: 'user', content: 'Hi.' }],
        }),
      /401/,
    );
  } finally {
    server.close();
  }
});
