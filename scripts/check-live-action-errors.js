#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const compiledRoot = path.join(repoRoot, 'dist-electron/electron/llm');
const sourcePath = path.join(repoRoot, 'electron/llm/LiveLlmError.ts');
const compiledMarker = path.join(compiledRoot, 'LiveLlmError.js');

if (!fs.existsSync(compiledMarker) || fs.statSync(sourcePath).mtimeMs > fs.statSync(compiledMarker).mtimeMs) {
  const build = spawnSync('npm', ['run', 'build:electron'], { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) {
    process.stderr.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    process.exit(build.status || 1);
  }
}

async function consume(generator) {
  for await (const _chunk of generator) {
    // Consume the generator to surface the structured transport error.
  }
}

async function main() {
  const cases = [
    ['WhatToAnswerLLM', 'WhatToAnswerLLM.js', instance => instance.generateStream('question')],
    ['ClarifyLLM', 'ClarifyLLM.js', instance => instance.generateStream('context')],
    ['RecapLLM', 'RecapLLM.js', instance => instance.generateStream('context')],
    ['FollowUpLLM', 'FollowUpLLM.js', instance => instance.generateStream('answer', 'shorten', 'context')],
    ['FollowUpQuestionsLLM', 'FollowUpQuestionsLLM.js', instance => instance.generateStream('context')],
    ['CodeHintLLM', 'CodeHintLLM.js', instance => instance.generateStream(undefined, 'question')],
    ['BrainstormLLM', 'BrainstormLLM.js', instance => instance.generateStream('context')],
  ];

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const errorCode of ['fast_unavailable', 'request_failed']) {
      const operationalError = new Error(
        errorCode === 'fast_unavailable'
          ? 'Codex Fast is unavailable for GPT-5.6 Terra.'
          : 'GPT-5.6 model or reasoning mode is unavailable for this account.',
      );
      operationalError.code = errorCode;
      const fakeHelper = {
        streamChat: async function* () {
          throw operationalError;
        },
      };

      for (const [className, fileName, createGenerator] of cases) {
        const Constructor = require(path.join(compiledRoot, fileName))[className];
        const instance = new Constructor(fakeHelper);
        await assert.rejects(() => consume(createGenerator(instance)), error => error === operationalError);
      }
    }
  } finally {
    console.error = originalConsoleError;
  }

  console.log(`Live action Codex error propagation passed (${cases.length} wrappers × 2 error classes).`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
