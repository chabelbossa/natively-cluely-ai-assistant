#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const fixturePaths = args.length > 0
  ? args
  : [
      path.join(process.env.HOME || '', 'Library/Application Support/natively/meeting-debug/meeting_2026-05-18T11-26-21-810Z.jsonl'),
      path.join(process.env.HOME || '', 'Library/Application Support/natively/meeting-debug/meeting_2026-05-18T19-46-39-052Z.jsonl'),
    ];

const runnerModulePath = path.join(root, 'dist-electron/electron/meeting/MeetingContextPacketBuilder.js');

const sourceModulePath = path.join(root, 'electron/meeting/MeetingContextPacketBuilder.ts');
const runnerIsStale =
  !fs.existsSync(runnerModulePath) ||
  fs.statSync(runnerModulePath).mtimeMs < fs.statSync(sourceModulePath).mtimeMs;

if (runnerIsStale) {
  console.log('[focus-replay] dist-electron missing or stale; building Electron sources first...');
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

const { MeetingContextPacketBuilder } = require(runnerModulePath);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
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

function makeFakeSession(selectedSegments, lastInterim) {
  const items = selectedSegments.map((segment) => ({
    role: segment.role,
    speaker: segment.speaker,
    text: segment.text,
    timestamp: segment.timestamp || Date.now(),
    canonicalRole: segment.canonicalRole,
    qualityFlags: segment.qualityFlags || [],
  }));

  return {
    getActionContext() {
      return items;
    },
    getActionContextDiagnostics() {
      const counts = items.reduce((acc, item) => {
        acc[item.role] = (acc[item.role] || 0) + 1;
        return acc;
      }, {});
      return [
        'focus_replay=true',
        `focus_replay_counts=${JSON.stringify(counts)}`,
      ];
    },
    getFullTranscript() {
      return items.map((item) => ({
        ...item,
        final: true,
      }));
    },
    getLastInterimInterviewer() {
      return lastInterim || null;
    },
  };
}

function inspectFile(filePath) {
  const events = readJsonl(filePath)
    .filter((event) => event.type === 'action_context' && event.payload?.selectedSegments?.length);

  const results = events.map((event, index) => {
    const builder = new MeetingContextPacketBuilder(makeFakeSession(event.payload.selectedSegments));
    const packet = builder.build({
      action: event.payload.action || 'ANSWER',
      lastSeconds: 180,
      activeModeBlock: '',
      liveStateBlock: '',
      additionalItems: event.payload.additionalItems || [],
    });

    const weak =
      packet.hasReliableInterlocutor &&
      (
        (packet.interlocutorFocus.kind === 'topic' && isWeakTopic(packet.interlocutorFocus.text)) ||
        (packet.interlocutorFocus.kind === 'direct_question' && isWeakDirectQuestion(packet.interlocutorFocus.text)) ||
        (packet.interlocutorFocus.kind === 'implicit_request' && isWeakImplicitRequest(packet.interlocutorFocus.text))
      );

    const failed =
      packet.hasReliableInterlocutor &&
      (
        packet.interlocutorFocus.kind === 'none' ||
        !packet.interlocutorFocus.text.trim() ||
        weak
      );

    return {
      index: index + 1,
      action: event.payload.action,
      reliable: packet.hasReliableInterlocutor,
      trust: Number(packet.contextTrustScore.toFixed(2)),
      focusKind: packet.interlocutorFocus.kind,
      focusConfidence: Number(packet.interlocutorFocus.confidence.toFixed(2)),
      focusText: packet.interlocutorFocus.text,
      targetSource: packet.actionTarget?.source,
      targetKind: packet.actionTarget?.kind,
      targetText: packet.actionTarget?.text,
      localUserFocusKind: packet.localUserFocus?.kind,
      localUserFocusText: packet.localUserFocus?.text,
      weak,
      failed,
    };
  });

  return {
    file: filePath,
    actionContexts: events.length,
    failed: results.filter((result) => result.failed).length,
    results,
  };
}

function inspectSyntheticCase(testCase) {
  const builder = new MeetingContextPacketBuilder(makeFakeSession(testCase.selectedSegments, testCase.lastInterim));
  const packet = builder.build({
    action: testCase.action || 'WHAT_TO_SAY',
    lastSeconds: 180,
    activeModeBlock: '',
    liveStateBlock: '',
    additionalItems: testCase.additionalItems || [],
  });

  const failed = Boolean(
    testCase.expectKind && packet.interlocutorFocus.kind !== testCase.expectKind ||
    testCase.expectTargetSource && packet.actionTarget?.source !== testCase.expectTargetSource ||
    testCase.expectTargetKind && packet.actionTarget?.kind !== testCase.expectTargetKind ||
    testCase.mustInclude && !testCase.mustInclude.every((term) => normalize(packet.interlocutorFocus.text).includes(normalize(term))) ||
    testCase.targetMustInclude && !testCase.targetMustInclude.every((term) => normalize(packet.actionTarget?.text).includes(normalize(term))) ||
    testCase.mustNotInclude && testCase.mustNotInclude.some((term) => normalize(packet.interlocutorFocus.text).includes(normalize(term))) ||
    testCase.contextMustInclude && !testCase.contextMustInclude.every((term) => normalize(packet.context).includes(normalize(term))) ||
    (packet.interlocutorFocus.kind === 'topic' && isWeakTopic(packet.interlocutorFocus.text))
    || (packet.interlocutorFocus.kind === 'implicit_request' && isWeakImplicitRequest(packet.interlocutorFocus.text))
  );

  return {
    name: testCase.name,
    action: testCase.action || 'WHAT_TO_SAY',
    reliable: packet.hasReliableInterlocutor,
    trust: Number(packet.contextTrustScore.toFixed(2)),
    focusKind: packet.interlocutorFocus.kind,
    focusConfidence: Number(packet.interlocutorFocus.confidence.toFixed(2)),
    focusText: packet.interlocutorFocus.text,
    targetSource: packet.actionTarget?.source,
    targetKind: packet.actionTarget?.kind,
    targetText: packet.actionTarget?.text,
    localUserFocusKind: packet.localUserFocus?.kind,
    localUserFocusText: packet.localUserFocus?.text,
    failed,
  };
}

const syntheticCases = [
  {
    name: 'processus hierarchique explanation is not reduced to a truncated implicit request',
    action: 'ANSWER',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_3',
        canonicalRole: 'speaker_3',
        timestamp: Date.now() - 18_000,
        text: "J'avais entendu ce thème-là quand je faisais mes recherches, un processus gaussien organisé en plusieurs niveaux. Ça veut dire qu'on regarde aussi le comportement des locataires.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 8_000,
        text: "Si on quitte le contexte des locataires, par exemple avec des données de natation, on a plusieurs profils. Avec un processus gaussien simple, tu vas peut-être modéliser chaque individu, alors qu'avec le processus hiérarchique tu fais entrer les différences entre profils comme les hommes et les femmes.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'topic',
    targetMustInclude: ['processus hiérarchique'],
    mustNotInclude: ['tu vas peut être modéliser chaque individu de façon alors qu avec le processus'],
  },
  {
    name: 'mic-only direct user question becomes local action target without speaker relabel',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'user',
        speaker: 'me',
        canonicalRole: 'me',
        timestamp: Date.now() - 8_000,
        text: "Bonjour Marcel, je voudrais prendre quelques renseignements sur comment je peux nettoyer mon téléphone tout en conservant les données de WaChap. Est-ce que tu as une idée de comment je peux y arriver ?",
      },
    ],
    expectTargetSource: 'local_user',
    expectTargetKind: 'direct_question',
    targetMustInclude: ['wachap', 'comment je peux y arriver'],
    contextMustInclude: ['Action target source: local_user', 'LOCAL USER QUESTION', 'ME/LOCAL MIC'],
  },
  {
    name: 'older payment question is demoted after newer associate compensation discussion',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 70_000,
        text: "Ça veut dire que si on doit signer un contrat, on signe un contrat de trois mois.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 58_000,
        text: "Oui, c'est ce que je dis, dans les trois mois là, on fera le paiement mensuel ou pas?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 30_000,
        text: "Donc je note les propositions, mais j'ai souvent besoin de trouver un associé avec qui on investit dans le projet.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 14_000,
        text: "L'investissement, on va faire from scratch, et à ce moment-là on fixe les rémunérations pour les différentes parties et le niveau d'implication de chacun.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'topic',
    expectTargetSource: 'interlocutor',
    expectTargetKind: 'topic',
    mustInclude: ['rémunérations'],
    mustNotInclude: ['paiement mensuel'],
    targetMustInclude: ['rémunérations'],
    contextMustInclude: ['associé', 'investit', 'rémunérations'],
  },
  {
    name: 'latest interim question becomes action focus',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        timestamp: Date.now() - 12_000,
        text: "On parlait de votre parcours technique et de vos projets récents.",
      },
    ],
    additionalItems: [
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        source: 'live',
        timestamp: Date.now(),
        text: "Pouvez-vous me donner un exemple concret de votre expérience avec React ?",
      },
    ],
    expectKind: 'direct_question',
    mustInclude: ['exemple concret', 'react'],
  },
  {
    name: 'short standalone speaker question is not polluted by noisy previous STT',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 8_000,
        text: "Normalement when you don't have the info de l'application it's possible to supprimer les informations de WaChap lui-même. Donc il y a possibilité de supprimer les info to WaChap and WaChap la tout neuf qua tu vois maintenant you copy android même you say",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor', 'stt_low_quality'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 1_000,
        text: "WaChap. Pourquoi tu veux conserver Android ?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'user',
        speaker: 'me',
        canonicalRole: 'me',
        timestamp: Date.now(),
        text: "Si tu veux supprimer WaChap, pourquoi tu veux conserver Android, c'est quoi répondre ?",
        qualityFlags: ['possible_overlap', 'mic_intervention'],
      },
    ],
    expectKind: 'direct_question',
    expectTargetSource: 'interlocutor',
    expectTargetKind: 'direct_question',
    mustInclude: ['pourquoi tu veux conserver android'],
    mustNotInclude: ['normalement when', 'you copy android'],
    targetMustInclude: ['pourquoi tu veux conserver android'],
  },
  {
    name: 'shared context packet automatically sees latest live interim question',
    action: 'ANSWER',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        timestamp: Date.now() - 15_000,
        text: "On parlait encore de votre dernier projet et du contexte général.",
      },
    ],
    lastInterim: {
      speaker: 'Speaker',
      canonicalRole: 'interlocutor',
      source: 'system',
      final: false,
      timestamp: Date.now(),
      text: "Pourquoi avez-vous choisi cette architecture plutôt qu'une solution plus simple ?",
    },
    expectKind: 'direct_question',
    mustInclude: ['pourquoi', 'architecture'],
  },
  {
    name: 'speaker fragments are stitched before the answer context is built',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 14_000,
        text: "La donnée de WaChap peut être nettoyée",
        qualityFlags: ['system_audio', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 10_000,
        text: "sans toucher à Android",
        qualityFlags: ['system_audio', 'trusted_interlocutor', 'speaker_stable'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 2_000,
        text: "Pourquoi tu veux conserver Android ?",
        qualityFlags: ['system_audio', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'direct_question',
    expectTargetSource: 'interlocutor',
    targetMustInclude: ['pourquoi tu veux conserver android'],
    contextMustInclude: ['La donnée de WaChap peut être nettoyée sans toucher à Android', 'TRANSCRIPT REPAIR', 'stitched_fragment'],
  },
  {
    name: 'overlap mic continuation is repaired into speaker context before answer',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 14_000,
        text: "On peut supprimer les données inutiles de WaChap",
        qualityFlags: ['system_audio', 'trusted_interlocutor'],
      },
      {
        role: 'user',
        speaker: 'me',
        canonicalRole: 'me',
        timestamp: Date.now() - 10_500,
        text: "sans réinitialiser Android",
        qualityFlags: ['possible_overlap', 'mic_gate_held'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 2_000,
        text: "Pourquoi tu veux conserver Android ?",
        qualityFlags: ['system_audio', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'direct_question',
    expectTargetSource: 'interlocutor',
    targetMustInclude: ['pourquoi tu veux conserver android'],
    contextMustInclude: ['On peut supprimer les données inutiles de WaChap sans réinitialiser Android', 'role_repaired'],
  },
  {
    name: 'noisy monologue topic is condensed to the concrete subject',
    action: 'FOLLOW_UP_QUESTION',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        timestamp: Date.now() - 8_000,
        text: "J'ai quand même pris un mois d'énervement, j'avais les nerfs, j'ai une chaîne YouTube qui parle de JavaScript, et l'IA remplace React, Next JS et JavaScript, mes vues ont été divisées par deux.",
      },
    ],
    expectKind: 'topic',
    mustInclude: ['ia'],
    mustNotInclude: ['nerfs', 'énervement'],
  },
  {
    name: 'comprehension check carries supporting context into action target',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        timestamp: Date.now() - 16_000,
        text: "On garde le tableau d'écoulement, mais l'alerte doit aussi expliquer combien d'unités risquent d'expirer si la vitesse de vente reste la même.",
      },
      {
        role: 'interviewer',
        speaker: 'Speaker',
        canonicalRole: 'interlocutor',
        timestamp: Date.now() - 5_000,
        text: "Tu comprends quoi ?",
      },
    ],
    expectKind: 'direct_question',
    mustInclude: ['alerte', 'tu comprends'],
    contextMustInclude: ['target_is_comprehension_check', 'unités risquent d expirer'],
  },
  {
    name: 'direct question survives a long explicit explanation before the click',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 58_000,
        text: "Comment allez-vous garantir la cohérence des stocks entre les pharmacies ?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 42_000,
        text: "Pour préciser, plusieurs pharmacies peuvent modifier le même produit presque au même moment et chacune travaille parfois avec une connexion instable.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 24_000,
        text: "Par exemple, une vente peut être enregistrée hors ligne pendant qu'un réapprovisionnement arrive depuis le serveur central.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_1',
        canonicalRole: 'speaker_1',
        timestamp: Date.now() - 7_000,
        text: "Je veux surtout comprendre votre stratégie de résolution des conflits et la manière dont vous évitez un stock négatif.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'direct_question',
    expectTargetSource: 'interlocutor',
    expectTargetKind: 'direct_question',
    targetMustInclude: ['cohérence des stocks', 'pharmacies'],
    contextMustInclude: ['connexion instable', 'réapprovisionnement', 'résolution des conflits'],
  },
  {
    name: 'latest reformulated question outranks the earlier wording',
    action: 'ANSWER',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 46_000,
        text: "Pourquoi avez-vous choisi une architecture événementielle pour ce projet ?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 22_000,
        text: "Je reformule parce que je ne cherche pas seulement une définition générale : je veux connaître le compromis concret que vous avez accepté.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_2',
        canonicalRole: 'speaker_2',
        timestamp: Date.now() - 5_000,
        text: "Autrement dit, comment avez-vous arbitré entre la fiabilité et la complexité opérationnelle ?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'direct_question',
    targetMustInclude: ['comment avez vous arbitré', 'fiabilité', 'complexité opérationnelle'],
    mustNotInclude: ['pourquoi avez vous choisi'],
    contextMustInclude: ['architecture événementielle', 'compromis concret'],
  },
  {
    name: 'short acknowledgement after a question does not erase the target',
    action: 'WHAT_TO_SAY',
    selectedSegments: [
      {
        role: 'interviewer',
        speaker: 'speaker_3',
        canonicalRole: 'speaker_3',
        timestamp: Date.now() - 31_000,
        text: "Pouvez-vous expliquer comment vous surveillez les erreurs en production ?",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
      {
        role: 'interviewer',
        speaker: 'speaker_3',
        canonicalRole: 'speaker_3',
        timestamp: Date.now() - 4_000,
        text: "D'accord, très bien.",
        qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
      },
    ],
    expectKind: 'direct_question',
    targetMustInclude: ['surveillez les erreurs', 'production'],
  },
];

const reports = fixturePaths.map((fixturePath) => inspectFile(path.resolve(fixturePath)));
const syntheticResults = syntheticCases.map(inspectSyntheticCase);
const failed = reports.reduce((count, report) => count + report.failed, 0);
const syntheticFailed = syntheticResults.filter((result) => result.failed).length;

console.log(JSON.stringify({ failed: failed + syntheticFailed, reports, syntheticResults }, null, 2));
process.exit(failed + syntheticFailed === 0 ? 0 : 1);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWeakTopic(text) {
  const normalized = normalize(text);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 7) return true;
  const last = words[words.length - 1];
  if (/^(le|la|les|un|une|des|du|de|mon|ma|mes|pour|avec|dans|sur|qui|que|et|mais|donc|c|est)$/.test(last)) {
    return true;
  }
  if (/\b(en attendant|wait wait)\b/.test(normalized) && words.length <= 10) {
    return true;
  }
  if (/\b(nerfs|enervement|énervement|tabasser)\b/.test(normalized) && !/\b(ia|react|next|javascript|youtube|alerte|publicite|publicité)\b/.test(normalized)) {
    return true;
  }
  if (words.length > 55) return true;
  return false;
}

function isWeakImplicitRequest(text) {
  const normalized = normalize(text);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 8) return true;
  if (/\bavec le processus$/.test(normalized)) return true;
  if (/^(tu vois|en fait|bon|oui|d accord)\b/.test(normalized) && words.length <= 16) return true;
  return false;
}

function isWeakDirectQuestion(text) {
  const normalized = normalize(text);
  const words = normalized.split(' ').filter(Boolean);
  if (/\b(tu comprends|vous comprenez|tu as compris|vous avez compris)\b/.test(normalized)) {
    return words.length < 10;
  }
  return words.length < 4;
}
