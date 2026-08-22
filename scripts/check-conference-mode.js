#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const builderModulePath = path.join(root, 'dist-electron/electron/meeting/MeetingContextPacketBuilder.js');
const routerModulePath = path.join(root, 'dist-electron/electron/transcript/TranscriptRouter.js');
const sources = [
  path.join(root, 'electron/meeting/MeetingContextPacketBuilder.ts'),
  path.join(root, 'electron/transcript/TranscriptRouter.ts'),
];
const compiledAt = fs.existsSync(builderModulePath) && fs.existsSync(routerModulePath)
  ? Math.min(fs.statSync(builderModulePath).mtimeMs, fs.statSync(routerModulePath).mtimeMs)
  : 0;

if (sources.some((source) => fs.statSync(source).mtimeMs > compiledAt)) {
  console.log('[conference-guard] Electron build missing or stale; rebuilding...');
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
const { TranscriptRouter } = require(routerModulePath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSession(segments) {
  const localItems = segments.map((segment) => ({
    role: 'user',
    speaker: 'me',
    text: segment.text,
    timestamp: segment.timestamp,
    canonicalRole: 'me',
    qualityFlags: [],
  }));
  return {
    getActionContext() {
      return localItems;
    },
    getActionContextDiagnostics() {
      return ['conference_fixture=machine_learning_models_and_evaluation'];
    },
    getFullTranscript() {
      return segments.map((segment) => ({
        speaker: 'me',
        canonicalRole: 'me',
        source: 'mic',
        qualityFlags: [],
        final: true,
        ...segment,
      }));
    },
    getLastInterimInterviewer() {
      return null;
    },
  };
}

const jul31ClusteringProblem = [
  {
    timestamp: 1785486596087,
    text: "Comment est-ce que je peux améliorer mon classement, mon clustering ? Parce que du coup, si je relance 10 fois mon algorithme, je vais avoir 10 classements différents.",
  },
  {
    timestamp: 1785486633055,
    text: "Quand ça arrêtait qu'on a compris, oui, parce que on s'arrête.",
  },
  {
    timestamp: 1785486744068,
    text: "c'est la méthode du couple. Vous regardez la coupe de descon et lorsque la pompe devient pratiquement plus vous pouvez vous la mettre à...",
  },
  {
    timestamp: 1785486835584,
    text: "mais sur mes 5000 tables, j'en ai environ 80 qui se promènent entre une classe et les autres, entre les 10 runs différents. Est-ce que vous voyez tous le problème dont on est en train de faire ?",
  },
];

const router = new TranscriptRouter();
const defaultMic = router.route({
  channel: 'mic',
  text: 'Comment est-ce que je peux nettoyer les données de mon téléphone ?',
  timestamp: Date.now(),
  final: true,
  confidence: 0.95,
  provider: 'local',
});
assert(defaultMic.segment?.role === 'me', 'Default mode must keep direct microphone questions assigned to the local user.');

router.setMicRoutingPolicy('conference_floor');
const conferenceMic = router.route({
  channel: 'mic',
  text: 'Sur cinq mille tables, environ quatre-vingts changent de classe entre les exécutions.',
  timestamp: Date.now() + 1,
  final: true,
  confidence: 0.95,
  provider: 'local',
});
assert(conferenceMic.segment?.role === 'interlocutor', 'Conference microphone audio must route to the shared conference floor.');
assert(conferenceMic.segment?.source === 'mic', 'Conference audio must still record its physical microphone source.');
assert(conferenceMic.segment?.qualityFlags.includes('conference_floor'), 'Conference floor provenance flag is missing.');
assert(conferenceMic.segment?.qualityFlags.includes('trusted_interlocutor'), 'Conference floor must be eligible as reliable meeting evidence.');

const builder = new MeetingContextPacketBuilder(makeSession(jul31ClusteringProblem));
const conferenceMode = { name: 'Conference', templateType: 'conference' };
const answerPacket = builder.build({
  action: 'WHAT_TO_SAY',
  lastSeconds: 180,
  mode: conferenceMode,
  activeModeBlock: '',
  liveStateBlock: '',
});
const target = normalize(answerPacket.actionTarget.text);
assert(answerPacket.contextMode === 'conference', 'Conference context mode was not selected.');
assert(answerPacket.hasReliableInterlocutor, 'Legacy Jul 31 microphone rows were not recovered as conference-floor evidence.');
assert(answerPacket.actionTarget.source === 'interlocutor', 'The conference problem must be the action target.');
assert(answerPacket.actionTarget.kind === 'direct_question', 'The latest multi-turn conference question was not detected.');
for (const term of ['clustering', '10 classements', '5000 tables', '80']) {
  assert(target.includes(normalize(term)), `The reconstructed Jul 31 problem is missing: ${term}`);
}
assert(answerPacket.diagnostics.includes('packet_effective_window_seconds=900'), 'Conference context window must expand to fifteen minutes.');

const clarificationPacket = builder.build({
  action: 'CLARIFY',
  lastSeconds: 180,
  mode: conferenceMode,
  activeModeBlock: '',
  liveStateBlock: '',
});
assert(
  clarificationPacket.context.includes('CLARIFY explains the latest concept or problem'),
  'Conference clarification must be an explanation, not another generic question.',
);
assert(
  clarificationPacket.context.includes('Explain the target clearly using its supporting turns'),
  'Conference clarification action contract is missing its explanatory behavior.',
);

const followUpPacket = builder.build({
  action: 'FOLLOW_UP_QUESTION',
  lastSeconds: 180,
  mode: conferenceMode,
  activeModeBlock: '',
  liveStateBlock: '',
});
assert(
  normalize(followUpPacket.actionTarget.text).includes('5000 tables'),
  'Question-to-ask action lost the latest multi-turn conference problem.',
);

const defaultPacket = builder.build({
  action: 'WHAT_TO_SAY',
  lastSeconds: 180,
  mode: { name: 'General', templateType: 'general' },
  activeModeBlock: '',
  liveStateBlock: '',
});
assert(defaultPacket.contextMode === 'default', 'Default mode unexpectedly enabled conference semantics.');
assert(!defaultPacket.hasReliableInterlocutor, 'Default mode must not relabel legacy microphone audio as interlocutor evidence.');
assert(defaultPacket.actionTarget.source === 'local_user', 'Default microphone behavior regressed.');

const now = Date.now();
const staleQuestionSession = makeSession([
  {
    timestamp: now - 11 * 60_000,
    text: "Quels critères permettent de distinguer la victoire au jeu d'une intelligence générale ?",
  },
  {
    timestamp: now - 95_000,
    text: "Dans l'approche neurosymbolique, le réseau apprend depuis les données et la couche symbolique vérifie les contraintes.",
  },
  {
    timestamp: now - 55_000,
    text: "Quand on parle d'intelligence artificielle, il faut garder la complémentarité des approches.",
  },
  {
    timestamp: now - 10_000,
    text: "Du coup, il faut assurer que les règles restent vérifiables dans le système neurosymbolique.",
  },
]);
const staleQuestionPacket = new MeetingContextPacketBuilder(staleQuestionSession).build({
  action: 'WHAT_TO_SAY',
  lastSeconds: 180,
  mode: conferenceMode,
  activeModeBlock: '',
  liveStateBlock: '',
});
assert(
  !normalize(staleQuestionPacket.actionTarget.text).includes('victoire au jeu'),
  'A stale conference question remained pinned after substantial newer speech.',
);
assert(
  normalize(staleQuestionPacket.actionTarget.text).includes('neurosymbolique'),
  'Conference focus did not move to the current neurosymbolic point.',
);

const danglingRequestSession = makeSession([
  {
    timestamp: now - 70_000,
    text: "Dans le dossier micro-python, vous avez les codes des composants et la configuration des broches.",
  },
  {
    timestamp: now - 35_000,
    text: "Suivez au tableau : on va vous montrer la correction et comment choisir l'interpréteur.",
  },
  {
    timestamp: now - 5_000,
    text: "Donc, il faut aller dans le...",
  },
]);
const danglingRequestPacket = new MeetingContextPacketBuilder(danglingRequestSession).build({
  action: 'WHAT_TO_SAY',
  lastSeconds: 180,
  mode: conferenceMode,
  activeModeBlock: '',
  liveStateBlock: '',
});
assert(
  danglingRequestPacket.actionTarget.kind !== 'implicit_request',
  'A dangling conference fragment was still classified as an implicit request.',
);
assert(
  !normalize(danglingRequestPacket.actionTarget.text).endsWith('aller dans le'),
  'A dangling conference fragment became the action target.',
);

console.log(JSON.stringify({
  status: 'passed',
  fixture: 'Friday Jul 31 - Machine Learning Models and Evaluation',
  audio: {
    source: conferenceMic.segment.source,
    role: conferenceMic.segment.role,
    flags: conferenceMic.segment.qualityFlags,
  },
  answerTarget: answerPacket.actionTarget,
  selectedSegments: answerPacket.selectedSegments.length,
  contextWindowSeconds: 900,
  actions: {
    clarification: 'explain',
    questionToAsk: followUpPacket.actionTarget.kind,
    answerLatest: answerPacket.actionTarget.kind,
  },
  regressions: {
    staleQuestionTarget: staleQuestionPacket.actionTarget,
    danglingFragmentTarget: danglingRequestPacket.actionTarget,
  },
}, null, 2));
