#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const build = buildSync({
  entryPoints: [path.join(repoRoot, 'src/lib/liveActionMessages.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  write: false,
});
const compiled = build.outputFiles[0].text;
const virtualModule = new Module('live-action-messages-test', module);
virtualModule.filename = path.join(repoRoot, 'dist-test/liveActionMessages.js');
virtualModule.paths = module.paths;
virtualModule._compile(compiled, virtualModule.filename);

const {
  appendStreamingMessage,
  cancelActionMessage,
  finalizeStreamingMessage,
  upsertPendingActionMessage,
} = virtualModule.exports;

const queue = (messages, actionId, intent = 'what_to_answer') =>
  upsertPendingActionMessage(messages, actionId, intent, 'Preparing...');

let messages = queue([], 'action-1');
messages = finalizeStreamingMessage(messages, 'action-1', 'what_to_answer', 'Réponse finale.');
messages = finalizeStreamingMessage(messages, 'action-1', 'what_to_answer', 'Réponse finale.');
assert.equal(messages.length, 1, 'IPC result then final event must keep one card');

messages = finalizeStreamingMessage([], 'action-2', 'what_to_answer', 'Événement final.');
messages = finalizeStreamingMessage(messages, 'action-2', 'what_to_answer', 'Retour IPC final.');
assert.equal(messages.length, 1, 'final event then IPC result must keep one card');
assert.equal(messages[0].text, 'Événement final.', 'first terminal result must be immutable');

messages = queue([], 'action-3');
messages = finalizeStreamingMessage(messages, 'action-3', 'what_to_answer', 'Première formulation.');
messages = finalizeStreamingMessage(messages, 'action-3', 'what_to_answer', 'Formulation finale légèrement différente.');
assert.equal(messages.length, 1, 'same actionId must coalesce slightly different finals');
assert.equal(messages[0].text, 'Première formulation.', 'late same-status final must be ignored');

messages = queue([], 'action-4');
messages = appendStreamingMessage(messages, 'action-4', 'what_to_answer', 'Début');
messages = finalizeStreamingMessage(messages, 'action-4', 'what_to_answer', 'Début terminé.');
const afterLateToken = appendStreamingMessage(messages, 'action-4', 'what_to_answer', ' token tardif');
assert.equal(afterLateToken, messages, 'late token after terminal state must be ignored');

messages = queue([], 'action-5', 'recap');
messages = queue(messages, 'action-6', 'clarify');
messages = appendStreamingMessage(messages, 'action-6', 'clarify', 'Question ?');
messages = appendStreamingMessage(messages, 'action-5', 'recap', 'Résumé');
messages = finalizeStreamingMessage(messages, 'action-6', 'clarify', 'Question finale ?');
messages = finalizeStreamingMessage(messages, 'action-5', 'recap', 'Résumé final.');
assert.equal(messages.length, 2, 'interleaved intents must retain two cards');
assert.equal(messages.find(message => message.actionId === 'action-5').text, 'Résumé final.');
assert.equal(messages.find(message => message.actionId === 'action-6').text, 'Question finale ?');

messages = queue([], 'action-7', 'what_to_answer');
messages = queue(messages, 'action-8', 'what_to_answer');
messages = finalizeStreamingMessage(messages, 'action-8', 'what_to_answer', 'Nouvelle réponse.');
messages = cancelActionMessage(messages, 'action-7', 'what_to_answer');
messages = finalizeStreamingMessage(messages, 'action-7', 'what_to_answer', 'Ancien retour IPC tardif.');
assert.equal(messages.length, 2, 'two IDs with the same intent must never merge');
assert.equal(messages.find(message => message.actionId === 'action-7').actionStatus, 'cancelled');
assert.equal(messages.find(message => message.actionId === 'action-7').text, 'Cancelled.');
assert.equal(messages.find(message => message.actionId === 'action-8').actionStatus, 'completed');
assert.equal(messages.some(message => message.isStreaming), false);

messages = queue([], 'action-9');
messages = finalizeStreamingMessage(messages, 'action-9', 'what_to_answer', 'Réponse stable.');
messages = finalizeStreamingMessage(
  messages,
  'action-9',
  'what_to_answer',
  'Résultat tardif à ignorer.',
  { serviceTierUsed: 'standard', serviceTierFallback: true },
);
assert.equal(messages[0].text, 'Réponse stable.', 'terminal text must stay immutable while metadata is enriched');
assert.equal(messages[0].serviceTierUsed, 'standard');
assert.equal(messages[0].serviceTierFallback, true);

async function verifyPendingStreamCancellation() {
  const engineSource = path.join(repoRoot, 'electron/IntelligenceEngine.ts');
  const engineBuild = path.join(repoRoot, 'dist-electron/electron/IntelligenceEngine.js');
  if (!fs.existsSync(engineBuild) || fs.statSync(engineSource).mtimeMs > fs.statSync(engineBuild).mtimeMs) {
    const result = spawnSync('npm', ['run', 'build:electron'], { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      process.exit(result.status || 1);
    }
  }

  const { IntelligenceEngine } = require(engineBuild);
  const originalLog = console.log;
  console.log = () => {};
  let engine;
  try {
    engine = new IntelligenceEngine({}, { setRecapLLM() {} });
  } finally {
    console.log = originalLog;
  }

  engine.generationIds.what_to_say = 1;
  let resolveNext;
  let returnCalls = 0;
  const stream = {
    next: () => new Promise((resolve) => {
      resolveNext = resolve;
    }),
    return: async () => {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  const tokens = [];
  const pending = engine.consumeActionStream(
    'what_to_say',
    'WHAT_TO_SAY',
    stream,
    1,
    (token) => tokens.push(token),
  );
  await new Promise((resolve) => setImmediate(resolve));
  engine.generationIds.what_to_say = 2;
  resolveNext({ done: true, value: undefined });
  const result = await pending;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.aborted, true, 'a done signal resolving after invalidation must be treated as cancelled');
  assert.equal(result.timedOut, false);
  assert.deepEqual(tokens, [], 'no token from an invalidated generation may be accepted');
  assert.equal(returnCalls, 1, 'the invalidated generator must be closed');
}

verifyPendingStreamCancellation()
  .then(() => console.log('Live action idempotency tests passed (9 scenarios).'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
