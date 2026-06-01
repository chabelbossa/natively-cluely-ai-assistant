#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureArg = process.argv.slice(2).find(arg => arg !== '--');

if (!fixtureArg) {
  console.error('Usage: node scripts/replay-meeting.js <fixture.json>');
  process.exit(2);
}

const fixturePath = path.resolve(root, fixtureArg);
const runnerPath = path.join(root, 'dist-electron/electron/replay/ReplayRunner.js');
const sourcePaths = [
  path.join(root, 'electron/replay/ReplayRunner.ts'),
  path.join(root, 'electron/transcript/TranscriptRouter.ts'),
  path.join(root, 'electron/transcript/types.ts'),
];

const fs = require('fs');
const runnerIsStale =
  !fs.existsSync(runnerPath) ||
  sourcePaths.some((sourcePath) =>
    fs.existsSync(sourcePath) &&
    fs.statSync(runnerPath).mtimeMs < fs.statSync(sourcePath).mtimeMs
  );

if (runnerIsStale) {
  console.log('[replay] dist-electron missing or stale; building Electron sources first...');
  const build = spawnSync('npm', ['run', 'build:electron'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

const { loadReplayFixture, runReplayFixture } = require(runnerPath);
const report = runReplayFixture(loadReplayFixture(fixturePath));

const compact = {
  name: report.name,
  passed: report.passed,
  totalEvents: report.totalEvents,
  canonicalSegments: report.canonicalSegments,
  suppressedSegments: report.suppressedSegments,
  finalInterlocutorSegments: report.finalInterlocutorSegments,
  distinctInterlocutorSpeakers: report.distinctInterlocutorSpeakers,
  falseMeCount: report.falseMeCount,
  falseMeRate: Number(report.falseMeRate.toFixed(3)),
  roleMismatchCount: report.roleMismatchCount,
  textMismatchCount: report.textMismatchCount,
  duplicateCount: report.duplicateCount,
  duplicateRate: Number(report.duplicateRate.toFixed(3)),
  suppressedExpectedMe: report.suppressedExpectedMe,
  unsuppressedExpectedSuppressed: report.unsuppressedExpectedSuppressed,
  failures: report.failures,
};

console.log(JSON.stringify(compact, null, 2));
process.exit(report.passed ? 0 : 1);
