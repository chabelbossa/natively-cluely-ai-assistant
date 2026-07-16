#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync, spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const requirePostInstall = process.argv.includes('--require-post-install');
const sinceInstallOnly = requirePostInstall || process.argv.includes('--since-install');
const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(process.env.HOME || '', 'Library/Application Support/natively/natively.db');
const installFilePath = process.argv.includes('--install-file')
  ? process.argv[process.argv.indexOf('--install-file') + 1]
  : '/Applications/Natively.app/Contents/Resources/app.asar';

const builderModulePath = path.join(root, 'dist-electron/electron/meeting/MeetingContextPacketBuilder.js');
const sourceModulePath = path.join(root, 'electron/meeting/MeetingContextPacketBuilder.ts');
const runnerIsStale =
  !fs.existsSync(builderModulePath) ||
  fs.statSync(builderModulePath).mtimeMs < fs.statSync(sourceModulePath).mtimeMs;

if (runnerIsStale) {
  console.log('[db-repair-check] dist-electron missing or stale; building Electron sources first...');
  const build = spawnSync('npm', ['run', 'build:electron'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          return path.join(root, '.tmp-electron-node', name);
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { MeetingContextPacketBuilder } = require(builderModulePath);

function queryJson(sql) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const output = execFileSync(
        'sqlite3',
        ['-cmd', '.timeout 5000', '-json', `${pathToFileURL(dbPath).href}?mode=ro`, sql],
        { encoding: 'utf8' },
      ).trim();
      return output ? JSON.parse(output) : [];
    } catch (error) {
      lastError = error;
      const detail = `${error?.message || ''}\n${error?.stderr || ''}`;
      if (!/unable to open database|database is (?:locked|busy)/i.test(detail) || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
    }
  }
  throw lastError;
}

function getInstallTimestampMs() {
  if (!sinceInstallOnly) return null;
  if (!fs.existsSync(installFilePath)) {
    throw new Error(`Install file not found: ${installFilePath}`);
  }
  return Math.floor(fs.statSync(installFilePath).mtimeMs);
}

function makeFakeSession(selectedSegments) {
  const items = selectedSegments.map((segment) => ({
    role: segment.role,
    speaker: segment.speaker,
    text: segment.text,
    timestamp: segment.timestamp || Date.now(),
    canonicalRole: segment.canonicalRole,
    qualityFlags: segment.qualityFlags || [],
    confidence: segment.confidence,
  }));

  return {
    getActionContext() {
      return items;
    },
    getActionContextDiagnostics() {
      return [
        'db_repair_check=true',
        `db_repair_check_items=${items.length}`,
      ];
    },
    getFullTranscript() {
      return items.map((item) => ({ ...item, final: true }));
    },
    getLastInterimInterviewer() {
      return null;
    },
  };
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferAction(row, metadata) {
  if (metadata.action) return metadata.action;
  if (row.type === 'followup_questions') return 'FOLLOW_UP_QUESTION';
  if (row.type === 'chat') return 'ANSWER';
  return 'WHAT_TO_SAY';
}

function evaluateRow(row) {
  const metadata = JSON.parse(row.metadata_json || '{}');
  const selectedSegments = Array.isArray(metadata.selectedSegments)
    ? metadata.selectedSegments
    : [];
  if (selectedSegments.length === 0) return null;

  const action = inferAction(row, metadata);
  const builder = new MeetingContextPacketBuilder(makeFakeSession(selectedSegments));
  const packet = builder.build({
    action,
    lastSeconds: 180,
    activeModeBlock: '',
    liveStateBlock: '',
  });

  const oldTarget = metadata.actionTarget?.text || metadata.interlocutorFocus?.text || '';
  const newTarget = packet.actionTarget?.text || '';
  const oldNorm = normalize(oldTarget);
  const newNorm = normalize(newTarget);
  const noisyWaChapTarget =
    oldNorm.includes('normalement when') &&
    oldNorm.includes('conserver android');
  const repairBlockPresent = packet.context.includes('[TRANSCRIPT REPAIR]');

  const failures = [];
  if (!repairBlockPresent) {
    failures.push('missing_transcript_repair_block');
  }

  if (noisyWaChapTarget) {
    if (!newNorm.includes('pourquoi tu veux conserver android')) {
      failures.push('wachap_question_not_recovered');
    }
    if (newNorm.includes('normalement when') || newNorm.includes('you copy android')) {
      failures.push('wachap_noisy_prefix_still_in_target');
    }
  }

  return {
    id: row.id,
    meeting_id: row.meeting_id,
    type: row.type,
    action,
    oldTarget: oldTarget.slice(0, 220),
    newTarget,
    repairChanged: packet.diagnostics.some((line) => line === 'packet_transcript_repair_changed=true'),
    noisyWaChapTarget,
    failures,
  };
}

const installTimestampMs = getInstallTimestampMs();
const postInstallMeetings = installTimestampMs === null
  ? []
  : queryJson(`
      select id, title, start_time, duration_ms
      from meetings
      where start_time > ${installTimestampMs}
      order by start_time desc
    `);
const rows = queryJson(`
  select
    ai.id,
    ai.meeting_id,
    ai.type,
    json_object(
      'action', json_extract(ai.metadata_json, '$.action'),
      'selectedSegments', json_extract(ai.metadata_json, '$.selectedSegments'),
      'actionTarget', json_extract(ai.metadata_json, '$.actionTarget'),
      'interlocutorFocus', json_extract(ai.metadata_json, '$.interlocutorFocus')
    ) as metadata_json
  from ai_interactions ai
  ${sinceInstallOnly ? 'join meetings m on m.id = ai.meeting_id' : ''}
  where ai.metadata_json is not null and ai.metadata_json != ''
  ${sinceInstallOnly && installTimestampMs !== null ? `and m.start_time > ${installTimestampMs}` : ''}
  order by ai.id desc
  limit 80
`);

const evaluations = rows
  .map((row) => {
    try {
      return evaluateRow(row);
    } catch (error) {
      return {
        id: row.id,
        meeting_id: row.meeting_id,
        type: row.type,
        failures: [`exception:${error.message}`],
      };
    }
  })
  .filter(Boolean);

const failures = evaluations.filter((item) => item.failures.length > 0);
const noisyRepaired = evaluations.filter((item) => item.noisyWaChapTarget && item.failures.length === 0);
const completionFailures = [...failures];

if (requirePostInstall && postInstallMeetings.length === 0) {
  completionFailures.push({
    id: null,
    meeting_id: null,
    type: 'post_install_live_validation',
    failures: ['no_post_install_meeting_found'],
  });
}

if (requirePostInstall && postInstallMeetings.length > 0 && evaluations.length === 0) {
  completionFailures.push({
    id: null,
    meeting_id: postInstallMeetings[0].id,
    type: 'post_install_live_validation',
    failures: ['post_install_meeting_has_no_action_metadata'],
  });
}

console.log(JSON.stringify({
  dbPath,
  installFilePath: sinceInstallOnly ? installFilePath : undefined,
  installTimestampMs,
  postInstallMeetings: postInstallMeetings.map((meeting) => ({
    id: meeting.id,
    title: meeting.title,
    startTime: meeting.start_time,
    durationMs: meeting.duration_ms,
  })),
  requirePostInstall,
  sinceInstallOnly,
  checked: evaluations.length,
  noisyWaChapTargets: evaluations.filter((item) => item.noisyWaChapTarget).length,
  noisyWaChapRepaired: noisyRepaired.length,
  failures: completionFailures,
  repairedExamples: noisyRepaired.map((item) => ({
    id: item.id,
    type: item.type,
    oldTarget: item.oldTarget,
    newTarget: item.newTarget,
  })),
}, null, 2));

process.exit(completionFailures.length === 0 ? 0 : 1);
