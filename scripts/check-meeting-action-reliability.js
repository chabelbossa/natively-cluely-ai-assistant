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
const promptProfilePath = path.join(repoRoot, "electron", "llm", "PromptProfileRegistry.ts");
const ragPromptsPath = path.join(repoRoot, "electron", "rag", "prompts.ts");
const llmHelperPath = path.join(repoRoot, "electron", "LLMHelper.ts");
const orchestratorPath = path.join(
  repoRoot,
  "electron",
  "meeting",
  "MeetingActionOrchestrator.ts",
);
const liveActionMessagesPath = path.join(repoRoot, "src", "lib", "liveActionMessages.ts");

const engine = fs.readFileSync(enginePath, "utf8");
const packet = fs.readFileSync(packetPath, "utf8");
const orchestrator = fs.readFileSync(orchestratorPath, "utf8");
const router = fs.readFileSync(routerPath, "utf8");
const ui = fs.readFileSync(interfacePath, "utf8");
const meetingChatOverlay = fs.readFileSync(meetingChatOverlayPath, "utf8");
const main = fs.readFileSync(mainPath, "utf8");
const preload = fs.readFileSync(preloadPath, "utf8");
const electronTypes = fs.readFileSync(electronTypesPath, "utf8");
const prompts = fs.readFileSync(promptsPath, "utf8");
const promptProfileRegistry = fs.readFileSync(promptProfilePath, "utf8");
const ragPrompts = fs.readFileSync(ragPromptsPath, "utf8");
const llmHelper = fs.readFileSync(llmHelperPath, "utf8");
const liveActionMessages = fs.readFileSync(liveActionMessagesPath, "utf8");

