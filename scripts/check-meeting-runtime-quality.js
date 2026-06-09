#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const userData = path.join(process.env.HOME || '', 'Library/Application Support/natively');
const defaultDebugDir = path.join(userData, 'meeting-debug');
const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(userData, 'natively.db');
const debugPath = process.argv.includes('--debug')
  ? process.argv[process.argv.indexOf('--debug') + 1]
  : findLatestJsonl(defaultDebugDir);

if (!debugPath) {
  fail('No meeting-debug JSONL file found.');
}

ensureElectronBuild();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          return path.join(root, '.tmp-electron-node', name);
        },
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { TranscriptRouter } = require(path.join(root, 'dist-electron/electron/transcript/TranscriptRouter.js'));
const { buildRAGPrompt } = require(path.join(root, 'dist-electron/electron/rag/prompts.js'));
const { IntelligenceEngine } = require(path.join(root, 'dist-electron/electron/IntelligenceEngine.js'));
const meetingChatOverlaySource = fs.readFileSync(path.join(root, 'src/components/MeetingChatOverlay.tsx'), 'utf8');

const events = readJsonl(debugPath);
const meetingStart = events.find(event => event.type === 'meeting_start');
const meetingEnd = [...events].reverse().find(event => event.type === 'meeting_end');
const meetingId = meetingEnd?.payload?.meetingId;
const manifestPath = meetingEnd?.payload?.audioDebugManifestPath;

const failures = [];
const warnings = [];

checkAudioManifest(manifestPath, failures, warnings);
checkRouterContract(events, failures);
checkRagContextAndPrompt(meetingId, failures, warnings);
checkManualFallback(meetingId, failures, warnings);
checkPromptEngineeringContract(failures);

const report = {
  debugPath,
  meetingId,
  startedAt: meetingStart?.payload?.metadata?.startedAt,
  endedAt: meetingEnd?.payload?.endedAt,
  audioDebugManifestPath: manifestPath,
  failures,
  warnings,
};

console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);

