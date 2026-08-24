// IntelligenceManager.ts
// Thin facade that delegates to focused sub-modules.
// Maintains full backward compatibility — all existing callers continue to work unchanged.
//
// Sub-modules:
//   SessionTracker     — state, transcript arrays, context management, epoch compaction
//   IntelligenceEngine — LLM mode routing (6 modes), event emission
//   MeetingPersistence — meeting stop/save/recovery

import { EventEmitter } from 'events';
import { LLMHelper } from './LLMHelper';
import { SessionTracker } from './SessionTracker';
import { IntelligenceEngine } from './IntelligenceEngine';
import { MeetingPersistence } from './MeetingPersistence';
import { CopilotDecisionEngine, CopilotDecision, CopilotFeedback, CopilotTranscriptSegment } from './copilot';
import { PreAnswerCache } from './meeting/PreAnswerCache';
import { LiveDigestService } from './meeting/LiveDigest';

// Re-export types for backward compatibility
export type { TranscriptSegment, SuggestionTrigger, ContextItem } from './SessionTracker';
export type { IntelligenceMode, IntelligenceModeEvents } from './IntelligenceEngine';
export type { CopilotDecision, CopilotFeedback } from './copilot';

export const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite-preview";

/**
 * IntelligenceManager - Facade for the intelligence layer.
 * 
 * Delegates to:
 * - SessionTracker:     context, transcripts, epoch summaries
 * - IntelligenceEngine: LLM modes (assist, whatToSay, followUp, recap, clarify, manual, followUpQuestions)
 * - MeetingPersistence: meeting stop/save/recovery
 */
export class IntelligenceManager extends EventEmitter {
    private llmHelper: LLMHelper;
    private session: SessionTracker;
    private engine: IntelligenceEngine;
    private persistence: MeetingPersistence;
    private copilot: CopilotDecisionEngine;
    private preAnswer: PreAnswerCache;
    private liveDigest: LiveDigestService;

    constructor(llmHelper: LLMHelper) {
        super();
        this.llmHelper = llmHelper;
        this.session = new SessionTracker();
        this.copilot = new CopilotDecisionEngine(llmHelper);
        this.engine = new IntelligenceEngine(llmHelper, this.session, () => this.copilot.getMeetingStateContextBlock());
        this.persistence = new MeetingPersistence(this.session, llmHelper);
        this.preAnswer = new PreAnswerCache(
            (question) => this.engine.precomputeWhatToSay(question),
            {
                onReady: (question) => {
                    try { this.emit('pre_answer_ready', { available: true, question }); } catch { /* never break routing */ }
                },
                onInvalidate: () => {
                    try { this.emit('pre_answer_ready', { available: false }); } catch { /* never break routing */ }
                },
            },
        );
        // Comprehension aid: rolling simple-language reformulation of the
        // latest transcript stretch (French by default — see LiveDigest).
        this.liveDigest = new LiveDigestService(
            () => {
                try {
                    return this.session
                        .getContext(180)
                        .map((item: any) => `${item.speaker || item.role}: ${item.text}`)
                        .join('\n');
                } catch {
                    return '';
                }
            },
            async (systemPrompt, context) => {
                try {
                    const out = await llmHelper.generateMeetingSummary(systemPrompt, context);
                    return typeof out === 'string' && out.trim() ? out : null;
                } catch {
                    return null;
                }
            },
            {
                onUpdate: (digest) => {
                    try { this.emit('live_digest_update', digest); } catch { /* never break routing */ }
                },
            },
        );

        // Forward all engine events through the facade
        this.forwardEngineEvents();
    }

    /**
     * Forward all events from IntelligenceEngine through this facade
     * so existing listeners on IntelligenceManager continue to work.
     */
    private forwardEngineEvents(): void {
        const events = [
            'assist_update', 'suggested_answer', 'suggested_answer_token',
            'refined_answer', 'refined_answer_token',
            'recap', 'recap_token', 'clarify', 'clarify_token',
            'follow_up_questions_update', 'follow_up_questions_token',
            'action_cancelled',
            'manual_answer_started', 'manual_answer_result',
            'mode_changed', 'error'
        ];

        for (const event of events) {
            this.engine.on(event, (...args: any[]) => {
                this.emit(event, ...args);
            });
        }
    }

