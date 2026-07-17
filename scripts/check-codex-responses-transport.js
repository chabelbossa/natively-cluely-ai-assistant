#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const clientPath = path.resolve(__dirname, '../dist-electron/electron/services/CodexResponsesClient.js');
const clientSourcePath = path.resolve(__dirname, '../electron/services/CodexResponsesClient.ts');
if (!fs.existsSync(clientPath) || fs.statSync(clientSourcePath).mtimeMs > fs.statSync(clientPath).mtimeMs) {
  const build = spawnSync('npm', ['run', 'build:electron'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    process.stderr.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    process.exit(build.status || 1);
  }
}
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
    assert.equal(requests[0].service_tier, 'priority');
    assert.equal(requests[0].model, 'gpt-5.6-terra');
    assert.deepEqual(client.getLastServiceTierStatus(), {
      requested: 'fast',
      used: 'fast',
      fallback: false,
      model: 'codex:gpt-5.6-terra',
      timestamp: client.getLastServiceTierStatus().timestamp,
    });

    requests.length = 0;
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return body.service_tier
        ? new Response('Priority processing unavailable: service_tier priority is not enabled', {
            status: 400,
            headers: { 'content-type': 'text/plain' },
          })
        : new Response(JSON.stringify({ output_text: 'STANDARD_OK' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    };

    assert.equal(
      await client.generateResponse({ ...params, stream: false }),
      'STANDARD_OK',
    );
    assert.equal(requests.length, 2, 'a Fast capability rejection must retry once in Standard mode');
    assert.equal(requests[0].service_tier, 'priority');
    assert.equal(requests[1].service_tier, undefined);
    assert.equal(client.getLastServiceTierStatus().used, 'standard');
    assert.equal(client.getLastServiceTierStatus().fallback, true);

    const assertStructuredFailure = async (status, body, expectedCode, expectedTier = 'priority') => {
      requests.length = 0;
      global.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(body, {
          status,
          headers: { 'content-type': 'text/plain' },
        });
      };
      const failingClient = new CodexResponsesClient(makeRouter());
      await assert.rejects(
        () => failingClient.generateResponse({ ...params, stream: false }),
        (error) => {
          assert.equal(error.code, expectedCode);
          assert.equal(error.status, status);
          assert.equal(error.model, 'codex:gpt-5.6-terra');
          assert.equal(error.serviceTier, expectedTier);
          return true;
        },
      );
    };

    requests.length = 0;
    let requestIndex = 0;
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      requestIndex += 1;
      return requestIndex === 1
        ? new Response('Priority processing unavailable: service_tier priority is not enabled', { status: 400 })
        : new Response('OAuth token expired', { status: 401 });
    };
    const standardFailureClient = new CodexResponsesClient(makeRouter());
    await assert.rejects(
      () => standardFailureClient.generateResponse({ ...params, stream: false }),
      (error) => {
        assert.equal(error.code, 'auth_failure');
        assert.equal(error.model, 'codex:gpt-5.6-terra');
        assert.equal(error.accountAlias, 'transport-test');
        assert.equal(error.serviceTier, 'standard');
        assert.equal(error.status, 401);
        return true;
      },
    );
    assert.equal(requests.length, 2);

    await assertStructuredFailure(429, 'rate limit exceeded', 'rate_limited');
    await assertStructuredFailure(503, 'server unavailable', 'server_unavailable');

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
    assert.equal(requests[0].service_tier, 'priority');

    requests.length = 0;
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const nonStreamingSse = await client.generateResponse({ ...params, stream: false });
    assert.equal(nonStreamingSse, 'Réponse unique.');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].service_tier, 'priority');

    let releaseFastRequest;
    const fastRequestGate = new Promise((resolve) => {
      releaseFastRequest = resolve;
    });
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.input?.[0]?.content || '';
      if (content === 'fast-request') {
        await fastRequestGate;
        return new Response(JSON.stringify({ output_text: 'FAST_OK' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body.service_tier) {
        return new Response('Priority processing unavailable: service_tier priority is not enabled', { status: 400 });
      }
      return new Response(JSON.stringify({ output_text: 'STANDARD_OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const trackedFast = client.runWithServiceTierTracking(async () => {
      await client.generateResponse({
        ...params,
        stream: false,
        input: [{ role: 'user', content: 'fast-request' }],
      });
      return client.getLastServiceTierStatus();
    });
    const trackedStandard = client.runWithServiceTierTracking(async () => {
      await client.generateResponse({
        ...params,
        stream: false,
        input: [{ role: 'user', content: 'standard-request' }],
      });
      return client.getLastServiceTierStatus();
    });
    const standardStatus = await trackedStandard;
    releaseFastRequest();
    const fastStatus = await trackedFast;
    assert.equal(fastStatus.used, 'fast');
    assert.equal(fastStatus.fallback, false);
    assert.equal(standardStatus.used, 'standard');
    assert.equal(standardStatus.fallback, true);
    assert.equal(
      client.runWithServiceTierTracking(() => client.getLastServiceTierStatus()),
      null,
      'a tracked local fallback must not inherit a previous Codex tier',
    );

    console.log('Codex Responses transport tests passed (8 scenarios).');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
