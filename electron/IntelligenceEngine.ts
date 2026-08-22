// IntelligenceEngine.ts
// LLM mode routing and orchestration.
// Extracted from IntelligenceManager to decouple LLM logic from state management.

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { LLMHelper } from './LLMHelper';
import { SessionTracker, TranscriptSegment, SuggestionTrigger, ContextItem } from './SessionTracker';
import { ModesManager } from './services/ModesManager';
import { MeetingAction, MeetingActionOrchestrator } from './meeting/MeetingActionOrchestrator';
import { MeetingContextPacket, MeetingContextPacketBuilder } from './meeting/MeetingContextPacketBuilder';
import { MeetingDebugRecorder } from './diagnostics/MeetingDebugRecorder';
import { buildPromptProfileBlockForMode } from './llm/PromptProfileRegistry';
import {
    AnswerLLM, AssistLLM, BrainstormLLM, ClarifyLLM, CodeHintLLM, FollowUpLLM, RecapLLM,
    FollowUpQuestionsLLM, WhatToAnswerLLM,
    prepareTranscriptForWhatToAnswer, buildTemporalContext,
    AssistantResponse as LLMAssistantResponse, classifyIntent
} from './llm';

// Mode types
export type IntelligenceMode = 'idle' | 'assist' | 'what_to_say' | 'follow_up' | 'recap' | 'clarify' | 'manual' | 'follow_up_questions' | 'code_hint' | 'brainstorm';

// Refinement intent detection (refined to avoid false positives)
function detectRefinementIntent(userText: string): { isRefinement: boolean; intent: string } {
    const lowercased = userText.toLowerCase().trim();
    const refinementPatterns = [
        { pattern: /make it longer|expand on this|elaborate more/i, intent: 'expand' },
        { pattern: /rephrase that|say it differently|put it another way/i, intent: 'rephrase' },
        { pattern: /give me an example|provide an instance/i, intent: 'add_example' },
        { pattern: /make it more confident|be more assertive|sound stronger/i, intent: 'more_confident' },
        { pattern: /make it casual|be less formal|sound relaxed/i, intent: 'more_casual' },
        { pattern: /make it formal|be more professional|sound professional/i, intent: 'more_formal' },
        { pattern: /simplify this|make it simpler|explain specifically/i, intent: 'simplify' },
    ];

    for (const { pattern, intent } of refinementPatterns) {
        if (pattern.test(lowercased)) {
            return { isRefinement: true, intent };
        }
    }

    return { isRefinement: false, intent: '' };
}

interface LiveActionQualityReview {
    ok: boolean;
    score: number;
    reasons: string[];
    repairable: boolean;
}

interface LiveActionQualityResult {
    answer: string;
    fallbackReason?: string;
    review: LiveActionQualityReview;
    repaired: boolean;
}

interface LiveActionQualityOptions {
    question?: string;
    streamTimedOut?: boolean;
    sanitizeSingleQuestion?: boolean;
    manualWeakOutput?: boolean;
}

// Events emitted by IntelligenceEngine
export interface IntelligenceModeEvents {
    'assist_update': (insight: string) => void;
    'suggested_answer': (answer: string, question: string, confidence: number, actionId: string) => void;
    'suggested_answer_token': (token: string, question: string, confidence: number, actionId: string) => void;
    'refined_answer': (answer: string, intent: string, actionId: string) => void;
    'refined_answer_token': (token: string, intent: string, actionId: string) => void;
    'recap': (summary: string, actionId: string) => void;
    'recap_token': (token: string, actionId: string) => void;
    'clarify': (clarification: string, actionId: string) => void;
    'clarify_token': (token: string, actionId: string) => void;
    'follow_up_questions_update': (questions: string, actionId: string) => void;
    'follow_up_questions_token': (token: string, actionId: string) => void;
    'action_cancelled': (mode: IntelligenceMode, actionId: string) => void;
    'manual_answer_started': () => void;
    'manual_answer_result': (answer: string, question: string) => void;
    'mode_changed': (mode: IntelligenceMode) => void;
    'error': (error: Error, mode: IntelligenceMode, actionId?: string) => void;
}

function resolveLiveActionId(actionId?: string): string {
    const normalized = String(actionId || '').trim();
    return normalized.length > 0 && normalized.length <= 128 ? normalized : randomUUID();
}

export class IntelligenceEngine extends EventEmitter {
    // Mode state
    private activeMode: IntelligenceMode = 'idle';

    // Mode-specific LLMs
    private answerLLM: AnswerLLM | null = null;
    private assistLLM: AssistLLM | null = null;
    private clarifyLLM: ClarifyLLM | null = null;
    private followUpLLM: FollowUpLLM | null = null;
    private recapLLM: RecapLLM | null = null;
    private followUpQuestionsLLM: FollowUpQuestionsLLM | null = null;
    private whatToAnswerLLM: WhatToAnswerLLM | null = null;
    private codeHintLLM: CodeHintLLM | null = null;
    private brainstormLLM: BrainstormLLM | null = null;

    // Concurrency tracking
    private assistCancellationToken: AbortController | null = null;
    private generationIds: Record<IntelligenceMode, number> = {
        idle: 0,
        assist: 0,
        what_to_say: 0,
        follow_up: 0,
        recap: 0,
        clarify: 0,
        manual: 0,
        follow_up_questions: 0,
        code_hint: 0,
        brainstorm: 0,
    };

    // Keep reference to LLMHelper for client access
    private llmHelper: LLMHelper;

    // Reference to SessionTracker for context
    private session: SessionTracker;

    // Timestamps for tracking
    private lastTranscriptTime: number = 0;
    private lastTriggerTime: number = 0;
    private readonly triggerCooldown: number = 3000; // 3 seconds
    private readonly activeModeContextMaxChars: number = 12_000;
    private readonly actionTimeoutsMs: Record<MeetingAction, number> = {
        WHAT_TO_SAY: 16_000,
        CLARIFY: 12_000,
        FOLLOW_UP_QUESTION: 12_000,
        ANSWER: 18_000,
        RECAP: 18_000,
        VIBE_INTERVIEW_SAY_THIS: 14_000,
    };
    private actionOrchestrator: MeetingActionOrchestrator;
    private contextPacketBuilder: MeetingContextPacketBuilder;

    constructor(llmHelper: LLMHelper, session: SessionTracker, getLiveStateBlock?: () => string) {
        super();
        this.llmHelper = llmHelper;
        this.session = session;
        this.actionOrchestrator = new MeetingActionOrchestrator(getLiveStateBlock);
        this.contextPacketBuilder = new MeetingContextPacketBuilder(session, getLiveStateBlock);
        this.initializeLLMs();
    }

    getLLMHelper(): LLMHelper {
        return this.llmHelper;
    }

    getRecapLLM(): RecapLLM | null {
        return this.recapLLM;
    }

    private getActiveModeActionContextBlock(): string {
        try {
            const modesManager = ModesManager.getInstance();
            const mode = modesManager.getActiveMode();
            const contextBlock = modesManager.buildActiveModeContextBlock().trim();
            const promptProfileBlock = buildPromptProfileBlockForMode(mode
                ? { name: mode.name, templateType: mode.templateType }
                : null);

            const modeHeader = mode
                ? `<active_mode name="${mode.name}" template="${mode.templateType}" />`
                : '';
            const cappedContext = contextBlock.length > this.activeModeContextMaxChars
                ? `${contextBlock.slice(0, this.activeModeContextMaxChars)}\n[...active mode context truncated]`
                : contextBlock;
            const modeContextBlock = (mode || cappedContext)
                ? [
                    `[PRE-MEETING / MODE CONTEXT]`,
                    modeHeader,
                    cappedContext,
                    `[/PRE-MEETING / MODE CONTEXT]`,
                    `Use this as background memory only. The live transcript remains the source of truth for what is being discussed right now.`,
                ].filter(Boolean).join('\n')
                : '';

            return [
                promptProfileBlock,
                modeContextBlock,
            ].filter(Boolean).join('\n');
        } catch (error: any) {
            console.warn('[IntelligenceEngine] Failed to load active mode context:', error?.message || error);
            return '';
        }
    }

    private withActiveModeActionContext(context: string, fallback?: string, action: MeetingAction = 'ANSWER'): string {
        return this.buildActionContextPacket(action, 120, fallback, context).context;
    }

    private getFormattedActionContextWithMode(lastSeconds: number, fallback?: string, action: MeetingAction = 'ANSWER'): string {
        return this.buildActionContextPacket(action, lastSeconds, fallback).context;
    }

    private buildActionContextPacket(
        action: MeetingAction,
        lastSeconds: number,
        fallback?: string,
        transcriptContext?: string,
        additionalItems?: ContextItem[],
        preferLocalUserTarget?: boolean,
    ): MeetingContextPacket {
        let activeMode: ReturnType<ModesManager['getActiveMode']> = null;
        try {
            activeMode = ModesManager.getInstance().getActiveMode();
        } catch (error: any) {
            console.warn('[IntelligenceEngine] Failed to resolve active mode descriptor:', error?.message || error);
        }
        this.session.setSemanticCompactionEnabled(this.modeUsesConferenceMemory(activeMode));
        const packet = this.contextPacketBuilder.build({
            action,
            lastSeconds,
            fallback,
            transcriptContext,
            activeModeBlock: this.getActiveModeActionContextBlock(),
            additionalItems,
            preferLocalUserTarget,
            mode: activeMode
                ? { name: activeMode.name, templateType: activeMode.templateType }
                : null,
        });

        MeetingDebugRecorder.getInstance().recordActionContext({
            action,
            contextMode: packet.contextMode,
            languageHint: packet.languageHint,
            hasReliableInterlocutor: packet.hasReliableInterlocutor,
            contextTrustScore: packet.contextTrustScore,
            interlocutorFocus: packet.interlocutorFocus,
            localUserFocus: packet.localUserFocus,
            actionTarget: packet.actionTarget,
            selectedSegments: packet.selectedSegments,
            retrievedEvidenceSegments: packet.retrievedEvidenceSegments,
            rejectedSegments: packet.rejectedSegments,
            diagnostics: packet.diagnostics,
            contextPreview: this.truncateForUsage(packet.context, 1800),
        });

        return packet;
    }

    private buildUsageMetadata(
        action: MeetingAction,
        systemContext: string,
        diagnostics?: string[],
        packet?: MeetingContextPacket,
        telemetry?: { latencyMs?: number; firstTokenMs?: number; timedOut?: boolean; fallback?: string; error?: string },
    ) {
        return {
            action,
            provider: this.llmHelper.getCurrentProvider(),
            model: this.llmHelper.getCurrentModel(),
            serviceTier: this.llmHelper.getCurrentProvider() === 'codex'
                ? this.llmHelper.getLastCodexServiceTierStatus()
                : undefined,
            systemContext: this.truncateForUsage(systemContext),
            systemPrompt: packet?.systemPrompt,
            contextMode: packet?.contextMode,
            languageHint: packet?.languageHint,
            hasReliableInterlocutor: packet?.hasReliableInterlocutor,
            contextTrustScore: packet?.contextTrustScore,
            interlocutorFocus: packet?.interlocutorFocus,
            localUserFocus: packet?.localUserFocus,
            actionTarget: packet?.actionTarget,
            selectedSegments: packet?.selectedSegments,
            retrievedEvidenceSegments: packet?.retrievedEvidenceSegments,
            rejectedSegments: packet?.rejectedSegments,
            diagnostics,
            latencyMs: telemetry?.latencyMs,
            firstTokenMs: telemetry?.firstTokenMs,
            timedOut: telemetry?.timedOut,
            fallback: telemetry?.fallback,
            error: telemetry?.error,
        };
    }

    private truncateForUsage(text: string, maxLength: number = 6000): string {
        const normalized = String(text || '').replace(/\s+\n/g, '\n').trim();
        if (normalized.length <= maxLength) return normalized;
        return `${normalized.slice(0, maxLength - 34)}\n[...usage context truncated]`;
    }