    // ============================================
    // LLM Initialization (delegates to engine)
    // ============================================

    initializeLLMs(): void {
        // Cancel any in-flight streams before swapping LLM clients
        this.engine.reset();
        this.engine.initializeLLMs();
    }

    reinitializeLLMs(): void {
        this.engine.reset();
        this.engine.reinitializeLLMs();
    }

    // ============================================
    // Context Management (delegates to session)
    // ============================================

    setMeetingMetadata(metadata: any): void {
        this.session.setMeetingMetadata(metadata);
    }

    addTranscript(segment: import('./SessionTracker').TranscriptSegment, skipRefinementCheck: boolean = false): void {
        if (skipRefinementCheck) {
            // Direct add without refinement detection
            this.session.addTranscript(segment);
        } else {
            // Let the engine handle transcript + refinement detection
            this.llmHelper.runWithCodexServiceTierTracking(() => this.engine.handleTranscript(segment, false));
            this.processCopilotTranscript(segment);
        }
    }

    addAssistantMessage(text: string): void {
        this.session.addAssistantMessage(text);
    }

    getContext(lastSeconds: number = 120) {
        return this.session.getContext(lastSeconds);
    }

    getLastAssistantMessage(): string | null {
        return this.session.getLastAssistantMessage();
    }

    getFormattedContext(lastSeconds: number = 120): string {
        return this.session.getFormattedContext(lastSeconds);
    }

    getFormattedActionContext(lastSeconds: number = 120): string {
        return this.session.getFormattedActionContext(lastSeconds);
    }

    getLastInterviewerTurn(): string | null {
        return this.session.getLastInterviewerTurn();
    }

    logUsage(type: string, question: string, answer: string): void {
        this.session.logUsage(type, question, answer);
    }

    // ============================================
    // Transcript Handling (delegates to engine)
    // ============================================

    handleTranscript(segment: import('./SessionTracker').TranscriptSegment): void {
        this.llmHelper.runWithCodexServiceTierTracking(() => this.engine.handleTranscript(segment));
        this.processCopilotTranscript(segment);
    }

    recordTranscriptOnly(segment: import('./SessionTracker').TranscriptSegment): void {
        this.session.recordTranscriptOnly(segment);
    }

    /** Feed a transcript segment to the copilot without feeding the main engine.
     *  Used for mic audio so the copilot still has full conversational context. */
    feedCopilotContext(segment: import('./SessionTracker').TranscriptSegment): void {
        this.processCopilotTranscript(segment);
    }