const checks = [
  {
    name: "manual text questions use the agentic live-context stream path",
    source: ui,
    pattern:
      /const runAgenticResponse = async[\s\S]*window\.electronAPI\.getIntelligenceContext[\s\S]*buildAgenticAnswerContext[\s\S]*window\.electronAPI\.streamGeminiChat[\s\S]*const handleManualSubmit = async[\s\S]*runAgenticResponse\([\s\S]*source: currentAttachments\.length > 0 \? "screenshot" : "manual"/,
  },
  {
    name: "manual results settle the existing answer card",
    source: ui,
    pattern:
      /onIntelligenceManualResult[\s\S]*settleActionMessage\(prev, actionId, "manual", data\.answer/,
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
    name: "context packet ranks the latest three plausible interlocutor questions",
    source: packet,
    pattern:
      /questionCandidates[\s\S]*buildQuestionCandidatesBlock[\s\S]*\[RECENT QUESTION CANDIDATES\][\s\S]*candidate_\$\{candidate\.rank\}/,
  },
  {
    name: "latest valid interlocutor question remains candidate one",
    source: packet,
    pattern:
      /return candidates[\s\S]*\.sort\(\(a, b\) => b\.timestamp - a\.timestamp\)[\s\S]*\.slice\(0, 3\)[\s\S]*\.map\(\(candidate, index\) => \(\{ \.\.\.candidate, rank: index \+ 1 \}\)\)/,
  },
  {
    name: "question focus keeps the following explanation in supporting context",
    source: packet,
    pattern:
      /pickSupportingInterlocutorItems[\s\S]*focusIndex \+ 7/,
  },
  {
    name: "what-to-say packet prompt allows profile-grade answers instead of one short phrase",
    source: packet,
    pattern:
      /Output the exact words the user can say aloud now[\s\S]*selected prompt profile[\s\S]*4-7 strong spoken sentences[\s\S]*complete enough for profile-grade/,
  },
  {
    name: "legacy action orchestrator no longer forces one-phrase live answers",
    source: orchestrator,
    pattern:
      /Return the exact words the user can say aloud now[\s\S]*4-7 strong spoken sentences/,
  },
  {
    name: "adaptive prompt profile registry covers live meeting modes",
    source: promptProfileRegistry,
    pattern:
      /(?=[\s\S]*resolvePromptProfile)(?=[\s\S]*buildPromptProfileBlock)(?=[\s\S]*interview_candidate)(?=[\s\S]*meeting_copilot)(?=[\s\S]*project_context)(?=[\s\S]*client_call)(?=[\s\S]*learning)/,
  },
  {
    name: "prompt profiles are compact behavior contracts rather than a giant static system prompt",
    source: promptProfileRegistry,
    pattern:
      /\[PROMPT PROFILE\][\s\S]*selection_policy=This profile is selected from the active user mode[\s\S]*not a giant static system prompt/,
  },
  {
    name: "active mode context injects selected prompt profile into live action packets",
    source: engine,
    pattern:
      /buildPromptProfileBlockForMode[\s\S]*promptProfileBlock[\s\S]*modeContextBlock[\s\S]*promptProfileBlock/,
  },
  {
    name: "meeting packet contract lets selected prompt profile override generic defaults",
    source: packet,
    pattern:
      /\[PROMPT PROFILE\][\s\S]*selected user mode[\s\S]*selected prompt profile wins over generic live-meeting defaults[\s\S]*profile-specific direct answers/,
  },
  {
    name: "legacy action orchestrator respects prompt profile policy",
    source: orchestrator,
    pattern:
      /\[PROMPT PROFILE\][\s\S]*active profile wins over generic meeting defaults/,
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
    name: "what-to-answer prompt selects among recent question candidates before answering",
    source: prompts,
    pattern:
      /UNIVERSAL_WHAT_TO_ANSWER_PROMPT[\s\S]*\[RECENT QUESTION CANDIDATES\][\s\S]*candidate_1[\s\S]*candidate_2[\s\S]*candidate_3[\s\S]*Answer the selected question/,
  },
  {
    name: "live universal prompts allow substantial interview answers",
    source: prompts,
    pattern:
      /UNIVERSAL_ANSWER_PROMPT[\s\S]*4-7 strong spoken sentences[\s\S]*UNIVERSAL_WHAT_TO_ANSWER_PROMPT[\s\S]*4-7 strong spoken sentences/,
  },
  {
    name: "codex model catalog exposes GPT 5.3 Codex Spark fallback",
    source: `${fs.readFileSync(path.join(repoRoot, "src", "utils", "modelUtils.ts"), "utf8")}\n${fs.readFileSync(path.join(repoRoot, "src", "config", "codexModels.ts"), "utf8")}`,
    pattern: /codex:gpt-5\.3-codex-spark[\s\S]*GPT 5\.3 Codex Spark/,
  },
  {
    name: "meeting summary regeneration honors selected Codex model before Groq/Gemini",
    source: llmHelper,
    pattern:
      /generateMeetingSummary[\s\S]*Attempting Codex \(\$\{this\.currentModelId\}\) for summary[\s\S]*generateWithCodex\(`Context:\\n\$\{context\}`,\s*systemPrompt,\s*this\.currentModelId\)[\s\S]*Attempting Groq for summary/,
  },
  {
    name: "meeting summary one-shot reports actual generation route instead of only runtime model",
    source: `${llmHelper}\n${main}`,
    pattern:
      /getLastMeetingSummaryRoute[\s\S]*usedFallback[\s\S]*generationRoute: llmHelper\.getLastMeetingSummaryRoute\(\)/,
  },
  {
    name: "action stream cancellation does not block timeout fallback",
    source: engine,
    pattern:
      /result\.type === 'timeout'[\s\S]*this\.cancelActionStream\(stream\)[\s\S]*private cancelActionStream[\s\S]*Promise\.race/,
  },
  {
    name: "a generation invalidated while stream.next is pending is rejected before done or token handling",
    source: engine,
    pattern:
      /await Promise\.race\([\s\S]*if \(!this\.isGenerationCurrent\(mode, generationId\)\) \{[\s\S]*aborted: true[\s\S]*if \(result\.type === 'timeout'\)/,
  },
  {
    name: "Codex service-tier telemetry is isolated per asynchronous action",
    source: `${llmHelper}\n${fs.readFileSync(path.join(repoRoot, "electron", "services", "CodexResponsesClient.ts"), "utf8")}\n${fs.readFileSync(path.join(repoRoot, "electron", "IntelligenceManager.ts"), "utf8")}`,
    pattern:
      /AsyncLocalStorage[\s\S]*runWithServiceTierTracking[\s\S]*runWithCodexServiceTierTracking[\s\S]*runWhatShouldISay/,
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
    name: "what-to-say cancels the action when a quality repair becomes stale",
    source: engine,
    pattern:
      /improveLiveActionOutput\([\s\S]*if \(!this\.isGenerationCurrent\('what_to_say', generationId\)\) \{[\s\S]*this\.emit\('action_cancelled', 'what_to_say', resolvedActionId\)/,
  },
  {
    name: "clarify cancels the action when a quality repair becomes stale",
    source: engine,
    pattern:
      /runClarify[\s\S]*improveLiveActionOutput\([\s\S]*if \(!this\.isGenerationCurrent\('clarify', generationId\)\) \{[\s\S]*this\.emit\('action_cancelled', 'clarify', resolvedActionId\)/,
  },
  {
    name: "manual answers are rejected when reset during quality repair",
    source: engine,
    pattern:
      /runManualAnswer[\s\S]*improveLiveActionOutput\([\s\S]*if \(!this\.isGenerationCurrent\('manual', generationId\)\) \{[\s\S]*return null;[\s\S]*this\.session\.addAssistantMessage\(answer\)/,
  },
  {
    name: "empty follow-up output fails instead of leaving a pending card",
    source: engine,
    pattern:
      /runFollowUp[\s\S]*if \(!fullRefined\.trim\(\)\) \{[\s\S]*throw new Error\('Follow-up generation returned an empty response\.'\)/,
  },
  {
    name: "operational action failures are rethrown after emitting their terminal error",
    source: engine,
    pattern:
      /runWhatShouldISay[\s\S]*this\.emit\('error', error as Error, 'what_to_say', resolvedActionId\);[\s\S]*throw error;[\s\S]*runFollowUp[\s\S]*this\.emit\('error', error as Error, 'follow_up', resolvedActionId\);[\s\S]*throw error;[\s\S]*runRecap[\s\S]*this\.emit\('error', error as Error, 'recap', resolvedActionId\);[\s\S]*throw error;[\s\S]*runClarify[\s\S]*this\.emit\('error', error as Error, 'clarify', resolvedActionId\);[\s\S]*throw error;/,
  },
  {
    name: "terminal live-action cards cannot be overwritten by late events",
    source: liveActionMessages,
    pattern:
      /existingIsTerminal[\s\S]*if \(existingStatus !== status \|\| !meta\) return messages/,
  },
  {
    name: "Fast-to-Standard fallback remains visible on completed answer cards",
    source: ui,
    pattern:
      /getServiceTierMessageMeta[\s\S]*serviceTierFallback[\s\S]*Standard fallback/,
  },
  {
    name: "completed action cards preserve the model that actually ran",
    source: ui,
    pattern:
      /resolveLiveActionModelId\(serviceTier\?\.model, fallbackModel\)[\s\S]*actionModelIdsRef\.current\[actionId\] = currentModelRef\.current[\s\S]*getActionMessageMeta\(actionId, data\)/,
  },
  {
    name: "underdeveloped direct-question answers are treated as repairable",
    source: engine,
    pattern:
      /directQuestionWithEvidence[\s\S]*outputWords < 35[\s\S]*underdeveloped_interview_answer[\s\S]*hardReasons[\s\S]*underdeveloped_interview_answer[\s\S]*reason\.includes\('underdeveloped'\)/,
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
    name: "technical interview fallback answers common full-stack questions instead of echoing stale context",
    source: engine,
    pattern:
      /(?=[\s\S]*buildTechnicalInterviewFallbackAnswer)(?=[\s\S]*mouvement de stock)(?=[\s\S]*architecture backend)(?=[\s\S]*OAuth2\/OIDC)(?=[\s\S]*monolithe)(?=[\s\S]*microservices)(?=[\s\S]*goulot)(?=[\s\S]*Dockerfiles)(?=[\s\S]*revue de code)(?=[\s\S]*dette technique)(?=[\s\S]*pic massif)/,
  },
  {
    name: "generic repeat requests are treated as insufficient when reliable context exists",
    source: engine,
    pattern:
      /isInsufficientContextFallback[\s\S]*could you repeat[\s\S]*address your question properly/,
  },
  {
    name: "default clarify and follow-up outputs stay single-question while conference clarify remains explanatory",
    source: engine,
    pattern:
      /postProcessLiveActionOutput[\s\S]*sanitizeSingleQuestionOutput[\s\S]*sanitizeSingleQuestion: !conferenceExplanation[\s\S]*sanitizeSingleQuestion: true/,
  },
  {
    name: "live action outputs collapse duplicated model paragraphs before persistence",
    source: engine,
    pattern:
      /postProcessLiveActionOutput[\s\S]*collapseRepeatedLiveActionOutput[\s\S]*extractRepeatedHalf[\s\S]*sameSubstantialText/,
  },
  {
    name: "live action cards are correlated by actionId rather than intent",
    source: liveActionMessages,
    pattern:
      /findActionIndex[\s\S]*message\.actionId === actionId[\s\S]*finalizeStreamingMessage[\s\S]*actionStatus: status/,
  },
  {
    name: "late tokens cannot reopen completed failed or cancelled action cards",
    source: liveActionMessages,
    pattern:
      /appendStreamingMessage[\s\S]*actionStatus === 'completed'[\s\S]*actionStatus === 'failed'[\s\S]*actionStatus === 'cancelled'[\s\S]*return messages/,
  },
  {
    name: "actionId crosses engine events IPC payloads and renderer reducers",
    source: `${engine}\n${main}\n${preload}\n${ui}`,
    pattern:
      /resolvedActionId[\s\S]*suggested_answer[\s\S]*actionId[\s\S]*intelligence-suggested-answer[\s\S]*actionId[\s\S]*generateWhatToSay[\s\S]*actionId/,
  },
  {
    name: "superseded live actions emit a terminal cancellation",
    source: `${engine}\n${main}\n${preload}\n${ui}`,
    pattern:
      /action_cancelled[\s\S]*intelligence-action-cancelled[\s\S]*onIntelligenceActionCancelled[\s\S]*cancelActionMessage/,
  },
  {
    name: "clarify falls back from empty or generic unreliable answers",
    source: engine,
    pattern:
      /empty_live_action_output[\s\S]*buildLiveActionFallback\(action, packet\)[\s\S]*'CLARIFY'[\s\S]*sanitizeSingleQuestion: !conferenceExplanation/,
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
const chatWithGeminiBlock =
  llmHelper.match(/public async chatWithGemini[\s\S]*?Interview lock: automatic generation is intentionally restricted to Codex \+ Gemini/)?.[0] ||
  "";
const streamChatWithGeminiBlock =
  llmHelper.match(/public async \* streamChatWithGemini[\s\S]*?Codex-first temporary lock/)?.[0] ||
  "";
const recordOnlyBlock =
  main.match(/if \(!shouldFeedPassiveContext\) \{[\s\S]*?return;\s*\}/)?.[0] ||
  "";

if (
  !chatWithGeminiBlock ||
  /GROQ FAST TEXT OVERRIDE|this\.useOllama|this\.activeCurlProvider|this\.customProvider|currentModelId === 'natively'/.test(chatWithGeminiBlock)
) {
  failures.push({
    name: "non-streaming live chat path is locked to Codex/Gemini before fallback",
  });
}

if (!streamChatWithGeminiBlock || /this\.useOllama|streamWithNatively|streamWithGroq|streamWithCustom/.test(streamChatWithGeminiBlock)) {
  failures.push({
    name: "streaming live chat path is locked to Codex/Gemini before fallback",
  });
}

if (/Output exactly one short phrase/.test(packet)) {
  failures.push({
    name: "what-to-say packet prompt must not force exactly one short phrase",
  });
}

if (
  /Keep answers SHORT|under 30 seconds|2-3 sentences max|3-4 sentences max|Maximum 2-3 sentences|2-3 sentences total|At most ONE clarifying|exceeds 4-5 sentences/.test(prompts) ||
  /one phrase only|two short sentences/.test(orchestrator)
) {
  failures.push({
    name: "live prompts must not reintroduce hard tiny-answer caps",
  });
}

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