function ensureElectronBuild() {
  const requiredSources = [
    'electron/transcript/TranscriptRouter.ts',
    'electron/rag/prompts.ts',
    'electron/IntelligenceEngine.ts',
  ].map(file => path.join(root, file));
  const requiredOutputs = [
    'dist-electron/electron/transcript/TranscriptRouter.js',
    'dist-electron/electron/rag/prompts.js',
    'dist-electron/electron/IntelligenceEngine.js',
  ].map(file => path.join(root, file));

  const newestSource = Math.max(...requiredSources.map(file => fs.statSync(file).mtimeMs));
  const oldestOutput = requiredOutputs.every(file => fs.existsSync(file))
    ? Math.min(...requiredOutputs.map(file => fs.statSync(file).mtimeMs))
    : 0;

  if (oldestOutput >= newestSource) return;
  console.log('[meeting-runtime-quality] dist-electron missing or stale; building Electron sources first...');
  const build = spawnSync('npm', ['run', 'build:electron'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

function checkAudioManifest(manifestPath, failures, warnings) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    failures.push('audio_debug_manifest_missing');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const trackName of ['mic', 'system']) {
    const track = manifest.tracks?.[trackName];
    if (!track) {
      failures.push(`audio_track_missing:${trackName}`);
      continue;
    }
    if (!fs.existsSync(track.path)) failures.push(`audio_track_file_missing:${trackName}`);
    if (track.silent === true) failures.push(`audio_track_silent:${trackName}`);
    if (!track.bytes || track.bytes <= 0) failures.push(`audio_track_empty:${trackName}`);
    if (!track.durationMs || track.durationMs < 30_000) warnings.push(`audio_track_short:${trackName}:${track.durationMs || 0}`);
  }
}

function checkRouterContract(events, failures) {
  const router = new TranscriptRouter();
  let rawCount = 0;
  let micAccepted = 0;
  let systemAccepted = 0;
  const micRelabels = [];

  for (const event of events) {
    if (event.type !== 'raw_transcript') continue;
    const raw = event.payload;
    if (!raw?.text) continue;
    rawCount += 1;
    const routed = router.route(raw);
    if (!routed.segment) continue;
    if (raw.channel === 'mic') {
      micAccepted += 1;
      if (routed.segment.role !== 'me' || routed.segment.source !== 'mic') {
        micRelabels.push({
          timestamp: raw.timestamp,
          text: String(raw.text).slice(0, 160),
          role: routed.segment.role,
          source: routed.segment.source,
          flags: routed.segment.qualityFlags,
        });
      }
    }
    if (raw.channel === 'system') systemAccepted += 1;
  }

  if (rawCount === 0) failures.push('runtime_trace_has_no_raw_transcripts');
  if (systemAccepted === 0) failures.push('runtime_trace_has_no_accepted_system_transcripts');
  if (micAccepted === 0) failures.push('runtime_trace_has_no_accepted_mic_transcripts');
  if (micRelabels.length > 0) {
    failures.push(`mic_relabelled_as_interlocutor:${JSON.stringify(micRelabels.slice(0, 3))}`);
  }
}

function checkRagContextAndPrompt(meetingId, failures, warnings) {
  if (!meetingId || !fs.existsSync(dbPath)) {
    warnings.push('rag_check_skipped_no_meeting_or_db');
    return;
  }

  const meetingHasProcessusQuery = queryJson(`
    select 1
    from transcripts
    where meeting_id = '${escapeSql(meetingId)}'
      and (
        lower(content) like '%processus%'
        or lower(content) like '%hiérarchique%'
        or lower(content) like '%hierarchique%'
      )
    limit 1
  `);

  if (meetingHasProcessusQuery.length === 0) {
    warnings.push('rag_processus_check_skipped_not_in_meeting');
    return;
  }

  const rows = queryJson(`
    select chunk_index, speaker, cleaned_text
    from chunks
    where meeting_id = '${escapeSql(meetingId)}'
      and (
        lower(cleaned_text) like '%processus%'
        or lower(cleaned_text) like '%hiérarchique%'
        or lower(cleaned_text) like '%hierarchique%'
      )
    order by chunk_index
    limit 30
  `);

  if (rows.length === 0) {
    failures.push('rag_context_missing_processus_chunks');
    return;
  }

  const combined = rows.map(row => `[${row.speaker}] ${row.cleaned_text}`).join('\n');
  const normalized = normalize(combined);
  if (!normalized.includes('processus')) failures.push('rag_context_missing_processus_keyword');
  if (!normalized.includes('hierarchique') && !combined.toLowerCase().includes('hiérarchique')) {
    failures.push('rag_context_missing_hierarchique_keyword');
  }

  const prompt = buildRAGPrompt(
    "c'est quoi processus hierachique d'apres ce qui est dit ?",
    combined,
    'meeting',
    'concept_explanation'
  );
  const promptNorm = normalize(prompt);
  if (!promptNorm.includes('synthesize') && !promptNorm.includes('synthese')) {
    failures.push('rag_prompt_missing_synthesis_instruction');
  }
  if (!promptNorm.includes('me') || !promptNorm.includes('interlocutor')) {
    failures.push('rag_prompt_missing_speaker_contract');
  }
  if (!promptNorm.includes('answering method')) {
    failures.push('rag_prompt_missing_answering_method');
  }
  if (!promptNorm.includes('quality bar')) {
    failures.push('rag_prompt_missing_quality_bar');
  }
  if (!promptNorm.includes('read all nearby turns')) {
    failures.push('rag_prompt_missing_multi_turn_instruction');
  }
  if (!promptNorm.includes('do not stop at a copied line')) {
    failures.push('rag_prompt_allows_copied_line_answers');
  }
}

function checkManualFallback(meetingId, failures, warnings) {
  if (!meetingId || !fs.existsSync(dbPath)) {
    warnings.push('manual_fallback_check_skipped_no_meeting_or_db');
    return;
  }

  const rows = queryJson(`
    select user_query, metadata_json
    from ai_interactions
    where meeting_id = '${escapeSql(meetingId)}'
      and lower(user_query) like '%processus%'
    order by timestamp desc
    limit 1
  `);

  if (rows.length === 0) {
    warnings.push('manual_fallback_check_skipped_no_processus_interaction');
    return;
  }

  const row = rows[0];
  const packet = JSON.parse(row.metadata_json || '{}');
  const engine = Object.create(IntelligenceEngine.prototype);
  const fallback = engine.buildManualAnswerFallback(row.user_query, packet);
  const normalizedFallback = normalize(fallback);

  if (/avec le processus$/.test(normalizedFallback) || normalizedFallback.length < 120) {
    failures.push(`manual_fallback_still_fragmentary:${fallback}`);
  }
  if (!normalizedFallback.includes('plusieurs niveaux') && !normalizedFallback.includes('plusieurs niveau')) {
    failures.push(`manual_fallback_missing_hierarchical_explanation:${fallback}`);
  }
}

function checkPromptEngineeringContract(failures) {
  const engine = Object.create(IntelligenceEngine.prototype);
  const manualPrompt = engine.buildManualAnswerSystemPrompt("c'est quoi processus hierachique d'apres ce qui est dit ?");
  const manualNorm = normalize(manualPrompt);
  if (!manualNorm.includes('internal answering method')) {
    failures.push('manual_prompt_missing_internal_answering_method');
  }
  if (!manualNorm.includes('typed question as the query')) {
    failures.push('manual_prompt_does_not_prioritize_typed_question');
  }
  if (!manualNorm.includes('gather evidence across multiple nearby turns')) {
    failures.push('manual_prompt_missing_multi_turn_synthesis');
  }
  if (!manualNorm.includes('unless the user explicitly asks for a quote')) {
    failures.push('manual_prompt_allows_quote_like_answers');
  }

  const overlayNorm = normalize(meetingChatOverlaySource);
  if (!overlayNorm.includes('buildmeetingrecallsystemprompt')) {
    failures.push('overlay_missing_meeting_recall_prompt_helper');
  }
  if (!overlayNorm.includes('answering method') || !overlayNorm.includes('quality bar')) {
    failures.push('overlay_prompt_missing_answering_contract');
  }
  if (!overlayNorm.includes('synthesize across turns')) {
    failures.push('overlay_prompt_missing_synthesis_instruction');
  }
}

function queryJson(sql) {
  const output = execFileSync(
    'sqlite3',
    ['-readonly', '-cmd', '.timeout 5000', '-json', dbPath, sql],
    { encoding: 'utf8' },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: 'parse_error', index, error: error.message };
      }
    });
}

function findLatestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(file => file.endsWith('.jsonl'))
    .map(file => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