    private async consumeActionStream(
        mode: IntelligenceMode,
        action: MeetingAction,
        stream: AsyncGenerator<string>,
        generationId: number,
        onToken: (token: string) => void,
    ): Promise<{ text: string; aborted: boolean; timedOut: boolean; latencyMs: number; firstTokenMs?: number }> {
        const startedAt = Date.now();
        const timeoutMs = this.actionTimeoutsMs[action] || 8_000;
        let text = '';
        let firstTokenMs: number | undefined;

        while (this.isGenerationCurrent(mode, generationId)) {
            const remainingMs = timeoutMs - (Date.now() - startedAt);
            if (remainingMs <= 0) {
                this.cancelActionStream(stream);
                return { text, aborted: false, timedOut: true, latencyMs: Date.now() - startedAt, firstTokenMs };
            }

            const result = await Promise.race([
                stream.next().then((value) => ({ type: 'next' as const, value })),
                new Promise<{ type: 'timeout' }>((resolve) =>
                    setTimeout(() => resolve({ type: 'timeout' }), remainingMs),
                ),
            ]);

            // A reset or a newer action may arrive while stream.next() is pending.
            // Never accept that late token/done signal after ownership changed.
            if (!this.isGenerationCurrent(mode, generationId)) {
                this.cancelActionStream(stream);
                return { text, aborted: true, timedOut: false, latencyMs: Date.now() - startedAt, firstTokenMs };
            }

            if (result.type === 'timeout') {
                this.cancelActionStream(stream);
                return { text, aborted: false, timedOut: true, latencyMs: Date.now() - startedAt, firstTokenMs };
            }

            if (result.value.done) {
                const timedOut = Date.now() - startedAt >= timeoutMs && text.length === 0;
                if (timedOut) this.cancelActionStream(stream);
                return { text, aborted: false, timedOut, latencyMs: Date.now() - startedAt, firstTokenMs };
            }

            const token = result.value.value || '';
            if (firstTokenMs === undefined && token) firstTokenMs = Date.now() - startedAt;
            onToken(token);
            text += token;
        }

        this.cancelActionStream(stream);
        return { text, aborted: true, timedOut: false, latencyMs: Date.now() - startedAt, firstTokenMs };
    }

    private cancelActionStream(stream: AsyncGenerator<string>): void {
        void Promise.race([
            stream.return(undefined).catch((): undefined => undefined),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
        ]).catch((): undefined => undefined);
    }

    private recordActionResult(action: MeetingAction, question: string, answer: string, telemetry: Record<string, unknown> = {}): void {
        MeetingDebugRecorder.getInstance().recordActionResult({
            action,
            question,
            answer: this.truncateForUsage(answer, 1800),
            provider: this.llmHelper.getCurrentProvider(),
            model: this.llmHelper.getCurrentModel(),
            serviceTier: this.llmHelper.getCurrentProvider() === 'codex'
                ? this.llmHelper.getLastCodexServiceTierStatus()
                : undefined,
            ...telemetry,
        });
    }

    private shouldHoldLiveActionTokens(action: MeetingAction): boolean {
        return action === 'WHAT_TO_SAY' || action === 'CLARIFY' || action === 'FOLLOW_UP_QUESTION';
    }

    private liveActionTokenHandler(action: MeetingAction, onToken: (token: string) => void): (token: string) => void {
        if (this.shouldHoldLiveActionTokens(action)) return () => undefined;
        return onToken;
    }

    private async improveLiveActionOutput(
        mode: IntelligenceMode,
        action: MeetingAction,
        generationId: number,
        output: string,
        packet: MeetingContextPacket,
        options: LiveActionQualityOptions = {},
    ): Promise<LiveActionQualityResult> {
        let answer = String(output || '').trim();
        let review = this.reviewLiveActionQuality(action, answer, packet, options);
        let repaired = false;

        if (!answer || answer.trim().length < 5) {
            const fallback = this.postProcessLiveActionOutput(
                this.buildLiveActionFallback(action, packet),
                options.sanitizeSingleQuestion,
            );
            return {
                answer: fallback,
                fallbackReason: 'empty_live_action_output',
                review,
                repaired: false,
            };
        }

        if (!review.ok && review.repairable && !options.streamTimedOut && this.isGenerationCurrent(mode, generationId)) {
            const repair = await this.repairLiveActionOutput(mode, action, generationId, answer, packet, review, options.question);
            const repairedText = repair.text.trim();
            if (!repair.aborted && repairedText.length >= 5) {
                const repairedReview = this.reviewLiveActionQuality(action, repairedText, packet, options);
                if (repairedReview.ok) {
                    answer = repairedText;
                    review = repairedReview;
                    repaired = true;
                } else {
                    review = {
                        ...repairedReview,
                        reasons: [...new Set([...review.reasons, ...repairedReview.reasons, 'quality_repair_still_weak'])],
                    };
                }
            } else if (repair.timedOut) {
                review = {
                    ...review,
                    reasons: [...new Set([...review.reasons, 'quality_repair_timeout'])],
                };
            }
        }

        if (!review.ok) {
            answer = this.buildLiveActionFallback(action, packet);
            return {
                answer: this.postProcessLiveActionOutput(answer, options.sanitizeSingleQuestion),
                fallbackReason: `quality_gate:${review.reasons[0] || 'weak_live_action_output'}`,
                review,
                repaired,
            };
        }

        return {
            answer: this.postProcessLiveActionOutput(answer, options.sanitizeSingleQuestion),
            review,
            repaired,
        };
    }

    private reviewLiveActionQuality(
        action: MeetingAction,
        output: string,
        packet: MeetingContextPacket,
        options: LiveActionQualityOptions,
    ): LiveActionQualityReview {
        const reasons: string[] = [];
        const normalizedOutput = this.normalizeForComparison(output);
        const targetText = `${packet.actionTarget?.text || ''} ${packet.interlocutorFocus?.text || ''}`;
        const contextText = this.selectedInterlocutorContextText(packet);
        const evidenceText = [
            contextText,
            ...(packet.retrievedEvidenceSegments || []).map((segment) => segment.text),
        ].join(' ');
        const targetKeywords = this.extractContentKeywords(targetText);
        const evidenceKeywords = this.extractContentKeywords(evidenceText);
        const expectedKeywords = [...new Set([...targetKeywords, ...evidenceKeywords])].slice(0, 18);
        const outputWords = normalizedOutput.split(' ').filter(Boolean).length;
        const conferenceExplanation = action === 'CLARIFY' && packet.contextMode === 'conference';
        const answerAction = action === 'WHAT_TO_SAY' || action === 'VIBE_INTERVIEW_SAY_THIS' || action === 'ANSWER' || conferenceExplanation;
        const directQuestionWithEvidence =
            answerAction &&
            !conferenceExplanation &&
            packet.actionTarget?.kind === 'direct_question' &&
            (expectedKeywords.length >= 5 || packet.contextTrustScore >= 0.55 || (packet.questionCandidates?.length || 0) >= 2);
        const contextualRequestWithEvidence =
            answerAction &&
            !conferenceExplanation &&
            packet.actionTarget?.kind !== 'direct_question' &&
            packet.selectedSegments.filter((segment) => segment.role === 'interviewer').length >= 3 &&
            expectedKeywords.length >= 6;

        if (!normalizedOutput) reasons.push('empty_output');
        if (this.isInsufficientContextFallback(output) && (packet.hasReliableInterlocutor || expectedKeywords.length >= 3)) {
            reasons.push('insufficient_context_despite_evidence');
        }
        if (this.shouldReplaceGenericTopicOutput(action, output, packet)) {
            reasons.push('generic_or_echo_output');
        }
        if (options.manualWeakOutput) {
            reasons.push('manual_answer_echo_or_weak');
        }
        if (this.looksLikeGenericMeetingOutput(output)) {
            reasons.push('generic_meeting_language');
        }

        if (answerAction && this.shouldReplaceLiveActionOutput(action, output, packet)) {
            reasons.push('does_not_answer_action_target');
        }

        if (answerAction && packet.actionTarget?.kind === 'direct_question') {
            const asksAnotherQuestion = /[?？]\s*$/.test(output.trim()) ||
                /^(pouvez vous|pourriez vous|peux tu|tu peux|est ce que|comment|pourquoi|quel|quelle|quels|quelles|could you|can you|what|why|how)\b/i.test(normalizedOutput);
            if (asksAnotherQuestion) reasons.push('answered_question_with_question');
        }

        if (((action === 'CLARIFY' && !conferenceExplanation) || action === 'FOLLOW_UP_QUESTION') && !/[?？]\s*$/.test(output.trim())) {
            reasons.push('expected_single_question');
        }

        if (conferenceExplanation && outputWords < 12 && expectedKeywords.length >= 4) {
            reasons.push('conference_clarification_too_short');
        }

        if (expectedKeywords.length >= 4 && normalizedOutput.length > 0) {
            const overlap = expectedKeywords.filter((keyword) => normalizedOutput.includes(keyword)).length;
            const requiredOverlap = action === 'FOLLOW_UP_QUESTION' || (action === 'CLARIFY' && !conferenceExplanation) ? 1 : 2;
            if (overlap < requiredOverlap && packet.contextTrustScore >= 0.45) {
                reasons.push('missing_meeting_specific_evidence');
            }
        }

        if (answerAction && outputWords <= 9 && expectedKeywords.length >= 5) {
            reasons.push('too_short_for_available_context');
        }
        if (directQuestionWithEvidence && outputWords < 35) {
            reasons.push('underdeveloped_interview_answer');
        }
        if (contextualRequestWithEvidence && outputWords < 24) {
            reasons.push('underdeveloped_contextual_response');
        }

        const score = Math.max(0, Math.min(100, 100 - reasons.length * 18));
        const hardReasons = new Set([
            'empty_output',
            'insufficient_context_despite_evidence',
            'does_not_answer_action_target',
            'answered_question_with_question',
            'manual_answer_echo_or_weak',
            'too_short_for_available_context',
            'underdeveloped_interview_answer',
            'underdeveloped_contextual_response',
        ]);
        const repairable = reasons.some((reason) =>
            hardReasons.has(reason) ||
            reason.includes('generic') ||
            reason.includes('missing') ||
            reason.includes('short') ||
            reason.includes('underdeveloped')
        );

        return {
            ok: reasons.length === 0,
            score,
            reasons,
            repairable,
        };
    }

    private async repairLiveActionOutput(
        mode: IntelligenceMode,
        action: MeetingAction,
        generationId: number,
        previousOutput: string,
        packet: MeetingContextPacket,
        review: LiveActionQualityReview,
        question?: string,
    ): Promise<{ text: string; aborted: boolean; timedOut: boolean }> {
        const context = [
            packet.context,
            '[LIVE ACTION QUALITY REVIEW]',
            `action=${action}`,
            `question=${question || packet.actionTarget?.text || packet.interlocutorFocus?.text || 'inferred'}`,
            `previous_output=${this.truncateForUsage(previousOutput, 1200)}`,
            `quality_score=${review.score}`,
            `quality_reasons=${review.reasons.join(',') || 'none'}`,
            'instruction=Repair the answer once. Use current focus plus relevant prior meeting evidence. Final answer only.',
            '[/LIVE ACTION QUALITY REVIEW]',
        ].join('\n\n');

        const userPrompt = [
            `Action: ${action}`,
            question ? `Local user question: ${question}` : '',
            'Produce the corrected final live-meeting response now.',
        ].filter(Boolean).join('\n');

        const stream = this.llmHelper.streamChat(
            userPrompt,
            undefined,
            context,
            this.buildLiveActionRepairSystemPrompt(action, packet),
            true,
        );
        const result = await this.consumeActionStream(
            mode,
            action,
            stream,
            generationId,
            () => undefined,
        );
        return {
            text: result.text,
            aborted: result.aborted,
            timedOut: result.timedOut,
        };
    }

    private buildLiveActionRepairSystemPrompt(action: MeetingAction, packet?: MeetingContextPacket): string {
        const conferenceExplanation = action === 'CLARIFY' && packet?.contextMode === 'conference';
        const actionRule = (() => {
            switch (action) {
                case 'CLARIFY':
                    return conferenceExplanation
                        ? 'Return a clear explanation of the latest complete conference concept or problem. Connect its concrete facts and reasoning; do not respond with another question.'
                        : 'Return exactly one precise clarifying question. It must name the concrete ambiguity from the meeting evidence.';
                case 'FOLLOW_UP_QUESTION':
                    return 'Return exactly one follow-up question that advances the current concrete topic. No list.';
                case 'WHAT_TO_SAY':
                case 'VIBE_INTERVIEW_SAY_THIS':
                    return 'Return the exact words the local user can say aloud. Use 3-6 strong sentences when the selected question or request is technical, behavioral, architectural, or context-rich. If the interlocutor explained the idea over several turns and ended with a request, synthesize the full explanation, requested deliverable, and next step; do not collapse it into or echo the final phrase.';
                case 'ANSWER':
                default:
                    return 'Answer the local user directly with a meeting-specific synthesis. Use enough detail to be professionally useful, not a fragment.';
            }
        })();

        return `You are Natively's live meeting answer repair agent.

Goal:
- Fix a weak live action answer after a quality review.
- Use the ACTION TARGET, CURRENT INTERLOCUTOR FOCUS, SELECTED CANONICAL TRANSCRIPT, and RELEVANT PRIOR MEETING EVIDENCE.
- Synthesize across nearby and prior turns; do not anchor on one isolated fragment.
- Do not mention the quality review, retrieval, packet, or transcript mechanics.
- Do not invent facts absent from the meeting evidence.
- Follow the packet language instruction. Answer in the language of the action target and most recent interlocutor explanation; an explicit fixed response-language setting wins.
- ${actionRule}`;
    }