    async handleSuggestionTrigger(trigger: import('./SessionTracker').SuggestionTrigger): Promise<void> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.handleSuggestionTrigger(trigger),
        );
    }

    submitCopilotFeedback(feedback: CopilotFeedback): void {
        this.copilot.submitFeedback(feedback);
    }

    getMeetingHealth(): import('./copilot/types').MeetingHealthSnapshot | null {
        return this.copilot.getMeetingHealth();
    }

    getDetectedRisks(): import('./copilot/types').DetectedRisk[] {
        return this.copilot.getDetectedRisks();
    }

    // ============================================
    // Mode Executors (delegates to engine)
    // ============================================

    async runAssistMode(): Promise<string | null> {
        return this.engine.runAssistMode();
    }

    async runWhatShouldISay(question?: string, confidence?: number, imagePaths?: string[], actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.runWhatShouldISay(question, confidence, imagePaths, actionId),
        );
    }

    async runFollowUp(intent: string, userRequest?: string, actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.runFollowUp(intent, userRequest, actionId),
        );
    }

    async runRecap(actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(() => this.engine.runRecap(actionId));
    }

    async runClarify(actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(() => this.engine.runClarify(actionId));
    }

    async runFollowUpQuestions(actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.runFollowUpQuestions(actionId),
        );
    }

    async runManualAnswer(question: string): Promise<string | null> {
        return this.engine.runManualAnswer(question);
    }

    async runCodeHint(imagePaths?: string[], problemStatement?: string, actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.runCodeHint(imagePaths, problemStatement, actionId),
        );
    }

    setCodingQuestion(question: string, source: 'screenshot' | 'transcript'): void {
        this.session.setCodingQuestion(question, source);
    }

    getDetectedCodingQuestion(): { question: string | null; source: 'screenshot' | 'transcript' | null } {
        return this.session.getDetectedCodingQuestion();
    }

    clearCodingQuestion(): void {
        this.session.clearCodingQuestion();
    }

    async runBrainstorm(imagePaths?: string[], problemStatement?: string, actionId?: string): Promise<string | null> {
        return this.llmHelper.runWithCodexServiceTierTracking(
            () => this.engine.runBrainstorm(imagePaths, problemStatement, actionId),
        );
    }

    // ============================================
    // State Management
    // ============================================

    getActiveMode() {
        return this.engine.getActiveMode();
    }

    setMode(mode: import('./IntelligenceEngine').IntelligenceMode): void {
        // This was private in the original, but kept for compatibility
        (this.engine as any).setMode(mode);
    }

    // ============================================
    // Meeting Lifecycle (delegates to persistence)
    // ============================================

    async stopMeeting(): Promise<string | null> {
        return this.persistence.stopMeeting();
    }

    async recoverUnprocessedMeetings(): Promise<void> {
        return this.persistence.recoverUnprocessedMeetings();
    }

    // ============================================
    // Reset (resets all sub-modules)
    // ============================================

    /**
     * resetEngine: Cancel in-flight LLM streams WITHOUT touching session state.
     * Use this when swapping API keys or providers mid-session so the transcript
     * is not wiped. (full reset() also clears the session — only use that at
     * end of meeting or explicit session teardown.)
     */
    resetEngine(): void {
        this.engine.reset();
    }

    reset(): void {
        this.session.reset();
        this.engine.reset();
        this.copilot.reset();
        this.preAnswer.clear();
        this.liveDigest.clear();
    }

    private processCopilotTranscript(segment: import('./SessionTracker').TranscriptSegment): void {
        const copilotSegment: CopilotTranscriptSegment = {
            id: `segment_${segment.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
            speaker: segment.speaker,
            text: segment.text,
            timestamp: segment.timestamp,
            final: segment.final,
            confidence: segment.confidence,
            canonicalRole: segment.canonicalRole,
            source: segment.source,
            qualityFlags: segment.qualityFlags,
            rawSpeaker: segment.rawSpeaker,
            speakerId: segment.speakerId,
        };

        void this.copilot.handleTranscript(copilotSegment)
            .then((decision: CopilotDecision | null) => {
                if (!decision) return;
                this.emit('copilot_decision', decision);
                if (decision.suggestion) {
                    this.emit('copilot_suggestion', decision);
                }
            })
            .catch((error: Error) => {
                this.emit('copilot_error', error);
            });

        // Stage 1 real-time copilot: silently pre-compute the What-to-say
        // answer when an interlocutor finishes asking something that looks
        // like a question. Serving still requires an explicit button press.
        if (copilotSegment.final) {
            try {
                this.preAnswer.onFinalSegment(copilotSegment);
            } catch {
                // Never let pre-compute bookkeeping break transcript routing.
            }
            try {
                this.liveDigest.onFinalSegment();
            } catch {
                // Never let comprehension bookkeeping break transcript routing.
            }
        }
    }

    /**
     * Stage 1 real-time copilot: returns a freshly precomputed What-to-say
     * answer if one is available and still contextually valid, so the button
     * press serves instantly instead of generating from scratch.
     */
    servePreAnswer(): { answer: string; question: string } | null {
        const served = this.preAnswer.serve();
        if (served) {
            console.log(`[IntelligenceManager] PreAnswerCache HIT — serving precomputed answer for: "${served.question.substring(0, 60)}..."`);
        }
        return served;
    }

    getPreAnswerStats() {
        return this.preAnswer.getStats();
    }
}
