#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const enginePath = path.join(repoRoot, "electron", "IntelligenceEngine.ts");
const packetPath = path.join(
  repoRoot,
  "electron",
  "meeting",
  "MeetingContextPacketBuilder.ts",
);
const routerPath = path.join(repoRoot, "electron", "transcript", "TranscriptRouter.ts");
const interfacePath = path.join(
  repoRoot,
  "src",
  "components",
  "NativelyInterface.tsx",
);
const mainPath = path.join(repoRoot, "electron", "main.ts");
const preloadPath = path.join(repoRoot, "electron", "preload.ts");
const electronTypesPath = path.join(repoRoot, "src", "types", "electron.d.ts");
const promptsPath = path.join(repoRoot, "electron", "llm", "prompts.ts");

const engine = fs.readFileSync(enginePath, "utf8");
const packet = fs.readFileSync(packetPath, "utf8");
const router = fs.readFileSync(routerPath, "utf8");
const ui = fs.readFileSync(interfacePath, "utf8");
const main = fs.readFileSync(mainPath, "utf8");
const preload = fs.readFileSync(preloadPath, "utf8");
const electronTypes = fs.readFileSync(electronTypesPath, "utf8");
const prompts = fs.readFileSync(promptsPath, "utf8");

const checks = [
  {
    name: "manual text questions use the meeting action pipeline",
    source: ui,
    pattern:
      /const useMeetingContextAnswer = currentAttachments\.length === 0[\s\S]*window\.electronAPI\.submitManualQuestion/,
  },
  {
    name: "manual results settle the existing answer card",
    source: ui,
    pattern:
      /onIntelligenceManualResult[\s\S]*settleActionMessage\(prev, "manual", data\.answer/,
  },
  {
    name: "intelligence listeners are not rebound on hide/show",
    source: ui,
    pattern:
      /These listeners must survive Hide\/Show while an action is in flight[\s\S]*}, \[\]\);/,
  },
  {
    name: "context packet includes latest live interim speaker text",
    source: packet,
    pattern:
      /const liveInterimItems = this\.getLiveInterimItems\(\)[\s\S]*packet_live_interim_items/,
  },
  {
    name: "context packet adds an explicit action target block with supporting interlocutor context",
    source: packet,
    pattern:
      /buildActionTargetBlock[\s\S]*target_source=\$\{focus\.source\}[\s\S]*target_kind=\$\{focus\.kind\}[\s\S]*TARGET SUPPORTING INTERLOCUTOR CONTEXT/,
  },
  {
    name: "context packet repairs STT cuts before action generation",
    source: packet,
    pattern:
      /repairActionContext[\s\S]*TRANSCRIPT REPAIR[\s\S]*stitched_fragment[\s\S]*role_repaired/,
  },
  {
    name: "action packet targets local mic questions without relabeling them as speaker",
    source: packet,
    pattern:
      /localUserFocus[\s\S]*actionTarget[\s\S]*must never be used as proof of what the other participant said[\s\S]*source: 'local_user'/,
  },
  {
    name: "action diagnostics expose local target selection",
    source: packet,
    pattern:
      /packet_local_user_focus_kind[\s\S]*packet_target_source[\s\S]*packet_target_text/,
  },
  {
    name: "short standalone speaker questions are not polluted by noisy neighbor context",
    source: packet,
    pattern:
      /enrichQuestionWithNeighborContext[\s\S]*if \(this\.isStandaloneQuestion\(question\)\) return question[\s\S]*private isStandaloneQuestion/,
  },
  {
    name: "late giant mic finals are trimmed or rejected before becoming ME duplicates",
    source: router,
    pattern:
      /resolveLateMicFlushDuplicate[\s\S]*mic_late_flush_duplicate[\s\S]*late_flush_trimmed/,
  },
  {
    name: "silent speaker channel can route mic-captured interlocutor speech as fallback speaker",
    source: router,
    pattern:
      /shouldRouteMicAsSpeakerFallback[\s\S]*system_audio_unavailable[\s\S]*mic_speaker_fallback/,
  },
  {
    name: "parakeet partial commits wait for stable transcript boundaries",
    source: fs.readFileSync(path.join(repoRoot, "electron", "audio", "ParakeetStreamingSTT.ts"), "utf8"),
    pattern:
      /shouldAutoCommitPartial[\s\S]*isStablePartialCommitBoundary[\s\S]*endsWithDanglingConnector/,
  },
  {
    name: "answer prompts allow routed local mic questions",
    source: prompts,
    pattern:
      /UNIVERSAL_ANSWER_PROMPT[\s\S]*Action target source: local_user[\s\S]*\[LOCAL USER QUESTION\][\s\S]*do not refuse it as missing speaker context/,
  },
  {
    name: "what-to-answer prompt does not reject local-user action targets",
    source: prompts,
    pattern:
      /UNIVERSAL_WHAT_TO_ANSWER_PROMPT[\s\S]*target_source=local_user[\s\S]*unless target_source=local_user or \[LOCAL USER QUESTION\] is present/,
  },
  {
    name: "action stream cancellation does not block timeout fallback",
    source: engine,
    pattern:
      /result\.type === 'timeout'[\s\S]*this\.cancelActionStream\(stream\)[\s\S]*private cancelActionStream[\s\S]*Promise\.race/,
  },
  {
    name: "direct-question answers are replaced when the model asks another question",
    source: engine,
    pattern:
      /shouldReplaceLiveActionOutput[\s\S]*outputLooksLikeAnotherQuestion[\s\S]*buildLiveActionFallback\('WHAT_TO_SAY', actionPacket\)/,
  },
  {
    name: "generic topic outputs are replaced for concrete bug-flow context",
    source: engine,
    pattern:
      /shouldReplaceGenericTopicOutput[\s\S]*looksLikeGenericClarificationOutput[\s\S]*looksLikeBugFlowContext/,
  },
  {
    name: "bug-flow live fallback suggests the concrete test path",
    source: engine,
    pattern:
      /looksLikeBugFlowContext\(bugFlowContext\)[\s\S]*envoie-moi le flux[\s\S]*comparer l'envoi simple avec les flux IA\/Pierre/,
  },
  {
    name: "clarify and follow-up outputs are collapsed to a single question",
    source: engine,
    pattern:
      /sanitizeSingleQuestionOutput[\s\S]*fullClarification = this\.sanitizeSingleQuestionOutput\(fullClarification\)[\s\S]*fullQuestions = this\.sanitizeSingleQuestionOutput\(fullQuestions\)/,
  },
  {
    name: "clarify falls back from empty or generic unreliable answers",
    source: engine,
    pattern:
      /fullClarification = this\.buildLiveActionFallback\('CLARIFY', actionPacket\)/,
  },
  {
    name: "follow-up questions fall back from empty or generic unreliable answers",
    source: engine,
    pattern:
      /fullQuestions = this\.buildLiveActionFallback\('FOLLOW_UP_QUESTION', actionPacket\)/,
  },
  {
    name: "manual answers fall back through manual answer policy when reliable context exists",
    source: engine,
    pattern:
      /manual_answer_insufficient_context[\s\S]*answer = this\.buildManualAnswerFallback\(question, actionPacket\)/,
  },
  {
    name: "manual answers have a final deterministic fallback",
    source: engine,
    pattern:
      /empty_manual_answer[\s\S]*answer = this\.buildManualAnswerFallback\(question, actionPacket\)/,
  },
  {
    name: "manual typed questions are injected as local user questions",
    source: engine,
    pattern:
      /manualQuestionContext = this\.buildManualQuestionContextBlock\(question\)[\s\S]*buildActionContextPacket\('ANSWER', 120, undefined, manualQuestionContext\)[\s\S]*\[LOCAL USER QUESTION\][\s\S]*question_source=typed_user_input/,
  },
  {
    name: "manual answers reject raw transcript echoes",
    source: engine,
    pattern:
      /manual_answer_echo_or_weak_bug_reply[\s\S]*shouldReplaceManualAnswerOutput[\s\S]*looksLikeRawTranscriptEcho/,
  },
  {
    name: "manual bug replies get a deterministic actionable fallback",
    source: engine,
    pattern:
      /buildManualAnswerFallback[\s\S]*reproduire le cas sur le compte WaChap[\s\S]*tester séparément l'envoi simple puis les flux IA\/Pierre/,
  },
  {
    name: "generic no-context model replies are treated as unreliable",
    source: engine,
    pattern:
      /didn't catch that[\s\S]*transcript doesn't mention[\s\S]*current context is insufficient/,
  },
  {
    name: "system-audio-silent is exposed through preload and app types",
    source: `${preload}\n${electronTypes}`,
    pattern:
      /onSystemAudioSilent[\s\S]*system-audio-silent[\s\S]*onSystemAudioSilent/,
  },
  {
    name: "system-audio-active clears stale silent speaker warning",
    source: `${main}\n${preload}\n${electronTypes}\n${ui}`,
    pattern:
      /system-audio-active[\s\S]*onSystemAudioActive[\s\S]*setSystemAudioWarning\(null\)/,
  },
  {
    name: "overlay visibly warns when speaker capture is silent",
    source: ui,
    pattern:
      /onSystemAudioSilent[\s\S]*Speaker Audio Is Silent[\s\S]*setIsExpanded\(true\)/,
  },
];

const failures = checks.filter((check) => !check.pattern.test(check.source));
const recordOnlyBlock =
  main.match(/if \(!shouldFeedPassiveContext\) \{[\s\S]*?return;\s*\}/)?.[0] ||
  "";

if (!recordOnlyBlock || /feedCopilotContext/.test(recordOnlyBlock)) {
  failures.push({
    name: "record-only mic transcripts do not feed the proactive copilot",
  });
}

if (failures.length > 0) {
  console.error("Meeting action reliability guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Meeting action reliability guard passed (${checks.length} checks).`);
