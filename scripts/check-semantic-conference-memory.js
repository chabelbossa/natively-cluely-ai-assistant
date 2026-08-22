#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const sessionModulePath = path.join(root, 'dist-electron/electron/SessionTracker.js');
const recapModulePath = path.join(root, 'dist-electron/electron/llm/RecapLLM.js');
const builderModulePath = path.join(root, 'dist-electron/electron/meeting/MeetingContextPacketBuilder.js');
const sources = [
  path.join(root, 'electron/SessionTracker.ts'),
  path.join(root, 'electron/llm/RecapLLM.ts'),
  path.join(root, 'electron/meeting/ConferenceMemory.ts'),
  path.join(root, 'electron/meeting/MeetingContextPacketBuilder.ts'),
];
const compiledAt = [sessionModulePath, recapModulePath, builderModulePath]
  .filter((file) => fs.existsSync(file))
  .reduce((oldest, file) => Math.min(oldest, fs.statSync(file).mtimeMs), Number.POSITIVE_INFINITY);

if (!Number.isFinite(compiledAt) || sources.some((source) => fs.statSync(source).mtimeMs > compiledAt)) {
  console.log('[semantic-memory-guard] Electron build missing or stale; rebuilding...');
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

const { SessionTracker } = require(sessionModulePath);
const { RecapLLM } = require(recapModulePath);
const { MeetingContextPacketBuilder } = require(builderModulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function segment(index, text, timestamp) {
  return {
    speaker: `speaker_${(index % 3) + 1}`,
    canonicalRole: `speaker_${(index % 3) + 1}`,
    source: 'mic',
    qualityFlags: ['conference_floor', 'trusted_interlocutor'],
    confidence: 0.95,
    final: true,
    timestamp,
    text,
  };
}

async function verifyToolContract() {
  let capturedSystemPrompt = '';
  let capturedContext = '';
  const fakeHelper = {
    async generateMeetingSummary(systemPrompt, context) {
      capturedSystemPrompt = systemPrompt;
      capturedContext = context;
      return JSON.stringify({
        currentTopic: 'Stabilité du clustering',
        narrativeDigest: 'Le classement varie entre plusieurs exécutions du même algorithme.',
        openQuestions: [{
          text: 'Comment rendre le clustering stable entre les exécutions ?',
          evidenceSegmentIds: ['seg_000001'],
          status: 'open',
        }],
        activeProblems: [],
        decisions: [],
        keyFacts: [],
        constraints: [],
        uncertainties: [],
      });
    },
  };
  const recap = new RecapLLM(fakeHelper);
  const memory = await recap.compactConferenceMemory({
    previousMemory: null,
    newSegments: [{
      id: 'seg_000001',
      speaker: 'speaker_1',
      timestamp: 1,
      text: 'Le clustering change entre les exécutions.',
    }],
  });

  assert(memory?.openQuestions.length === 1, 'The LLM tool arguments were not parsed into structured memory.');
  assert(capturedSystemPrompt.includes('update_conference_memory'), 'The structured tool contract is missing.');
  assert(capturedSystemPrompt.includes('Never omit concrete numbers'), 'The loss-aware compaction contract is missing.');
  assert(capturedContext.includes('seg_000001'), 'Raw evidence IDs were not sent to the compactor.');
}

async function verifyIncrementalMemoryAndExactRetrieval() {
  const session = new SessionTracker();
  const fakeCompactor = {
    async compactConferenceMemory(request) {
      const first = request.newSegments[0];
      return {
        version: 1,
        currentTopic: 'Stabilité du clustering entre plusieurs runs',
        narrativeDigest: 'Sur 5 000 tables, environ 80 changent de classe entre 10 exécutions; la conférence cherche une mesure de stabilité.',
        openQuestions: [{
          text: 'Comment mesurer et améliorer la stabilité du clustering entre les runs ?',
          evidenceSegmentIds: [first.id],
          status: 'open',
        }],
        activeProblems: [{
          text: 'Le classement varie entre les exécutions malgré les mêmes 5 000 tables.',
          evidenceSegmentIds: [first.id],
          status: 'open',
        }],
        decisions: [],
        keyFacts: [{
          text: 'Environ 80 tables sur 5 000 se déplacent entre les classes sur 10 runs.',
          evidenceSegmentIds: [first.id],
          status: 'confirmed',
        }],
        constraints: [],
        uncertainties: [],
        coverage: null,
      };
    },
  };
  session.setRecapLLM(fakeCompactor);
  session.setSemanticCompactionEnabled(true);

  const startedAt = Date.now() - 40 * 60_000;
  for (let index = 0; index < 40; index++) {
    const text = index === 0
      ? 'Sur mes 5000 tables, environ 80 changent de classe entre les 10 runs différents.'
      : index === 39
        ? 'Quelle mesure de stabilité entre les runs devons-nous retenir pour répondre à ce problème ?'
        : `Intervention ${index}: discussion détaillée sur les modèles, les contraintes et les résultats de classification observés pendant la conférence.`;
    session.addTranscript(segment(index, text, startedAt + index * 60_000));
  }

  await session.waitForSemanticMemoryCompaction();
  await session.waitForSemanticMemoryCompaction();

  assert(session.getFullTranscript().length === 40, 'Semantic compaction removed raw transcript segments.');
  const memoryBlock = session.getSemanticMemoryContextBlock();
  assert(memoryBlock.includes('[SEMANTIC CONFERENCE MEMORY]'), 'The semantic memory context block was not created.');
  assert(memoryBlock.includes('80 tables sur 5 000'), 'Key numeric facts were lost from semantic memory.');
  assert(memoryBlock.includes('evidence=seg_000001'), 'Semantic memory lost its raw evidence reference.');

  const packet = new MeetingContextPacketBuilder(session).build({
    action: 'WHAT_TO_SAY',
    lastSeconds: 180,
    mode: { name: 'Conference', templateType: 'conference' },
    activeModeBlock: '',
    liveStateBlock: '',
  });
  assert(packet.context.includes('[SEMANTIC CONFERENCE MEMORY]'), 'The answer packet does not include semantic memory.');
  assert(
    packet.context.includes('Sur mes 5000 tables, environ 80 changent de classe'),
    `Exact raw evidence referenced by semantic memory was not retrieved: ${JSON.stringify(packet.retrievedEvidenceSegments)}`,
  );
  assert(
    packet.diagnostics.includes('semantic_memory_raw_segments_retained=40'),
    'Raw transcript retention is not exposed in packet diagnostics.',
  );
}

async function verifyFailureAndLegacyOverflowAreLossless() {
  const failedSession = new SessionTracker();
  failedSession.setRecapLLM({
    async compactConferenceMemory() {
      return null;
    },
  });
  failedSession.setSemanticCompactionEnabled(true);
  for (let index = 0; index < 32; index++) {
    failedSession.addTranscript(segment(
      index,
      `Segment ${index} suffisamment détaillé pour vérifier que le transcript brut reste intact même lorsque le LLM de compaction échoue complètement.`,
      Date.now() + index * 1000,
    ));
  }
  await failedSession.waitForSemanticMemoryCompaction();
  assert(failedSession.getFullTranscript().length === 32, 'LLM compaction failure removed raw transcript content.');
  assert(!failedSession.getSemanticMemoryContextBlock(), 'Invalid compaction output advanced semantic memory.');

  const longSession = new SessionTracker();
  for (let index = 0; index < 1810; index++) {
    longSession.addTranscript(segment(index, `Raw transcript preservation segment ${index}.`, Date.now() + index));
  }
  assert(
    longSession.getFullTranscript().length === 1810,
    'The legacy 1,800-segment boundary still evicts raw transcript content.',
  );
}

async function main() {
  await verifyToolContract();
  await verifyIncrementalMemoryAndExactRetrieval();
  await verifyFailureAndLegacyOverflowAreLossless();
  console.log(JSON.stringify({
    status: 'passed',
    checks: [
      'provider-neutral LLM tool-argument contract',
      'incremental semantic memory with stable evidence IDs',
      'recent verbatim plus exact historical retrieval',
      'raw transcript retention on success, failure, and >1800 segments',
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error('[semantic-memory-guard] FAILED:', error);
  process.exit(1);
});
