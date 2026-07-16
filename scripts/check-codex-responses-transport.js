#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');

const clientPath = path.resolve(__dirname, '../dist-electron/electron/services/CodexResponsesClient.js');
const { CodexResponsesClient } = require(clientPath);

const account = {
  alias: 'transport-test',
  accessToken: 'opaque-test-token',
  enabled: true,
};

const makeRouter = () => ({
  selectAccount: () => ({ account }),
  recordSuccess: () => {},
  updateLimitsFromHeaders: () => {},
  recordRateLimit: () => ({ retry: false, message: 'rate limited' }),
  recordAuthFailure: () => ({ retry: false, message: 'auth failed' }),
  recordServerError: () => ({ retry: false, message: 'server failed' }),
});

const params = {
  model: 'codex:gpt-5.6-terra',
  input: [{ role: 'user', content: 'Réponds brièvement.' }],
  reasoning: { effort: 'medium' },
};

async function main() {
  const originalFetch = global.fetch;
  const requests = [];

  try {
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ output_text: 'OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = new CodexResponsesClient(makeRouter());
    assert.equal(await client.generateResponse({ ...params, stream: false }), 'OK');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].service_tier, 'fast');
    assert.equal(requests[0].model, 'gpt-5.6-terra');

    requests.length = 0;
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response('Fast mode unavailable', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      });
    };

    await assert.rejects(
      () => client.generateResponse({ ...params, stream: false }),
      /Codex API error 400: Fast mode unavailable/,
    );
    assert.equal(requests.length, 1, 'a Fast rejection must never retry without service_tier');
    assert.equal(requests[0].service_tier, 'fast');

    requests.length = 0;
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"Réponse "}',
      '',
      'data: {"type":"response.output_text.delta","delta":"unique."}',
      '',
      'data: {"type":"response.output_text.done","text":"Réponse unique."}',
      '',
      'data: {"type":"response.completed","response":{"output":[{"content":[{"text":"Réponse unique."}]}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    let streamed = '';
    for await (const token of client.streamResponse(params)) {
      streamed += token;
    }
    assert.equal(streamed, 'Réponse unique.');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].service_tier, 'fast');

    console.log('Codex Responses transport tests passed (3 scenarios).');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
