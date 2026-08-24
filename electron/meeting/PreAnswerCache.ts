import type { CopilotTranscriptSegment } from '../copilot';

/**
 * PreAnswerCache — stage 1 of the real-time copilot: SILENT PRE-COMPUTATION.
 *
 * Watches final interlocutor transcript segments; when one looks like a
 * question addressed to the user, schedules a background generation of the
 * What-to-say answer using the EXACT same prompt pipeline as the manual
 * button (IntelligenceEngine.precomputeWhatToSay). When the user then presses
 * "What to say", the IPC handler serves the cached answer instantly instead of
 * paying the full generation latency.
 *
 * Hard safety properties:
 *   - NEVER surfaces anything on its own — serving happens only when the user
 *     explicitly presses the button.
 *   - Context-staleness invalidation: an entry records how many final
 *     interlocutor segments existed when its generation STARTED; any new final
 *     segment makes it un-servable (the conversation moved on).
 *   - Cost bounding: quiet-period debounce + minimum interval between
 *     background generations + single in-flight generation.
 */

export interface PreAnswerEntry {
    answer: string;
    question: string;
    createdAt: number;
    /** Number of final interlocutor segments seen when generation started. */
    finalsAtCompute: number;
}

export interface PreAnswerStats {
    generationsStarted: number;
    generationsSucceeded: number;
    serves: number;
    staleSkips: number;
}

const QUIET_PERIOD_MS = 1_200;
const MIN_INTERVAL_BETWEEN_COMPUTES_MS = 8_000;
const MAX_ENTRY_AGE_MS = 25_000;
const MIN_QUESTION_LENGTH = 8;
const MAX_QUESTION_LENGTH = 800;

const QUESTION_EN_START_RE =
    /^\s*(who|what|when|where|why|how|which|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|might|tell me|explain|describe|walk me through|give me|share|any|so,? (can|could|do|does|is|are))\b/i;

const QUESTION_FR_START_RE =
    /^\s*(est-ce que|qu'est-ce|qu\[’']est-ce|pourquoi|comment|quand|où|qui|quel(?:le)?s?|peux-tu|pouvez-vous|pourrais-tu|pourriez-vous|devrais-je|tu peux|vous pouvez|on peut|c'est quoi|dis-moi|parle[- ]moi|explique[- ]moi|donne[- ]moi|tu as|vous avez)\b/i;

function looksLikeQuestion(rawText: string): boolean {
    const text = rawText.trim();
    if (text.length < MIN_QUESTION_LENGTH || text.length > MAX_QUESTION_LENGTH) return false;
    if (/\?\s*$/.test(text)) return true;
    return QUESTION_EN_START_RE.test(text) || QUESTION_FR_START_RE.test(text);
}

function isOwnSpeech(segment: CopilotTranscriptSegment): boolean {
    // 'me' is the user's own mic; 'uncertain' may be a mis-attribution of the
    // user's own voice — skip both so we never precompute an answer to
    // ourselves. Everything else ('interlocutor', speaker_N from diarization)
    // counts as someone else talking.
    return segment.canonicalRole === 'me' || segment.canonicalRole === 'uncertain';
}

export class PreAnswerCache {
    private entry: PreAnswerEntry | null = null;
    private finalCount = 0;
    private latestQuestion: string | null = null;
    private pendingTimer: NodeJS.Timeout | null = null;
    private generating = false;
    private lastComputeStartedAt = 0;
    private readonly generate: (question: string) => Promise<string | null>;
    private readonly onReady?: (question: string) => void;
    private readonly onInvalidate?: () => void;
    private stats: PreAnswerStats = { generationsStarted: 0, generationsSucceeded: 0, serves: 0, staleSkips: 0 };

    constructor(
        generate: (question: string) => Promise<string | null>,
        hooks?: { onReady?: (question: string) => void; onInvalidate?: () => void },
    ) {
        this.generate = generate;
        this.onReady = hooks?.onReady;
        this.onInvalidate = hooks?.onInvalidate;
    }

    /**
     * Feed every FINAL non-own transcript segment here. Bumps the staleness
     * counter (so serve() keeps refusing outdated answers) and, when the
     * segment looks like a question, schedules a debounced background
     * pre-computation.
     *
     * NOTE: we deliberately do NOT retract the UI banner on every new speech —
     * in a flowing conversation that would make it flash for a second and the
     * user would never see it. The banner manages its own dwell time; serve()
     * remains strictly freshness-gated and falls back to fresh generation.
     */
    onFinalSegment(segment: CopilotTranscriptSegment): void {
        if (isOwnSpeech(segment)) return;
        this.finalCount += 1;

        const text = (segment.text || '').trim();
        if (!looksLikeQuestion(text)) return;
        this.latestQuestion = text;

        this.schedulePrecompute();
    }

    private schedulePrecompute(): void {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            void this.precomputeNow();
        }, QUIET_PERIOD_MS);
    }

    private async precomputeNow(): Promise<void> {
        if (this.generating) return;
        if (!this.latestQuestion) return;
        const sinceLast = Date.now() - this.lastComputeStartedAt;
        if (this.lastComputeStartedAt !== 0 && sinceLast < MIN_INTERVAL_BETWEEN_COMPUTES_MS) return;

        const question = this.latestQuestion;
        const finalsAtCompute = this.finalCount;
        this.generating = true;
        this.lastComputeStartedAt = Date.now();
        this.stats.generationsStarted += 1;
        try {
            const answer = await this.generate(question);
            if (answer && answer.trim().length > 0) {
                // Re-check staleness at completion: if new speech arrived while
                // generating, the answer is already outdated — drop it instead
                // of advertising a stale banner.
                if (finalsAtCompute !== this.finalCount) {
                    console.log('[PreAnswerCache] Discarding precomputed answer — conversation moved on during generation.');
                    return;
                }
                this.entry = { answer, question, createdAt: Date.now(), finalsAtCompute };
                this.stats.generationsSucceeded += 1;
                try { this.onReady?.(question); } catch { /* UI hooks must never break routing */ }
                console.log(
                    `[PreAnswerCache] Precomputed answer ready (${answer.length} chars) for: "${question.substring(0, 60)}..."`,
                );
            }
        } catch (error: any) {
            console.warn('[PreAnswerCache] Background pre-compute failed (non-fatal):', error?.message);
        } finally {
            this.generating = false;
        }
    }

    /**
     * Called by the generate-what-to-say IPC handler BEFORE the normal
     * generation path. Returns the cached answer only if it is fresh AND no
     * final interlocutor speech arrived since its generation started.
     */
    serve(): { answer: string; question: string } | null {
        if (!this.entry) return null;
        if (Date.now() - this.entry.createdAt > MAX_ENTRY_AGE_MS) {
            this.stats.staleSkips += 1;
            return null;
        }
        if (this.entry.finalsAtCompute !== this.finalCount) {
            this.stats.staleSkips += 1;
            return null;
        }
        this.stats.serves += 1;
        return { answer: this.entry.answer, question: this.entry.question };
    }

    getStats(): PreAnswerStats {
        return { ...this.stats };
    }

    clear(): void {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        const hadEntry = this.entry !== null;
        this.entry = null;
        this.latestQuestion = null;
        this.finalCount = 0;
        this.lastComputeStartedAt = 0;
        if (hadEntry) {
            try { this.onInvalidate?.(); } catch { /* UI hooks must never break routing */ }
        }
    }
}