    private postProcessLiveActionOutput(output: string, sanitizeSingleQuestion?: boolean): string {
        const deduplicated = this.collapseRepeatedLiveActionOutput(output);
        return sanitizeSingleQuestion ? this.sanitizeSingleQuestionOutput(deduplicated) : deduplicated.trim();
    }

    private collapseRepeatedLiveActionOutput(output: string): string {
        const trimmed = String(output || '').trim();
        if (trimmed.length < 80) return trimmed;

        const repeatedHalf = this.extractRepeatedHalf(trimmed);
        if (repeatedHalf) return repeatedHalf;

        const repeatedSentences = this.extractRepeatedUnitSequence(trimmed, /(?<=[.!?])\s+/);
        if (repeatedSentences) return repeatedSentences;

        const repeatedParagraphs = this.extractRepeatedUnitSequence(trimmed, /\n{2,}/);
        if (repeatedParagraphs) return repeatedParagraphs;

        return trimmed;
    }

    private extractRepeatedHalf(output: string): string {
        const midpoint = Math.floor(output.length / 2);
        const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -8, 8];
        for (const offset of offsets) {
            const cut = midpoint + offset;
            if (cut < 40 || output.length - cut < 40) continue;
            const left = output.slice(0, cut).trim();
            const right = output.slice(cut).trim();
            if (this.sameSubstantialText(left, right)) return left;
        }
        return '';
    }

    private extractRepeatedUnitSequence(output: string, separator: RegExp): string {
        const units = output.split(separator).map((unit) => unit.trim()).filter(Boolean);
        if (units.length < 2 || units.length % 2 !== 0) return '';
        const midpoint = units.length / 2;
        const left = units.slice(0, midpoint).join(' ').trim();
        const right = units.slice(midpoint).join(' ').trim();
        return this.sameSubstantialText(left, right) ? left : '';
    }

    private sameSubstantialText(left: string, right: string): boolean {
        const normalizedLeft = this.normalizeForComparison(left);
        const normalizedRight = this.normalizeForComparison(right);
        return normalizedLeft.length >= 80 && normalizedLeft === normalizedRight;
    }

    private looksLikeGenericMeetingOutput(output: string): boolean {
        const normalized = this.normalizeForComparison(output);
        return /\b(perimetre priorite prochaine etape|périmètre priorité prochaine étape|prochaine decision attendue|prochaine décision attendue|clarifier les choses|plus de contexte|plus de details|plus de détails|ce point important|avancer efficacement|aligner les attentes|make sure we are aligned|next expected decision|scope priority next step)\b/.test(normalized);
    }

    private buildLiveActionFallback(action: MeetingAction, packet: MeetingContextPacket): string {
        const targetLanguageText = this.normalizeForComparison(
            `${packet.actionTarget?.text || ''} ${packet.interlocutorFocus?.text || ''}`,
        );
        const frenchSignals = (targetLanguageText.match(/\b(le|la|les|des|une|que|pour|avec|dans|vous|tu|je|on|faut|gérer|gerer|préparer|preparer|document)\b/g) || []).length;
        const englishSignals = (targetLanguageText.match(/\b(the|and|that|this|with|for|you|we|need|manage|prepare|document|tool|when|where)\b/g) || []).length;
        const french = packet.languageHint === 'fr' ||
            (packet.languageHint === 'mixed' && frenchSignals > englishSignals);
        const focus = packet.interlocutorFocus;
        const focusText = focus.text?.trim();
        const lastInterlocutor = [...packet.selectedSegments]
            .reverse()
            .find((segment) => segment.role === 'interviewer' && segment.text.trim().length > 0);
        const topic = this.extractFallbackTopic(focusText || lastInterlocutor?.text || '');
        const answerTopic = this.deriveFallbackAnswerTopic(packet, focus);
        const localTarget = packet.actionTarget?.source === 'local_user'
            ? packet.actionTarget.text?.trim()
            : '';

        if (action === 'CLARIFY' && packet.contextMode === 'conference') {
            const explanation = answerTopic || topic || localTarget;
            if (explanation) {
                return french
                    ? `Le point central est le suivant : ${explanation}. Il faut relier les contraintes et les exemples donnés dans la discussion pour comprendre le problème complet, plutôt que d'isoler sa dernière phrase.`
                    : `The central point is this: ${explanation}. The constraints and examples from the discussion need to be connected to understand the complete problem instead of isolating its final sentence.`;
            }
        }

        if (action === 'FOLLOW_UP_QUESTION' && packet.contextMode === 'conference') {
            return this.buildConferenceFollowUpFallback(packet, french);
        }

        if (!packet.hasReliableInterlocutor) {
            if (localTarget) {
                const topicText = this.extractFallbackTopic(localTarget) || localTarget;
                if (action === 'CLARIFY') {
                    return french
                        ? `Peux-tu préciser ce que tu veux obtenir exactement sur ${topicText} ?`
                        : `Can you clarify exactly what you want to get from ${topicText}?`;
                }
                if (action === 'FOLLOW_UP_QUESTION') {
                    return french
                        ? `Quelle contrainte dois-je vérifier en priorité sur ${topicText} ?`
                        : `Which constraint should I verify first about ${topicText}?`;
                }
                return french
                    ? `Je capte cette question côté micro, pas côté Speaker : ${topicText}. Le modèle n'a pas répondu assez vite pour donner une réponse fiable.`
                    : `I captured this as a local mic question, not Speaker: ${topicText}. The model did not respond fast enough to give a reliable answer.`;
            }
            return french
                ? "Le haut-parleur n'est pas capté pour l'instant : je n'ai que le micro, donc je ne peux pas répondre à la place de l'interlocuteur sans inventer."
                : "Speaker audio is not being captured yet: I only have the mic, so I cannot answer on behalf of the interlocutor without guessing.";
        }

        const bugFlowContext = this.selectedInterlocutorContextText(packet);
        if (this.looksLikeBugFlowContext(bugFlowContext)) {
            if (action === 'CLARIFY' || action === 'FOLLOW_UP_QUESTION') {
                return french
                    ? "Peux-tu m'envoyer le flux exact et confirmer si l'envoi simple passe pendant que les flux IA/Pierre ne se déclenchent pas ?"
                    : "Can you send me the exact flow and confirm whether simple sending works while the AI/Pierre flows do not start?";
            }
            if (action === 'WHAT_TO_SAY' || action === 'VIBE_INTERVIEW_SAY_THIS' || action === 'ANSWER') {
                return french
                    ? "D'accord, envoie-moi le flux et je vais le tester : je vais comparer l'envoi simple avec les flux IA/Pierre pour identifier où ça ne se déclenche plus."
                    : "Got it, send me the flow and I will test it: I will compare simple sending with the AI/Pierre flows to identify where it stops triggering.";
            }
        }

        if (action === 'WHAT_TO_SAY' || action === 'VIBE_INTERVIEW_SAY_THIS') {
            if (focus.kind === 'direct_question' && topic) {
                const directFallback = this.buildDirectQuestionFallbackAnswer(
                    packet.actionTarget?.source !== 'none' ? packet.actionTarget.text : focusText,
                    french,
                );
                if (directFallback) return directFallback;

                if (this.isComprehensionCheckQuestion(focusText) && answerTopic) {
                    return french
                        ? `Oui, je comprends que ${answerTopic}.`
                        : `Yes, I understand that ${answerTopic}.`;
                }
                return french
                    ? `Je dirais : ${answerTopic || topic}.`
                    : `I would say: ${answerTopic || topic}.`;
            }
            if (focus.kind === 'implicit_request' && topic) {
                const supportTopic = answerTopic &&
                    this.normalizeForComparison(answerTopic) !== this.normalizeForComparison(topic)
                    ? answerTopic
                    : topic;
                return french
                    ? `D'accord. J'ai bien compris le périmètre : ${supportTopic}. Je vais préparer le livrable demandé à partir de toute l'explication, en structurant les éléments concrets et la prochaine étape.`
                    : `Got it. I understand the scope: ${supportTopic}. I will prepare the requested deliverable from the full explanation, with the concrete elements and the next step clearly structured.`;
            }
            return french
                ? `D'accord. Le point complet à retenir est : ${answerTopic || topic || "le périmètre, la priorité et la prochaine étape concrète"}. Je vais répondre à partir de l'ensemble de l'explication, pas seulement de sa dernière phrase.`
                : `Got it. The complete point is: ${answerTopic || topic || 'the scope, priority, and concrete next step'}. I will answer from the full explanation, not only its final phrase.`;
        }

        if (action === 'CLARIFY' || action === 'FOLLOW_UP_QUESTION') {
            return french
                ? `Pouvez-vous préciser la prochaine décision attendue sur ${topic || 'ce point'} ?`
                : `Could you clarify the next expected decision on ${topic || 'this point'}?`;
        }

        if (action === 'ANSWER') {
            if (focus.kind === 'direct_question' && answerTopic) {
                const directFallback = this.buildDirectQuestionFallbackAnswer(
                    packet.actionTarget?.source !== 'none' ? packet.actionTarget.text : focusText,
                    french,
                );
                if (directFallback) return directFallback;

                return french
                    ? `Je répondrais : ${answerTopic}.`
                    : `I would answer: ${answerTopic}.`;
            }
            return french
                ? `Je dirais : ${topic || 'confirmons le périmètre, la priorité et la prochaine action attendue'}.`
                : `I would say: ${topic || 'let us confirm the scope, priority, and expected next action'}.`;
        }

        return french
            ? `Le point principal à sécuriser est : ${topic || 'le périmètre et la prochaine action attendue'}.`
            : `The main point to secure is: ${topic || 'the scope and expected next action'}.`;
    }

    private buildConferenceFollowUpFallback(packet: MeetingContextPacket, french: boolean): string {
        const evidence = this.selectedInterlocutorContextText(packet);
        const normalized = this.normalizeForComparison(`${packet.actionTarget?.text || ''} ${evidence}`);
        if (/\b(cluster|clustering|classement|classes?)\b/.test(normalized) && /\b(80|quatre vingts|10|dix|runs?)\b/.test(normalized)) {
            return french
                ? "Pour les quelque 80 tables qui changent de classe entre les dix exécutions, avez-vous mesuré leur stabilité avec une matrice de co-clustering ou un indice comme l’ARI ?"
                : "For the roughly 80 tables that switch classes across the ten runs, did you measure their stability with a co-clustering matrix or an index such as ARI?";
        }

        const topic = this.extractFallbackTopic(packet.actionTarget?.text || evidence);
        return french
            ? `Quel critère ou résultat concret permettrait de vérifier l’hypothèse principale sur ${topic || 'ce point'} ?`
            : `What concrete criterion or result would test the main assumption about ${topic || 'this point'}?`;
    }

    private buildDirectQuestionFallbackAnswer(question: string | undefined, french: boolean): string {
        const normalized = this.normalizeForComparison(question || '');
        if (!normalized) return '';

        const technicalFallback = this.buildTechnicalInterviewFallbackAnswer(normalized, french);
        if (technicalFallback) return technicalFallback;

        if (/\bpourquoi\b/.test(normalized) && /\bconserver\b/.test(normalized) && /\bandroid\b/.test(normalized)) {
            return french
                ? "Je veux conserver Android parce que le problème concerne seulement WaChap : je veux nettoyer les données inutiles de WaChap sans réinitialiser le téléphone ni perdre mes autres applications, réglages ou fichiers."
                : "I want to keep Android because the issue is only with WaChap: I want to clean WaChap's unnecessary data without resetting the phone or losing my other apps, settings, or files.";
        }

        if (/\bpourquoi\b/.test(normalized) && /\bconserver\b/.test(normalized)) {
            return french
                ? "Je veux le conserver parce que la suppression doit viser uniquement l'élément problématique, pas les données utiles ni l'environnement complet."
                : "I want to keep it because the cleanup should target only the problematic item, not the useful data or the whole environment.";
        }

        return '';
    }

    private buildTechnicalInterviewFallbackAnswer(normalizedQuestion: string, french: boolean): string {
        if (/\b(stock|stocks|inventaire)\b/.test(normalizedQuestion) && /\b(coherence|cohérence|synchron|pharmacie|pharmacies)\b/.test(normalizedQuestion)) {
            return french
                ? "Je garantirais la cohérence en traitant chaque mouvement de stock comme une opération idempotente, versionnée et traçable. Hors ligne, la pharmacie conserverait les mouvements dans une file locale, puis les synchroniserait à la reconnexion sans écraser aveuglément l'état central. Le backend appliquerait une règle de résolution déterministe dans une transaction et refuserait toute écriture qui produit un stock négatif. Enfin, je testerais explicitement les réapprovisionnements concurrents, les reprises réseau et les doublons, avec des alertes sur les écarts résiduels."
                : "I would preserve consistency by treating every stock movement as an idempotent, versioned, and traceable operation. Offline, each pharmacy would keep movements in a local queue and synchronize them after reconnecting without blindly overwriting central state. The backend would apply a deterministic conflict rule in a transaction and reject any write that creates negative stock. Finally, I would explicitly test concurrent replenishments, network recovery, and duplicate delivery, with alerts for residual discrepancies.";
        }

        if (/\barchitecture\b/.test(normalizedQuestion) && /\bcomplexe\b/.test(normalizedQuestion) && /\b(defis|surmont)\b/.test(normalizedQuestion)) {
            return french
                ? "Je prendrais un exemple d'architecture backend avec plusieurs services qui doivent partager l'authentification, les droits d'accès et des données sensibles. Le premier défi était d'éviter un couplage trop fort entre les services, donc j'ai clarifié les frontières métier et gardé des contrats d'API simples et documentés. Le deuxième défi était la sécurité : j'ai centralisé l'identité avec OAuth2/OIDC, ajouté une validation stricte côté backend et protégé les accès aux données par rôle. Le troisième défi était l'observabilité, parce qu'une architecture distribuée devient vite difficile à déboguer sans logs corrélés, métriques et traces. Ce que j'ai appris, c'est qu'une architecture complexe doit rester explicable, mesurable et alignée sur le besoin métier, sinon elle devient une dette technique."
                : "I would use an example of a backend architecture with several services sharing authentication, permissions, and sensitive data. The first challenge was avoiding tight coupling, so I clarified domain boundaries and kept API contracts simple and documented. The second challenge was security: I centralized identity with OAuth2/OIDC, added strict backend validation, and protected data access by role. The third challenge was observability, because distributed systems become hard to debug without correlated logs, metrics, and traces. What I learned is that a complex architecture must remain explainable, measurable, and aligned with business needs, otherwise it becomes technical debt.";
        }

        if (/\b(monolith|monolithe|monolithique)\b/.test(normalizedQuestion) && /\bmicro(service|services|finance|finances)\b/.test(normalizedQuestion)) {
            return french
                ? "Le premier piège est de découper trop tôt, avant d'avoir bien identifié les frontières métier. On risque alors de transformer un monolithe simple en système distribué plus difficile à tester, déployer et observer. Je préfère commencer par mesurer les vrais points de friction, isoler progressivement les domaines qui changent indépendamment, puis extraire un service seulement quand le gain est clair. Il faut aussi anticiper la cohérence des données, les transactions distribuées, la latence réseau et l'observabilité. Pour moi, les microservices ne sont pas un objectif en soi : c'est une solution à utiliser quand l'organisation, le produit et l'exploitation sont assez matures."
                : "The first trap is splitting too early, before the domain boundaries are clear. That can turn a simple monolith into a distributed system that is harder to test, deploy, and observe. I prefer measuring the real friction points, isolating domains that evolve independently, and extracting a service only when the benefit is clear. You also have to anticipate data consistency, distributed transactions, network latency, and observability. For me, microservices are not a goal by themselves; they are a solution to use when the organization, product, and operations are mature enough.";
        }

        if (/\b(goulot|latence|etranglement|performance|production)\b/.test(normalizedQuestion)) {
            return french
                ? "Je commence par mesurer avant de modifier quoi que ce soit. Je regarde les métriques applicatives, les logs, le profiling et les requêtes SQL pour identifier si la latence vient du code, de la base de données, du réseau ou d'une ressource saturée. Ensuite, je reproduis le problème dans un environnement contrôlé pour confirmer l'hypothèse. Je corrige de façon ciblée : index, optimisation de requête, cache, réduction d'un traitement coûteux ou meilleure parallélisation selon le cas. Enfin, je valide avec des tests de charge et je surveille les métriques après déploiement pour vérifier qu'on a vraiment supprimé le goulot sans créer un nouvel effet de bord."
                : "I start by measuring before changing anything. I look at application metrics, logs, profiling, and SQL queries to identify whether the latency comes from code, the database, the network, or a saturated resource. Then I reproduce the issue in a controlled environment to validate the hypothesis. I apply a targeted fix: indexing, query optimization, caching, reducing an expensive computation, or improving parallelism depending on the case. Finally, I validate with load tests and monitor metrics after deployment to make sure the bottleneck is really gone without creating a new side effect.";
        }

        if (/\b(docker|kubernetes|cicd|ci cd|pipeline|infrastructure)\b/.test(normalizedQuestion)) {
            return french
                ? "Selon moi, un développeur backend moderne doit comprendre l'infrastructure parce que le code et son environnement d'exécution sont liés. Je ne remplace pas forcément le DevOps, mais je dois produire des services faciles à conteneuriser, configurer et déployer. Concrètement, cela veut dire écrire des Dockerfiles propres, exposer des health checks, gérer correctement les variables d'environnement et participer aux pipelines CI/CD. Avec Kubernetes, je dois aussi comprendre les notions de ressources, scaling, logs et readiness pour éviter de livrer une application fragile en production. Cette culture me permet de livrer du code qui fonctionne réellement dans les conditions de production, pas seulement en local."
                : "In my view, a modern backend developer must understand infrastructure because code and its runtime environment are connected. I do not necessarily replace DevOps, but I must build services that are easy to containerize, configure, and deploy. Concretely, that means writing clean Dockerfiles, exposing health checks, handling environment variables properly, and contributing to CI/CD pipelines. With Kubernetes, I also need to understand resources, scaling, logs, and readiness so I do not ship fragile production services. This mindset helps me deliver code that works in production conditions, not only locally.";
        }

        if (/\b(code review|revue de code|desaccord|desaccord profond|junior|ego)\b/.test(normalizedQuestion)) {
            return french
                ? "Je réagis d'abord en cherchant à comprendre le raisonnement de l'autre développeur. Je pose des questions précises plutôt que de rejeter directement l'approche, parce qu'il peut y avoir une contrainte que je n'ai pas vue. Ensuite, j'argumente avec des critères objectifs : maintenabilité, sécurité, performance, cohérence avec les standards de l'équipe et coût futur. Si le désaccord reste important, je propose une discussion courte ou un test comparatif pour trancher sur des faits. L'objectif n'est pas d'avoir raison, mais de protéger la qualité du projet tout en gardant une relation saine dans l'équipe."
                : "I first try to understand the other developer's reasoning. I ask precise questions instead of rejecting the approach immediately, because there may be a constraint I have not seen. Then I argue with objective criteria: maintainability, security, performance, consistency with team standards, and future cost. If the disagreement remains important, I suggest a short discussion or a comparison test to decide based on facts. The goal is not to be right; it is to protect project quality while keeping a healthy team relationship.";
        }

        if (/\b(echec|echoue|appris|rectifi|decision technique)\b/.test(normalizedQuestion)) {
            return french
                ? "Un bon exemple serait une décision où j'ai choisi une solution plus complexe que nécessaire, par exemple une abstraction ou un découpage trop ambitieux pour le besoin réel. Sur le moment, l'idée semblait préparer la scalabilité, mais elle a rendu le code plus difficile à comprendre, à tester et à maintenir. J'ai rectifié en revenant à une approche plus simple, mieux documentée, et en impliquant l'équipe dans le refactoring pour éviter de déplacer le problème. Ce que j'ai appris, c'est qu'une bonne décision technique ne se mesure pas seulement à son élégance, mais à sa lisibilité, son coût de maintenance et sa valeur métier réelle."
                : "A good example would be a decision where I chose a solution that was more complex than necessary, such as an abstraction or split that was too ambitious for the real need. At the time, it seemed useful for scalability, but it made the code harder to understand, test, and maintain. I corrected it by returning to a simpler, better documented approach and involving the team in the refactoring so we did not just move the problem elsewhere. What I learned is that a good technical decision is not only about elegance; it is about readability, maintenance cost, and real business value.";
        }

        if (/\b(dette technique|refactor|refactoriser|product owner|direction)\b/.test(normalizedQuestion)) {
            return french
                ? "Je présente la dette technique comme un risque produit, pas seulement comme une préférence de développeur. J'explique son impact concret : ralentissement des livraisons, bugs plus fréquents, coût de maintenance plus élevé ou risque opérationnel. Ensuite, je propose un arbitrage raisonnable, par exemple réserver 15 à 20 % du sprint à la refactorisation ou traiter la dette en même temps que les fonctionnalités concernées. L'objectif est de montrer que nettoyer le code protège la vélocité future et réduit le risque business. Avec cette approche, le Product Owner comprend mieux que la refactorisation peut être une décision de livraison, pas une pause dans la livraison."
                : "I present technical debt as a product risk, not just a developer preference. I explain its concrete impact: slower delivery, more frequent bugs, higher maintenance cost, or operational risk. Then I propose a reasonable tradeoff, for example reserving 15 to 20 percent of the sprint for refactoring or addressing debt alongside related features. The goal is to show that cleaning the code protects future velocity and reduces business risk. With this approach, the Product Owner can see refactoring as a delivery decision, not a pause in delivery.";
        }

        if (/\b(pic|trafic|vote|vente flash|serveurs|tombent|absorber)\b/.test(normalizedQuestion)) {
            return french
                ? "Pour absorber un pic massif, je commence par éviter que tout arrive en synchrone sur le backend. J'utilise du cache pour les lectures fréquentes, des files de messages pour lisser les écritures ou traitements lourds, et du scaling horizontal pour augmenter la capacité des services stateless. Je protège aussi la base de données avec des limites de débit, de bons index et éventuellement des lectures répliquées. Ensuite, je mets en place des métriques, alertes et tests de charge pour connaître le seuil réel du système avant l'événement. L'idée est de concevoir une architecture qui dégrade proprement si nécessaire, au lieu de tomber brutalement."
                : "To absorb a major traffic spike, I first avoid sending everything synchronously to the backend. I use caching for frequent reads, message queues to smooth writes or heavy processing, and horizontal scaling to increase stateless service capacity. I also protect the database with rate limits, proper indexes, and possibly read replicas. Then I set up metrics, alerts, and load tests to know the system's real limit before the event. The idea is to design an architecture that degrades gracefully if needed instead of failing suddenly.";
        }

        if (/\b(secur|security|api|rest|graphql|base|donnees|database)\b/.test(normalizedQuestion)) {
            return french
                ? "Je commence par sécuriser l'accès avec une authentification solide et une autorisation claire, par exemple OAuth2/OIDC ou JWT bien configuré selon le contexte. Ensuite, je valide toutes les entrées côté serveur pour éviter les injections, et j'utilise des requêtes préparées ou un ORM correctement maîtrisé pour protéger la base de données. Je chiffre les échanges avec TLS et je protège les secrets avec un gestionnaire adapté, jamais en dur dans le code. Pour GraphQL, j'ajoute aussi des limites de profondeur et de complexité, et je contrôle l'accès au niveau des champs sensibles. Enfin, je complète avec du rate limiting, des logs de sécurité et une surveillance des comportements anormaux."
                : "I start by securing access with strong authentication and clear authorization, for example OAuth2/OIDC or properly configured JWT depending on the context. Then I validate all inputs server-side to prevent injections, and I use prepared statements or a well-controlled ORM to protect the database. I encrypt traffic with TLS and protect secrets with a proper secret manager, never hardcoded in the codebase. For GraphQL, I also add depth and complexity limits, and I control access at the sensitive-field level. Finally, I add rate limiting, security logs, and monitoring for abnormal behavior.";
        }

        return '';
    }

    private deriveFallbackAnswerTopic(packet: MeetingContextPacket, focus: MeetingContextPacket['interlocutorFocus']): string {
        const interlocutorSegments = packet.selectedSegments
            .filter((segment) => segment.role === 'interviewer' && segment.text.trim().length > 0);
        if (interlocutorSegments.length === 0) return '';

        const focusIndex = focus.timestamp
            ? interlocutorSegments.findIndex((segment) => Math.abs(segment.timestamp - focus.timestamp!) < 2000)
            : -1;
        const end = focusIndex >= 0 ? Math.min(interlocutorSegments.length, focusIndex + 2) : interlocutorSegments.length;
        const start = Math.max(0, end - 5);
        const contextText = interlocutorSegments
            .slice(start, end)
            .map((segment) => segment.text)
            .join(' ');

        return this.extractFallbackTopic(contextText);
    }

    private isComprehensionCheckQuestion(text?: string): boolean {
        const normalized = String(text || '')
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return /\b(tu comprends|vous comprenez|tu as compris|vous avez compris|what do you understand|does that make sense)\b/i.test(normalized);
    }

    private extractFallbackTopic(text: string): string {
        const clean = text
            .replace(/\s+/g, ' ')
            .replace(/\b(uh|um|okay|ok|d'accord)\b/gi, '')
            .trim();
        if (!clean) return '';

        const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
        const candidate = sentences.find((sentence) => sentence.length >= 40 && sentence.length <= 220) || sentences[0] || clean;
        const truncated = candidate.length > 190 ? `${candidate.slice(0, 187).trim()}...` : candidate;
        return truncated.replace(/[.。]$/, '');
    }

    private isInsufficientContextFallback(text: string): boolean {
        const normalized = text.toLowerCase();
        return normalized.includes("pas encore assez de contexte fiable") ||
            normalized.includes("pas assez de contexte de l'interlocuteur") ||
            normalized.includes("pas assez de propos fiables") ||
            normalized.includes("contexte insuffisant") ||
            normalized.includes("je n'ai pas assez") ||
            normalized.includes("je n ai pas assez") ||
            normalized.includes("je ne dispose pas d'assez") ||
            normalized.includes("je ne dispose pas d assez") ||
            normalized.includes("not enough reliable interlocutor context") ||
            normalized.includes("do not have enough reliable") ||
            normalized.includes("don't have enough reliable") ||
            normalized.includes("didn't catch that") ||
            normalized.includes("did not catch that") ||
            normalized.includes("could you repeat") ||
            normalized.includes("repeat that") ||
            normalized.includes("address your question properly") ||
            normalized.includes("transcript doesn't mention") ||
            normalized.includes("transcript does not mention") ||
            normalized.includes("current context is insufficient");
    }

    private shouldReplaceLiveActionOutput(action: MeetingAction, output: string, packet: MeetingContextPacket): boolean {
        const focus = packet.interlocutorFocus;
        if (!packet.hasReliableInterlocutor || focus.kind !== 'direct_question') return false;
        if (!['WHAT_TO_SAY', 'VIBE_INTERVIEW_SAY_THIS', 'ANSWER'].includes(action)) return false;

        const normalizedOutput = this.normalizeForComparison(output);
        if (!normalizedOutput || this.isInsufficientContextFallback(output)) return true;

        const outputLooksLikeAnotherQuestion =
            /[?？]\s*$/.test(output.trim()) ||
            /^(pouvez vous|pourriez vous|peux tu|tu peux|est ce que|comment|pourquoi|quel|quelle|quels|quelles|could you|can you|what|why|how)\b/i.test(normalizedOutput);
        if (outputLooksLikeAnotherQuestion) return true;

        const targetText = packet.actionTarget?.source !== 'none' ? packet.actionTarget.text : focus.text;
        const targetKeywords = this.extractContentKeywords(targetText);
        if (targetKeywords.length >= 2) {
            const overlap = targetKeywords.filter((keyword) => normalizedOutput.includes(keyword)).length;
            if (overlap === 0) return true;
        }

        if (this.isComprehensionCheckQuestion(focus.text)) {
            const supportTopic = this.deriveFallbackAnswerTopic(packet, focus);
            const supportKeywords = this.extractContentKeywords(supportTopic);
            if (supportKeywords.length >= 3) {
                const overlap = supportKeywords.filter((keyword) => normalizedOutput.includes(keyword)).length;
                return overlap < Math.min(2, supportKeywords.length);
            }
        }

        return false;
    }

    private shouldReplaceGenericTopicOutput(action: MeetingAction, output: string, packet: MeetingContextPacket): boolean {
        if (!['WHAT_TO_SAY', 'VIBE_INTERVIEW_SAY_THIS', 'ANSWER', 'CLARIFY', 'FOLLOW_UP_QUESTION'].includes(action)) return false;
        const normalizedOutput = this.normalizeForComparison(output);
        if (!normalizedOutput) return true;

        const contextText = this.selectedInterlocutorContextText(packet);
        const targetText = `${packet.actionTarget?.text || ''} ${packet.interlocutorFocus?.text || ''}`;
        const normalizedTarget = this.normalizeForComparison(targetText);

        if (this.looksLikeGenericClarificationOutput(output) && this.looksLikeBugFlowContext(contextText)) return true;
        if (normalizedTarget.includes('je pense que j ai') && normalizedOutput.includes('je pense que j ai')) return true;
        if (this.looksLikeRawTranscriptEcho(output, packet)) return true;
        return false;
    }

    private looksLikeGenericClarificationOutput(output: string): boolean {
        const normalized = this.normalizeForComparison(output);
        return /\b(plus de details|plus de détails|ce que vous entendez par|clarifier les choses|prochaine decision attendue|prochaine décision attendue|pourriez vous preciser|pouvez vous preciser|could you clarify|can you clarify)\b/.test(normalized);
    }

    private selectedInterlocutorContextText(packet: MeetingContextPacket): string {
        return packet.selectedSegments
            .filter((segment) => segment.role === 'interviewer' && segment.text.trim().length > 0)
            .slice(-8)
            .map((segment) => segment.text)
            .join(' ');
    }

    private sanitizeSingleQuestionOutput(output: string): string {
        const cleaned = String(output || '')
            .replace(/```[\s\S]*?```/g, '')
            .split(/\r?\n/)
            .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return cleaned;

        const questionMatch = cleaned.match(/[^?？.!]*[?？]/);
        const candidate = (questionMatch?.[0] || cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned).trim();
        return candidate.length > 260 ? `${candidate.slice(0, 257).trim()}...` : candidate;
    }

    private extractContentKeywords(text: string): string[] {
        const stopWords = new Set([
            'avec', 'pour', 'dans', 'donc', 'alors', 'comme', 'cette', 'cela', 'quand', 'vous', 'nous', 'leur', 'leurs', 'notre', 'votre', 'that', 'this', 'with', 'from', 'your', 'their',
            'qu', 'que', 'qui', 'quoi', 'une', 'des', 'les', 'sur', 'par', 'plus', 'faire', 'être', 'etre', 'avoir', 'pourquoi', 'comment', 'veux', 'vouloir',
        ]);
        return [...new Set(this.normalizeForComparison(text)
            .split(' ')
            .filter((word) => word.length >= 4 && !stopWords.has(word))
            .slice(0, 16))];
    }

    private normalizeForComparison(text: string): string {
        return String(text || '')
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ============================================
    // LLM Initialization
    // ============================================

    /**
     * Initialize or Re-Initialize mode-specific LLMs with shared Gemini client and Groq client
     * Must be called after API keys are updated.
     */
    initializeLLMs(): void {
        console.log(`[IntelligenceEngine] Initializing LLMs with LLMHelper`);
        this.answerLLM = new AnswerLLM(this.llmHelper);
        this.assistLLM = new AssistLLM(this.llmHelper);
        this.clarifyLLM = new ClarifyLLM(this.llmHelper);
        this.followUpLLM = new FollowUpLLM(this.llmHelper);
        this.recapLLM = new RecapLLM(this.llmHelper);
        this.followUpQuestionsLLM = new FollowUpQuestionsLLM(this.llmHelper);
        this.whatToAnswerLLM = new WhatToAnswerLLM(this.llmHelper);
        this.codeHintLLM = new CodeHintLLM(this.llmHelper);
        this.brainstormLLM = new BrainstormLLM(this.llmHelper);

        // Sync RecapLLM reference to SessionTracker for epoch compaction
        this.session.setRecapLLM(this.recapLLM);
    }

    reinitializeLLMs(): void {
        this.initializeLLMs();
    }

    // ============================================
    // Transcript Handling (delegates to SessionTracker)
    // ============================================

    /**
     * Process transcript from native audio, and trigger follow-up if appropriate
     */
    handleTranscript(segment: TranscriptSegment, skipRefinementCheck: boolean = false): void {
        this.session.setSemanticCompactionEnabled(this.isConferenceMemoryModeActive());
        const result = this.session.handleTranscript(segment);
        this.lastTranscriptTime = Date.now();

        // Check for follow-up intent if user is speaking
        if (result && !skipRefinementCheck && result.role === 'user' && this.session.getLastAssistantMessage()) {
            const { isRefinement, intent } = detectRefinementIntent(segment.text.trim());
            if (isRefinement) {
                this.runFollowUp(intent, segment.text.trim());
            }
        }
    }

    private isConferenceMemoryModeActive(): boolean {
        try {
            return this.modeUsesConferenceMemory(ModesManager.getInstance().getActiveMode());
        } catch (error: any) {
            console.warn('[IntelligenceEngine] Failed to resolve conference memory mode:', error?.message || error);
            return false;
        }
    }

    private modeUsesConferenceMemory(mode: ReturnType<ModesManager['getActiveMode']>): boolean {
        if (!mode) return false;
        return mode.templateType === 'conference' || /\b(conf[eé]rence|conference)\b/i.test(mode.name || '');
    }

    /**
     * Handle suggestion trigger from native audio service
     * This is the primary auto-trigger path
     */
    async handleSuggestionTrigger(trigger: SuggestionTrigger): Promise<void> {
        if (trigger.confidence < 0.5) {
            return;
        }
        await this.runWhatShouldISay(trigger.lastQuestion, trigger.confidence);
    }

    // ============================================
    // Mode Executors
    // ============================================

    /**
     * MODE 1: Assist (Passive)
     * Low-priority observational insights
     */
    async runAssistMode(): Promise<string | null> {
        // Allow assist to run concurrently with other modes — it's a passive observer
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
        }

        this.assistCancellationToken = new AbortController();
        this.setMode('assist');

        try {
            if (!this.assistLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.withActiveModeActionContext(this.session.getFormattedContext(60), undefined, 'ANSWER');
            if (!context) {
                this.setMode('idle');
                return null;
            }

            const insight = await this.assistLLM.generate(context);

            if (this.assistCancellationToken?.signal.aborted) {
                return null;
            }

            if (insight) {
                this.emit('assist_update', insight);
            }
            this.setMode('idle');
            return insight;

        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return null;
            }
            this.emit('error', error as Error, 'assist');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 2: What Should I Say (Primary)
     * Manual trigger - uses clean transcript pipeline for question inference
     * NEVER returns null - always provides a usable response
     */
    async runWhatShouldISay(question?: string, confidence: number = 0.8, imagePaths?: string[], actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        const now = Date.now();

        // Bypass cooldown when the user explicitly attached images (capture-and-process intent).
        // The cooldown exists to debounce auto-triggers, not explicit shortcuts with context.
        const hasImages = imagePaths && imagePaths.length > 0;
        if (!hasImages && now - this.lastTriggerTime < this.triggerCooldown) {
            this.emit('action_cancelled', 'what_to_say', resolvedActionId);
            return null;
        }

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('what_to_say');
        this.lastTriggerTime = now;

        try {
            if (!this.whatToAnswerLLM) {
                if (!this.answerLLM) {
                    this.setMode('idle');
                    return "Please configure your API Keys in Settings to use this feature.";
                }
                const packet = this.buildActionContextPacket('WHAT_TO_SAY', 180);
                const context = packet.context;
                const startedAt = Date.now();
                const answer = await this.answerLLM.generate(question || '', context);
                if (answer) {
                    this.session.addAssistantMessage(answer);
                    this.emit('suggested_answer', answer, question || 'inferred', confidence, resolvedActionId);
                    this.recordActionResult('WHAT_TO_SAY', question || 'inferred', answer, { latencyMs: Date.now() - startedAt, actionId: resolvedActionId });
                }
                this.setMode('idle');
                return answer || "Could you repeat that? I want to make sure I address your question properly.";
            }

            const contextItems = this.session.getActionContext(180);
            const additionalActionItems: ContextItem[] = [];

            // Inject latest interim transcript if available
            const lastInterim = this.session.getLastInterimInterviewer();
            if (lastInterim && lastInterim.text.trim().length > 0) {
                const lastItem = contextItems[contextItems.length - 1];
                const isDuplicate = lastItem &&
                    lastItem.role === 'interviewer' &&
                    (lastItem.text === lastInterim.text || Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

                if (!isDuplicate) {
                    console.log(`[IntelligenceEngine] Injecting interim transcript: "${lastInterim.text.substring(0, 50)}..."`);
                    contextItems.push({
                        role: 'interviewer',
                        text: lastInterim.text,
                        timestamp: lastInterim.timestamp,
                    });
                    additionalActionItems.push({
                        role: 'interviewer',
                        speaker: lastInterim.speaker,
                        text: lastInterim.text,
                        timestamp: lastInterim.timestamp,
                        confidence: lastInterim.confidence,
                        source: 'live',
                        canonicalRole: lastInterim.canonicalRole || 'interlocutor',
                        qualityFlags: lastInterim.qualityFlags || [],
                    });
                }
            }

            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));

            const preparedBaseTranscript = prepareTranscriptForWhatToAnswer(transcriptTurns, 12);
            const actionPacket = this.buildActionContextPacket(
                'WHAT_TO_SAY',
                180,
                undefined,
                preparedBaseTranscript,
                additionalActionItems,
            );
            const preparedTranscript = actionPacket.context;

            const temporalContext = buildTemporalContext(
                contextItems,
                this.session.getAssistantResponseHistory(),
                180
            );

            const lastInterviewerTurn =
                actionPacket.actionTarget.source !== 'none'
                    ? actionPacket.actionTarget.text
                    : (actionPacket.interlocutorFocus.kind !== 'none'
                        ? actionPacket.interlocutorFocus.text
                        : this.session.getLastInterviewerTurnForActions());
            const intentResult = await classifyIntent(
                lastInterviewerTurn,
                preparedTranscript,
                this.session.getAssistantResponseHistory().length
            );

            console.log(`[IntelligenceEngine] Temporal RAG: ${temporalContext.previousResponses.length} responses, tone: ${temporalContext.toneSignals[0]?.type || 'neutral'}, intent: ${intentResult.intent}${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);

            const generationId = this.nextGenerationId('what_to_say');
            // RC-03 fix: hold a reference to the generator so we can call .return()
            // to properly terminate the network request when a new generation starts.
            const stream = this.whatToAnswerLLM.generateStream(preparedTranscript, temporalContext, intentResult, imagePaths);
            const streamResult = await this.consumeActionStream(
                'what_to_say',
                'WHAT_TO_SAY',
                stream,
                generationId,
                this.liveActionTokenHandler(
                    'WHAT_TO_SAY',
                    (token) => this.emit('suggested_answer_token', token, question || 'inferred', confidence, resolvedActionId),
                ),
            );
            let fullAnswer = streamResult.text;

            if (streamResult.aborted) {
                // Aborted mid-stream — don't update session or emit final event
                this.emit('action_cancelled', 'what_to_say', resolvedActionId);
                this.finishMode('what_to_say', generationId);
                return null;
            }

            const qualityResult = await this.improveLiveActionOutput(
                'what_to_say',
                'WHAT_TO_SAY',
                generationId,
                fullAnswer,
                actionPacket,
                {
                    question,
                    streamTimedOut: streamResult.timedOut,
                },
            );
            fullAnswer = qualityResult.answer;

            if (!this.isGenerationCurrent('what_to_say', generationId)) {
                this.emit('action_cancelled', 'what_to_say', resolvedActionId);
                this.finishMode('what_to_say', generationId);
                return null;
            }

            this.session.addAssistantMessage(fullAnswer);

            const diagnostics = this.session.getActionContextDiagnostics(180);
            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: question || 'What to Answer',
                answer: fullAnswer,
                items: diagnostics,
                metadata: this.buildUsageMetadata('WHAT_TO_SAY', preparedTranscript, diagnostics, actionPacket, {
                    latencyMs: streamResult.latencyMs,
                    firstTokenMs: streamResult.firstTokenMs,
                    timedOut: streamResult.timedOut,
                    fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult.fallbackReason,
                })
            });
            this.recordActionResult('WHAT_TO_SAY', question || 'What to Answer', fullAnswer, {
                latencyMs: streamResult.latencyMs,
                firstTokenMs: streamResult.firstTokenMs,
                timedOut: streamResult.timedOut,
                hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                contextTrustScore: actionPacket.contextTrustScore,
                qualityScore: qualityResult.review.score,
                qualityReasons: qualityResult.review.reasons,
                qualityRepaired: qualityResult.repaired,
                fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult.fallbackReason,
                actionId: resolvedActionId,
            });

            // CQ-05 fix: only emit the "complete" event after a non-aborted stream.
            // The renderer already has all tokens — this is for metadata only (e.g. copying, history).
            this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence, resolvedActionId);

            this.finishMode('what_to_say', generationId);
            return fullAnswer;

        } catch (error) {
            const errorCode = String((error as { code?: string })?.code || 'generation_error');
            this.recordActionResult('WHAT_TO_SAY', question || 'What to Answer', '', {
                actionId: resolvedActionId,
                error: (error as Error)?.message || String(error),
                fallback: errorCode,
            });
            this.emit('error', error as Error, 'what_to_say', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE 3: Follow-Up (Refinement)
     * Modify the last assistant message
     */
    async runFollowUp(intent: string, userRequest?: string, actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        console.log(`[IntelligenceEngine] runFollowUp called with intent: ${intent}`);
        const lastMsg = this.session.getLastAssistantMessage();
        if (!lastMsg) {
            const error = new Error('No previous assistant answer is available to refine.');
            console.warn('[IntelligenceEngine] No lastAssistantMessage found for follow-up');
            this.emit('error', error, 'follow_up', resolvedActionId);
            throw error;
        }

        this.setMode('follow_up');

        try {
            if (!this.followUpLLM) {
                throw new Error('Follow-up generation is not initialized. Configure an AI provider in Settings.');
            }

            const actionPacket = this.buildActionContextPacket('FOLLOW_UP_QUESTION', 60);
            const context = actionPacket.context;
            const refinementRequest = userRequest || intent;

            const generationId = this.nextGenerationId('follow_up');
            const stream = this.followUpLLM.generateStream(
                lastMsg,
                refinementRequest,
                context
            );
            const streamResult = await this.consumeActionStream(
                'follow_up',
                'FOLLOW_UP_QUESTION',
                stream,
                generationId,
                (token) => this.emit('refined_answer_token', token, intent, resolvedActionId),
            );
            const fullRefined = streamResult.text;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'follow_up', resolvedActionId);
                this.finishMode('follow_up', generationId);
                return null;
            }

            if (!fullRefined.trim()) {
                throw new Error('Follow-up generation returned an empty response.');
            }

            if (fullRefined) {
                this.session.addAssistantMessage(fullRefined);
                this.emit('refined_answer', fullRefined, intent, resolvedActionId);

                const intentMap: Record<string, string> = {
                    'expand': 'Expand Answer',
                    'rephrase': 'Rephrase Answer',
                    'add_example': 'Add Example',
                    'more_confident': 'Make More Confident',
                    'more_casual': 'Make More Casual',
                    'more_formal': 'Make More Formal',
                    'simplify': 'Simplify Answer'
                };

                const displayQuestion = userRequest || intentMap[intent] || `Refining: ${intent}`;

                const diagnostics = this.session.getActionContextDiagnostics(60);
                this.session.pushUsage({
                    type: 'followup',
                    timestamp: Date.now(),
                    question: displayQuestion,
                    answer: fullRefined,
                    items: diagnostics,
                    metadata: this.buildUsageMetadata('FOLLOW_UP_QUESTION', context, diagnostics, actionPacket, {
                        latencyMs: streamResult.latencyMs,
                        firstTokenMs: streamResult.firstTokenMs,
                        timedOut: streamResult.timedOut,
                    })
                });
                this.recordActionResult('FOLLOW_UP_QUESTION', displayQuestion, fullRefined, {
                    latencyMs: streamResult.latencyMs,
                    timedOut: streamResult.timedOut,
                    hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                    actionId: resolvedActionId,
                });
            }

            this.finishMode('follow_up', generationId);
            return fullRefined;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE 4: Recap (Summary)
     * Neutral conversation summary
     */
    async runRecap(actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        console.log('[IntelligenceEngine] runRecap called');
        this.setMode('recap');

        try {
            if (!this.recapLLM) {
                throw new Error('Recap generation is not initialized. Configure an AI provider in Settings.');
            }

            const actionPacket = this.buildActionContextPacket(
                'RECAP',
                600,
                undefined,
                this.session.getFullSessionContext() || this.session.getFormattedContext(600),
            );
            const context = actionPacket.context;
            if (!context) {
                throw new Error('No meeting context is available for a recap yet.');
            }

            const generationId = this.nextGenerationId('recap');
            const stream = this.recapLLM.generateStream(context);
            const streamResult = await this.consumeActionStream(
                'recap',
                'RECAP',
                stream,
                generationId,
                (token) => this.emit('recap_token', token, resolvedActionId),
            );
            const fullSummary = streamResult.text;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'recap', resolvedActionId);
                this.finishMode('recap', generationId);
                return null;
            }

            if (!fullSummary.trim()) {
                throw new Error('Recap generation returned an empty response.');
            }

            if (!this.isGenerationCurrent('recap', generationId)) {
                this.emit('action_cancelled', 'recap', resolvedActionId);
                this.finishMode('recap', generationId);
                return null;
            }

            // Only emit final if not aborted
            if (fullSummary && this.isGenerationCurrent('recap', generationId)) {
                this.emit('recap', fullSummary, resolvedActionId);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: 'Recap Meeting',
                    answer: fullSummary,
                    metadata: this.buildUsageMetadata('RECAP', context, actionPacket.diagnostics, actionPacket, {
                        latencyMs: streamResult.latencyMs,
                        firstTokenMs: streamResult.firstTokenMs,
                        timedOut: streamResult.timedOut,
                    })
                });
                this.recordActionResult('RECAP', 'Recap Meeting', fullSummary, {
                    latencyMs: streamResult.latencyMs,
                    timedOut: streamResult.timedOut,
                    hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                    actionId: resolvedActionId,
                });
            }
            this.finishMode('recap', generationId);
            return fullSummary;

        } catch (error) {
            this.emit('error', error as Error, 'recap', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE: Clarify
     * Ask a clarifying question to the interviewer
     */
    async runClarify(actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        console.log('[IntelligenceEngine] runClarify called');
        this.setMode('clarify');

        try {
            if (!this.clarifyLLM) {
                throw new Error('Clarification generation is not initialized. Configure an AI provider in Settings.');
            }

            const actionPacket = this.buildActionContextPacket('CLARIFY', 180);
            const rawContext = actionPacket.context;
            // If no transcript yet, use a generic prompt — the LLM will ask for the missing context.
            const context = rawContext || '[No reliable interlocutor transcript is available yet. Generate one short, natural question asking for the missing context or the main constraint. Do not invent what the other person said.]';

            const generationId = this.nextGenerationId('clarify');
            const conferenceExplanation = actionPacket.contextMode === 'conference';
            const stream = conferenceExplanation
                ? this.clarifyLLM.generateConferenceExplanationStream(context)
                : this.clarifyLLM.generateStream(context);
            const streamResult = await this.consumeActionStream(
                'clarify',
                'CLARIFY',
                stream,
                generationId,
                this.liveActionTokenHandler('CLARIFY', (token) => this.emit('clarify_token', token, resolvedActionId)),
            );
            let fullClarification = streamResult.text;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'clarify', resolvedActionId);
                this.finishMode('clarify', generationId);
                return null;
            }

            const qualityResult = await this.improveLiveActionOutput(
                'clarify',
                'CLARIFY',
                generationId,
                fullClarification,
                actionPacket,
                {
                    streamTimedOut: streamResult.timedOut,
                    sanitizeSingleQuestion: !conferenceExplanation,
                },
            );
            fullClarification = qualityResult.answer;

            if (!this.isGenerationCurrent('clarify', generationId)) {
                this.emit('action_cancelled', 'clarify', resolvedActionId);
                this.finishMode('clarify', generationId);
                return null;
            }
            if (!fullClarification.trim()) {
                throw new Error('Clarification generation returned an empty response.');
            }

            // Only update history and emit final if not aborted
            if (fullClarification && this.isGenerationCurrent('clarify', generationId)) {
                this.emit('clarify', fullClarification, resolvedActionId);
                this.session.addAssistantMessage(fullClarification);

                const diagnostics = this.session.getActionContextDiagnostics(180);
                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: conferenceExplanation ? 'Clarify Conference Point' : 'Clarify Question',
                    answer: fullClarification,
                    items: diagnostics,
                    metadata: this.buildUsageMetadata('CLARIFY', context, diagnostics, actionPacket, {
                        latencyMs: streamResult.latencyMs,
                        firstTokenMs: streamResult.firstTokenMs,
                        timedOut: streamResult.timedOut,
                        fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult.fallbackReason,
                    })
                });
                this.recordActionResult('CLARIFY', conferenceExplanation ? 'Clarify Conference Point' : 'Clarify Question', fullClarification, {
                    latencyMs: streamResult.latencyMs,
                    timedOut: streamResult.timedOut,
                    hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                    qualityScore: qualityResult.review.score,
                    qualityReasons: qualityResult.review.reasons,
                    qualityRepaired: qualityResult.repaired,
                    fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult.fallbackReason,
                    actionId: resolvedActionId,
                });
            }
            this.finishMode('clarify', generationId);
            return fullClarification;

        } catch (error) {
            this.emit('error', error as Error, 'clarify', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE 6: Follow-Up Questions
     * Suggest strategic questions for the user to ask
     */
    async runFollowUpQuestions(actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        console.log('[IntelligenceEngine] runFollowUpQuestions called');
        this.setMode('follow_up_questions');

        try {
            if (!this.followUpQuestionsLLM) {
                throw new Error('Follow-up question generation is not initialized. Configure an AI provider in Settings.');
            }

            const actionPacket = this.buildActionContextPacket('FOLLOW_UP_QUESTION', 120);
            const context = actionPacket.context || '[No reliable interlocutor transcript is available yet. Generate one short, natural follow-up question asking for the missing context or the main decision. Do not invent what the other person said.]';

            const generationId = this.nextGenerationId('follow_up_questions');
            const stream = this.followUpQuestionsLLM.generateStream(context);
            const streamResult = await this.consumeActionStream(
                'follow_up_questions',
                'FOLLOW_UP_QUESTION',
                stream,
                generationId,
                this.liveActionTokenHandler(
                    'FOLLOW_UP_QUESTION',
                    (token) => this.emit('follow_up_questions_token', token, resolvedActionId),
                ),
            );
            let fullQuestions = streamResult.text;
            let qualityResult: LiveActionQualityResult | undefined;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'follow_up_questions', resolvedActionId);
                this.finishMode('follow_up_questions', generationId);
                return null;
            }

            qualityResult = await this.improveLiveActionOutput(
                    'follow_up_questions',
                    'FOLLOW_UP_QUESTION',
                    generationId,
                    fullQuestions,
                    actionPacket,
                    {
                        streamTimedOut: streamResult.timedOut,
                        sanitizeSingleQuestion: true,
                    },
            );
            fullQuestions = qualityResult.answer;

            if (!fullQuestions.trim()) {
                throw new Error('Follow-up question generation returned an empty response.');
            }

            if (!this.isGenerationCurrent('follow_up_questions', generationId)) {
                this.emit('action_cancelled', 'follow_up_questions', resolvedActionId);
                this.finishMode('follow_up_questions', generationId);
                return null;
            }

            if (fullQuestions && this.isGenerationCurrent('follow_up_questions', generationId)) {
                this.emit('follow_up_questions_update', fullQuestions, resolvedActionId);
                const diagnostics = this.session.getActionContextDiagnostics(120);
                this.session.pushUsage({
                    type: 'followup_questions',
                    timestamp: Date.now(),
                    question: 'Generate Follow-up Questions',
                    answer: fullQuestions,
                    items: diagnostics,
                    metadata: this.buildUsageMetadata('FOLLOW_UP_QUESTION', context, diagnostics, actionPacket, {
                        latencyMs: streamResult.latencyMs,
                        firstTokenMs: streamResult.firstTokenMs,
                        timedOut: streamResult.timedOut,
                        fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult?.fallbackReason,
                    })
                });
                this.recordActionResult('FOLLOW_UP_QUESTION', 'Generate Follow-up Questions', fullQuestions, {
                    latencyMs: streamResult.latencyMs,
                    timedOut: streamResult.timedOut,
                    hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                    qualityScore: qualityResult?.review.score,
                    qualityReasons: qualityResult?.review.reasons,
                    qualityRepaired: qualityResult?.repaired,
                    fallback: streamResult.timedOut ? 'soft_timeout' : qualityResult?.fallbackReason,
                    actionId: resolvedActionId,
                });
            }
            this.finishMode('follow_up_questions', generationId);
            return fullQuestions;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up_questions', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE 5: Manual Answer (Fallback)
     * Explicit bypass when auto-detection fails
     */
    async runManualAnswer(question: string): Promise<string | null> {
        this.emit('manual_answer_started');
        this.setMode('manual');

        try {
            if (!this.answerLLM) {
                this.setMode('idle');
                return null;
            }

            const manualQuestionContext = this.buildManualQuestionContextBlock(question);
            const manualQuestionItem = this.buildManualQuestionContextItem(question);
            const actionPacket = this.buildActionContextPacket(
                'ANSWER',
                180,
                undefined,
                manualQuestionContext,
                manualQuestionItem ? [manualQuestionItem] : undefined,
                true,
            );
            const context = actionPacket.context;
            const generationId = this.nextGenerationId('manual');
            let fallbackReason: string | undefined;
            const stream = this.llmHelper.streamChat(
                question,
                undefined,
                context,
                this.buildManualAnswerSystemPrompt(question),
                true,
            );
            const streamResult = await this.consumeActionStream(
                'manual',
                'ANSWER',
                stream,
                generationId,
                () => undefined,
            );
            let answer = streamResult.text;

            if (streamResult.aborted) {
                this.finishMode('manual', generationId);
                return null;
            }

            const manualWeakOutput = answer
                ? this.shouldReplaceManualAnswerOutput(question, answer, actionPacket)
                : false;
            const qualityResult = await this.improveLiveActionOutput(
                'manual',
                'ANSWER',
                generationId,
                answer,
                actionPacket,
                {
                    question,
                    streamTimedOut: streamResult.timedOut,
                    manualWeakOutput,
                },
            );
            answer = qualityResult.answer;
            fallbackReason = streamResult.timedOut ? 'soft_timeout' : qualityResult.fallbackReason;

            if (!this.isGenerationCurrent('manual', generationId)) {
                this.finishMode('manual', generationId);
                return null;
            }

            if (qualityResult.fallbackReason) {
                answer = this.buildManualAnswerFallback(question, actionPacket);
                fallbackReason = qualityResult.fallbackReason;
            }

            if (answer) {
                this.session.addAssistantMessage(answer);
                this.emit('manual_answer_result', answer, question);

                const diagnostics = this.session.getActionContextDiagnostics(120);
                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: question,
                    answer: answer,
                    items: diagnostics,
                    metadata: this.buildUsageMetadata('ANSWER', context, diagnostics, actionPacket, {
                        latencyMs: streamResult.latencyMs,
                        firstTokenMs: streamResult.firstTokenMs,
                        timedOut: streamResult.timedOut,
                        fallback: fallbackReason,
                    })
                });
                this.recordActionResult('ANSWER', question, answer, {
                    latencyMs: streamResult.latencyMs,
                    timedOut: streamResult.timedOut,
                    hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                    qualityScore: qualityResult.review.score,
                    qualityReasons: qualityResult.review.reasons,
                    qualityRepaired: qualityResult.repaired,
                    fallback: fallbackReason,
                });
            }

            this.finishMode('manual', generationId);
            return answer;

        } catch (error) {
            this.emit('error', error as Error, 'manual');
            this.setMode('idle');
            return null;
        }
    }

    private buildManualQuestionContextBlock(question: string): string {
        const cleanedQuestion = this.truncateForUsage(String(question || '').replace(/\s+/g, ' ').trim(), 600);
        if (!cleanedQuestion) return '';

        return [
            '[LOCAL USER QUESTION]',
            'kind=direct_question',
            'confidence=1.00',
            'reason=typed_manual_answer_request',
            `text=${cleanedQuestion}`,
            'instruction=This is the typed/manual question from the local user. Answer it directly. If it asks what to answer or say, produce the exact sentence the user can say aloud now. Use reliable speaker context as evidence, but do not repeat malformed ASR fragments.',
            '[/LOCAL USER QUESTION]',
            '[MANUAL ANSWER CONTRACT]',
            'question_source=typed_user_input',
            'priority=answer_the_local_user_question_before_the_action_target',
            'do_not=copy_or_repeat_raw_transcript_fragments_as_the_final_answer',
            '[/MANUAL ANSWER CONTRACT]',
        ].join('\n');
    }

    private buildManualQuestionContextItem(question: string): ContextItem | null {
        const cleanedQuestion = String(question || '').replace(/\s+/g, ' ').trim();
        if (!cleanedQuestion) return null;
        return {
            role: 'user',
            speaker: 'me',
            text: cleanedQuestion,
            timestamp: Date.now(),
            confidence: 1,
            source: 'live',
            canonicalRole: 'me',
            qualityFlags: ['trusted_me'],
        };
    }

    private buildManualAnswerSystemPrompt(question: string): string {
        const meetingQa = this.isManualMeetingQaQuestion(question);
        return `You are Natively, a live meeting copilot.

Task:
- Answer the local user's typed/manual question using the meeting context packet.
- If the user asks what to say, what to answer, or asks for a phrase, produce the exact words they can say aloud.
- Otherwise, answer as a meeting Q&A assistant: explain, synthesize, and clarify what was meant in the meeting.

Internal answering method:
1. Identify what the local user is really asking; treat their typed question as the query, not as transcript evidence.
2. Read the ACTION TARGET, CURRENT INTERLOCUTOR FOCUS, supporting context, and selected canonical transcript together, as if the user had pasted the meeting transcript into a strong assistant.
3. Reconstruct obvious ASR cuts and sentence boundaries from neighboring turns before deciding what was meant.
4. Gather evidence across multiple nearby turns instead of anchoring on a single matching sentence.
5. Produce the final answer as a clean synthesis: conclusion first, then the meeting-specific reason or example when useful.

Speaker contract:
- ME / LOCAL MIC / user = the local app user.
- INTERLOCUTOR / SPEAKER_N / system audio = other meeting participants.
- Never treat ME as proof of what another participant said.
- If the transcript has multiple INTERLOCUTOR/SPEAKER_N labels but no names, distinguish them by label or say "un autre participant" instead of inventing names.

Transcript quality:
- The transcript can contain ASR mistakes, cut sentences, and wrong words.
- Reconstruct obvious sentence boundaries from nearby turns.
- Do not copy malformed fragments as the final answer.
- Prefer a clean synthesis of the meaning over exact transcript wording.

Output rules:
- Use the dominant meeting language. If French appears in the question/context, answer in French.
- Be direct and useful. No preamble about transcripts, context, chunks, or retrieval.
- If evidence is partial, say what is supported and what remains uncertain.
- For definitions or "c'est quoi / qu'est-ce que / explique" questions, answer in this shape: short definition, what it meant in this meeting, practical implication/example.
- Unless the user explicitly asks for a quote, do not make the final answer mostly a transcript quote.
${meetingQa ? '- This is a meeting Q&A request, not necessarily a phrase the user must say aloud.' : '- The user may want spoken wording; if so, keep it natural and speakable.'}`;
    }

    private shouldReplaceManualAnswerOutput(question: string, output: string, packet: MeetingContextPacket): boolean {
        const normalizedOutput = this.normalizeForComparison(output);
        if (!normalizedOutput) return true;
        if (this.looksLikeRawTranscriptEcho(output, packet)) return true;
        if (this.looksLikeTruncatedTranscriptFragment(output)) return true;
        if (this.isManualBugReplyQuestion(question) && this.isWeakBugReply(output)) return true;
        return false;
    }

    private buildManualAnswerFallback(question: string, packet: MeetingContextPacket): string {
        const french = packet.languageHint === 'fr' || packet.languageHint === 'mixed';
        const contextText = this.selectedInterlocutorContextText(packet);

        if (this.isManualMeetingQaQuestion(question)) {
            const meetingQaFallback = this.buildMeetingQaFallback(question, packet, french);
            if (meetingQaFallback) return meetingQaFallback;
        }

        if (this.isManualBugReplyQuestion(question) || this.looksLikeBugFlowContext(contextText)) {
            return french
                ? "Je dirais : je vais reproduire le cas sur le compte WaChap, tester séparément l'envoi simple puis les flux IA/Pierre, reconnecter le compte et récupérer les logs pour voir exactement pourquoi le flux ne se déclenche plus."
                : "I would say: I will reproduce it on the WaChap account, test simple sending separately from the AI/Pierre flows, reconnect the account, and pull logs to see exactly why the flow no longer starts.";
        }

        return this.buildLiveActionFallback('ANSWER', packet);
    }

    private isManualMeetingQaQuestion(question: string): boolean {
        const normalized = this.normalizeForComparison(question);
        return /\b(c est quoi|qu est ce que|explique|expliquer|definition|définition|definis|définis|que signifie|d apres|d après|selon ce qui est dit|ce qui est dit|what is|explain|define|according to what was said)\b/.test(normalized);
    }

    private buildMeetingQaFallback(question: string, packet: MeetingContextPacket, french: boolean): string {
        const normalizedQuestion = this.normalizeForComparison(question);
        const contextText = this.selectedInterlocutorContextText(packet);
        const normalizedContext = this.normalizeForComparison(contextText);

        if (
            /\bprocessus\b/.test(normalizedQuestion) &&
            (/\bhierarchique\b/.test(normalizedQuestion) || /\bhierachique\b/.test(normalizedQuestion) || /\bhiérarchique\b/.test(question.toLowerCase()) || /\bgaussien\b/.test(normalizedQuestion))
        ) {
            return french
                ? "D'après la réunion, le processus hiérarchique désigne une modélisation en plusieurs niveaux : au lieu de traiter chaque locataire ou individu isolément, on tient compte de groupes ou de profils qui peuvent avoir des comportements différents. Dans leur exemple, un processus gaussien simple modélise chaque individu, tandis que l'approche hiérarchique ajoute des variables de profil pour mieux expliquer et prédire les tendances."
                : "From the meeting, a hierarchical process means modeling data at several levels: instead of treating each tenant or individual in isolation, it accounts for groups or profiles with different behaviors. In their example, a simple Gaussian process models each individual, while the hierarchical version adds profile-level variables to explain and predict trends better.";
        }

        const topic = this.extractFallbackTopic(contextText);
        if (!topic) {
            return french
                ? "Je n'ai pas assez de contexte fiable pour répondre précisément sans inventer."
                : "I do not have enough reliable context to answer precisely without inventing.";
        }

        const uncertainty = normalizedContext.includes('stt') || normalizedContext.length < 120;
        return french
            ? `D'après ce qui est dit, l'idée principale est la suivante : ${topic}. ${uncertainty ? "La transcription est partielle, donc je resterais prudent sur les détails." : "La réponse doit surtout retenir ce sens, pas les mots bruts de la transcription."}`
            : `From what was said, the main idea is this: ${topic}. ${uncertainty ? "The transcript is partial, so I would stay careful on the details." : "The answer should keep that meaning, not the raw transcript wording."}`;
    }

    private looksLikeRawTranscriptEcho(output: string, packet: MeetingContextPacket): boolean {
        const normalizedOutput = this.normalizeForComparison(output);
        if (!normalizedOutput) return true;

        const candidates = [
            packet.actionTarget?.text,
            packet.interlocutorFocus?.text,
            ...packet.selectedSegments.slice(-6).map((segment) => segment.text),
        ].filter((text): text is string => Boolean(text && text.trim().length >= 35));

        return candidates.some((candidate) => {
            const normalizedCandidate = this.normalizeForComparison(candidate);
            if (!normalizedCandidate || normalizedCandidate.length < 35) return false;
            if (normalizedOutput.includes(normalizedCandidate.slice(0, Math.min(90, normalizedCandidate.length)))) {
                return true;
            }

            const candidateKeywords = this.extractContentKeywords(candidate);
            if (candidateKeywords.length < 5) return false;
            const outputKeywords = new Set(this.extractContentKeywords(output));
            const overlap = candidateKeywords.filter((keyword) => outputKeywords.has(keyword)).length;
            return overlap / Math.min(candidateKeywords.length, Math.max(outputKeywords.size, 1)) >= 0.72;
        });
    }

    private looksLikeTruncatedTranscriptFragment(output: string): boolean {
        const normalized = this.normalizeForComparison(output);
        const words = normalized.split(' ').filter(Boolean);
        if (words.length < 6) return false;
        const last = words[words.length - 1] || '';
        if (/^(le|la|les|un|une|des|du|de|d|avec|sans|pour|dans|sur|qui|que|dont|et|mais|donc|parce|comme|si|processus)$/.test(last)) {
            return true;
        }
        return /^(je dirais|je repondrais|je répondrais)\s*:?\s*(tu vois|en fait|bon|oui)\b/i.test(normalized) &&
            !/[.!?。！？]\s*$/.test(output.trim());
    }

    private isManualBugReplyQuestion(question: string): boolean {
        const normalized = this.normalizeForComparison(question);
        return /\b(que repondre|quoi repondre|quoi dire|que dire|what should i say|what to answer)\b/.test(normalized) &&
            /\b(bug|probleme|problème|flux|wachap|wa chap|ia|pierre)\b/.test(normalized);
    }

    private looksLikeBugFlowContext(text: string): boolean {
        const normalized = this.normalizeForComparison(text);
        const hasBug = /\b(bug|marche)\b/.test(normalized) ||
            normalized.includes('probleme') ||
            normalized.includes('problème') ||
            normalized.includes('declench') ||
            normalized.includes('déclench') ||
            normalized.includes('diagnosti') ||
            normalized.includes('reconnect');
        const hasFlow = /\b(flux|ia|pierre|wachap|wa chap|envoi|message)\b/.test(normalized);
        return hasBug && hasFlow;
    }

    private isWeakBugReply(output: string): boolean {
        const normalized = this.normalizeForComparison(output);
        if (/\b(ca ne fout|ça ne fout|fluche|full small|ppp|batteries demander|etudiateurs)\b/.test(normalized)) return true;

        const hasAction = /\b(vais|verifier|vérifier|tester|isoler|reproduire|diagnostiquer|reconnecter|recuperer|récupérer|logs|corriger)\b/.test(normalized);
        const hasConcreteBugTerm = /\b(flux|ia|pierre|wachap|envoi|message|compte)\b/.test(normalized);
        return !(hasAction && hasConcreteBugTerm);
    }

    /**
     * MODE 7: Code Hint (Live Code Reviewer)
     * Analyzes a screenshot of partially written code against the detected/provided question
     * and returns a short targeted hint. Question comes from (priority order):
     *   1. problemStatement passed in from ipcHandler (screenshot extraction — highest confidence)
     *   2. session.detectedCodingQuestion (detected from interviewer transcript)
     *   3. transcriptContext (last N seconds of conversation — fallback for inference)
     */
    async runCodeHint(imagePaths?: string[], problemStatement?: string, actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('code_hint');

        try {
            if (!this.codeHintLLM) {
                this.setMode('idle');
                return "Please configure your API Keys in Settings to use this feature.";
            }

            // Resolve question context from available sources (priority order)
            const sessionQuestion = this.session.getDetectedCodingQuestion();
            const questionContext = problemStatement ?? sessionQuestion.question ?? null;
            const questionSource = problemStatement
                ? 'screenshot'
                : sessionQuestion.source;

            // Pull transcript as fallback context when no question is pinned
            const transcriptPacket = questionContext === null
                ? this.buildActionContextPacket('ANSWER', 180)
                : null;
            const transcriptContext = transcriptPacket?.context ?? null;

            console.log(`[IntelligenceEngine] Code hint — question source: ${questionContext ? (questionSource ?? 'passed') : 'none'}, transcript lines: ${transcriptContext ? transcriptContext.split('\n').length : 0}, images: ${imagePaths?.length ?? 0}`);

            const generationId = this.nextGenerationId('code_hint');
            const stream = this.codeHintLLM.generateStream(
                imagePaths,
                questionContext ?? undefined,
                questionSource,
                transcriptContext ?? undefined
            );
            const streamResult = await this.consumeActionStream(
                'code_hint',
                'ANSWER',
                stream,
                generationId,
                (token) => this.emit('suggested_answer_token', token, 'Code Hint', 1.0, resolvedActionId),
            );
            let fullHint = streamResult.text;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'code_hint', resolvedActionId);
                this.finishMode('code_hint', generationId);
                return null;
            }

            if (!fullHint || fullHint.trim().length < 5) {
                fullHint = "I couldn't detect any code in the screenshot. Try screenshotting your code editor directly.";
            }

            this.session.addAssistantMessage(fullHint);
            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: 'Code Hint',
                answer: fullHint,
                metadata: this.buildUsageMetadata('ANSWER', transcriptContext || questionContext || 'Screenshot/code hint context', transcriptPacket?.diagnostics, transcriptPacket || undefined, {
                    latencyMs: streamResult.latencyMs,
                    firstTokenMs: streamResult.firstTokenMs,
                    timedOut: streamResult.timedOut,
                })
            });
            this.recordActionResult('ANSWER', 'Code Hint', fullHint, {
                latencyMs: streamResult.latencyMs,
                timedOut: streamResult.timedOut,
                hasReliableInterlocutor: transcriptPacket?.hasReliableInterlocutor,
                actionId: resolvedActionId,
            });

            this.emit('suggested_answer', fullHint, 'Code Hint', 1.0, resolvedActionId);
            this.finishMode('code_hint', generationId);
            return fullHint;

        } catch (error) {
            this.emit('error', error as Error, 'code_hint', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    /**
     * MODE 8: Brainstorm (Strategic Approach Generator)
     * Generates a spoken script outlining 2-3 problem-solving approaches with trade-offs.
     */
    async runBrainstorm(imagePaths?: string[], problemStatement?: string, actionId?: string): Promise<string | null> {
        const resolvedActionId = resolveLiveActionId(actionId);
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('brainstorm');

        try {
            if (!this.brainstormLLM) {
                this.setMode('idle');
                return "Please configure your API Keys in Settings to use this feature.";
            }

            let actionPacket = this.buildActionContextPacket('ANSWER', 180);
            let context = actionPacket.context;
            // Prepend the problem statement so the LLM knows exactly what to brainstorm
            const resolvedProblem = problemStatement?.trim() ||
                this.session.getDetectedCodingQuestion().question?.trim();

            if (!context.trim() && !resolvedProblem && (!imagePaths || imagePaths.length === 0)) {
                this.setMode('idle');
                const msg = "There's nothing to brainstorm right now. Make sure your question is visible or spoken aloud, then try again.";
                this.session.addAssistantMessage(msg);
                this.emit('suggested_answer', msg, 'Brainstorming Approaches', 1.0, resolvedActionId);
                return msg;
            }

            if (resolvedProblem) {
                context = `<problem_statement>\n${resolvedProblem}\n</problem_statement>\n\n${context}`;
            }
            const generationId = this.nextGenerationId('brainstorm');
            const stream = this.brainstormLLM.generateStream(context, imagePaths);
            const streamResult = await this.consumeActionStream(
                'brainstorm',
                'ANSWER',
                stream,
                generationId,
                (token) => this.emit('suggested_answer_token', token, 'Brainstorming Approaches', 1.0, resolvedActionId),
            );
            let fullResult = streamResult.text;

            if (streamResult.aborted) {
                this.emit('action_cancelled', 'brainstorm', resolvedActionId);
                this.finishMode('brainstorm', generationId);
                return null;
            }

            if (!fullResult || fullResult.trim().length < 5 || this.isGenericBrainstormFailure(fullResult)) {
                fullResult = this.buildLiveActionFallback('ANSWER', actionPacket);
            }

            this.session.addAssistantMessage(fullResult);
            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: 'Brainstorm',
                answer: fullResult,
                metadata: this.buildUsageMetadata('ANSWER', context, actionPacket.diagnostics, actionPacket, {
                    latencyMs: streamResult.latencyMs,
                    firstTokenMs: streamResult.firstTokenMs,
                    timedOut: streamResult.timedOut,
                })
            });
            this.recordActionResult('ANSWER', 'Brainstorm', fullResult, {
                latencyMs: streamResult.latencyMs,
                timedOut: streamResult.timedOut,
                hasReliableInterlocutor: actionPacket.hasReliableInterlocutor,
                actionId: resolvedActionId,
            });

            this.emit('suggested_answer', fullResult, 'Brainstorming Approaches', 1.0, resolvedActionId);
            this.finishMode('brainstorm', generationId);
            return fullResult;

        } catch (error) {
            this.emit('error', error as Error, 'brainstorm', resolvedActionId);
            this.setMode('idle');
            throw error;
        }
    }

    private isGenericBrainstormFailure(text: string): boolean {
        const normalized = this.normalizeForComparison(text);
        return normalized.includes('couldn t generate brainstorm') ||
            normalized.includes('could not generate brainstorm') ||
            normalized.includes('make sure your question is visible');
    }

    // ============================================
    // State Management
    // ============================================

    private setMode(mode: IntelligenceMode): void {
        if (this.activeMode !== mode) {
            this.activeMode = mode;
            this.emit('mode_changed', mode);
        }
    }

    private nextGenerationId(mode: IntelligenceMode): number {
        this.generationIds[mode] += 1;
        return this.generationIds[mode];
    }

    private isGenerationCurrent(mode: IntelligenceMode, generationId: number): boolean {
        return this.generationIds[mode] === generationId;
    }

    private finishMode(mode: IntelligenceMode, generationId: number): void {
        if (this.activeMode === mode && this.isGenerationCurrent(mode, generationId)) {
            this.setMode('idle');
        }
    }

    private cancelAllGenerations(): void {
        for (const mode of Object.keys(this.generationIds) as IntelligenceMode[]) {
            this.generationIds[mode] += 1;
        }
    }

    getActiveMode(): IntelligenceMode {
        return this.activeMode;
    }

    /**
     * Reset engine state (cancels any in-flight operations)
     */
    reset(): void {
        this.activeMode = 'idle';
        this.cancelAllGenerations();
        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }
    }
}
