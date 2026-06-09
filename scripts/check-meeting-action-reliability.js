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
const meetingChatOverlayPath = path.join(
  repoRoot,
  "src",
  "components",
  "MeetingChatOverlay.tsx",
);
const mainPath = path.join(repoRoot, "electron", "main.ts");
const preloadPath = path.join(repoRoot, "electron", "preload.ts");
const electronTypesPath = path.join(repoRoot, "src", "types", "electron.d.ts");
const promptsPath = path.join(repoRoot, "electron", "llm", "prompts.ts");
const ragPromptsPath = path.join(repoRoot, "electron", "rag", "prompts.ts");

const engine = fs.readFileSync(enginePath, "utf8");
const packet = fs.readFileSync(packetPath, "utf8");
const router = fs.readFileSync(routerPath, "utf8");
const ui = fs.readFileSync(interfacePath, "utf8");
const meetingChatOverlay = fs.readFileSync(meetingChatOverlayPath, "utf8");
const main = fs.readFileSync(mainPath, "utf8");
const preload = fs.readFileSync(preloadPath, "utf8");
const electronTypes = fs.readFileSync(electronTypesPath, "utf8");
const prompts = fs.readFileSync(promptsPath, "utf8");
const ragPrompts = fs.readFileSync(ragPromptsPath, "utf8");

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
    name: "context packet retrieves relevant prior meeting evidence beyond the recent window",
    source: packet,
    pattern:
      /packet_retrieved_evidence_segments[\s\S]*RELEVANT PRIOR MEETING EVIDENCE[\s\S]*findRelevantPriorEvidence/,
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
    name: "live action tokens are held until quality validation finishes",
    source: engine,
    pattern:
      /shouldHoldLiveActionTokens[\s\S]*WHAT_TO_SAY[\s\S]*CLARIFY[\s\S]*FOLLOW_UP_QUESTION[\s\S]*liveActionTokenHandler[\s\S]*return \(\) => undefined/,
  },
  {
    name: "live actions run a bounded quality repair pass before fallback",
    source: engine,
    pattern:
      /improveLiveActionOutput[\s\S]*reviewLiveActionQuality[\s\S]*repairLiveActionOutput[\s\S]*quality_repair_still_weak/,
  },
  {
    name: "quality repair prompt uses relevant prior meeting evidence",
    source: engine,
    pattern:
      /buildLiveActionRepairSystemPrompt[\s\S]*RELEVANT PRIOR MEETING EVIDENCE[\s\S]*Synthesize across nearby and prior turns/,
  },
  {
    name: "action results record live quality telemetry",
    source: engine,
    pattern:
      /qualityScore[\s\S]*qualityReasons[\s\S]*qualityRepaired/,
  },
  {
    name: "direct-question answers are replaced when the model asks another question",
    source: engine,
    pattern:
      /improveLiveActionOutput[\s\S]*answered_question_with_question[\s\S]*shouldReplaceLiveActionOutput[\s\S]*outputLooksLikeAnotherQuestion/,
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
      /postProcessLiveActionOutput[\s\S]*sanitizeSingleQuestionOutput[\s\S]*sanitizeSingleQuestion: true[\s\S]*sanitizeSingleQuestion: true/,
  },
  {
    name: "clarify falls back from empty or generic unreliable answers",
    source: engine,
    pattern:
      /empty_live_action_output[\s\S]*buildLiveActionFallback\(action, packet\)[\s\S]*'CLARIFY'[\s\S]*sanitizeSingleQuestion: true/,
  },
  {
    name: "follow-up questions fall back from empty or generic unreliable answers",
    source: engine,
    pattern:
      /empty_live_action_output[\s\S]*buildLiveActionFallback\(action, packet\)[\s\S]*'FOLLOW_UP_QUESTION'[\s\S]*sanitizeSingleQuestion: true/,
  },
  {
    name: "manual answers fall back through manual answer policy when reliable context exists",
    source: engine,
    pattern:
      /qualityResult\.fallbackReason[\s\S]*answer = this\.buildManualAnswerFallback\(question, actionPacket\)/,
  },
  {
    name: "manual answers have a final deterministic fallback",
    source: engine,
    pattern:
      /empty_live_action_output[\s\S]*buildManualAnswerFallback\(question, actionPacket\)/,
  },
  {
    name: "manual typed questions are injected as local user questions",
    source: engine,
    pattern:
      /manualQuestionContext = this\.buildManualQuestionContextBlock\(question\)[\s\S]*manualQuestionItem = this\.buildManualQuestionContextItem\(question\)[\s\S]*buildActionContextPacket\([\s\S]*'ANSWER'[\s\S]*180[\s\S]*manualQuestionContext[\s\S]*manualQuestionItem \? \[manualQuestionItem\] : undefined[\s\S]*true[\s\S]*\[LOCAL USER QUESTION\][\s\S]*question_source=typed_user_input/,
  },
  {
    name: "manual answers reject raw transcript echoes",
    source: engine,
    pattern:
      /manualWeakOutput[\s\S]*shouldReplaceManualAnswerOutput[\s\S]*looksLikeRawTranscriptEcho/,
  },
  {
    name: "manual, RAG, and overlay prompts enforce transcript synthesis instead of fragment echo",
    source: `${engine}\n${ragPrompts}\n${meetingChatOverlay}`,
    pattern:
      /Internal answering method:[\s\S]*typed question as the query[\s\S]*Gather evidence across multiple nearby turns[\s\S]*ANSWERING METHOD:[\s\S]*Read all nearby turns together[\s\S]*Do not stop at a copied line[\s\S]*buildMeetingRecallSystemPrompt[\s\S]*Synthesize across turns[\s\S]*do not answer by copying one malformed fragment/,
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
