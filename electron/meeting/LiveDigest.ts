/**
 * LiveDigest — comprehension aid for non-native speakers.
 *
 * Periodically reformulates the latest stretch of the meeting transcript in
 * SIMPLE language (French by default) so the user can follow an English
 * meeting without re-reading raw transcripts. This is deliberately SEPARATE
 * from the copilot suggestion engine: it never generates answers, it only
 * compresses what was already said.
 *
 * Cost bounding mirrors PreAnswerCache: trailing-edge debounce, minimum
 * interval between LLM calls, single in-flight generation, and a hard cap on
 * how much transcript text is sent per refresh.
 */

export interface LiveDigest {
    text: string;
    updatedAt: number;
    /** Approximate transcript end-timestamp this digest covers. */
    coversThrough: number;
}

/** Output language for the simplified reformulation. */
const DIGEST_LANG: 'fr' | 'en' = 'fr';
const QUIET_PERIOD_MS = 4_000;
const MIN_INTERVAL_BETWEEN_UPDATES_MS = 20_000;
const MAX_CONTEXT_CHARS = 2_400;
const MAX_DIGEST_CHARS = 480;

const SYSTEM_PROMPT = [
    'You are a live comprehension assistant inside a meeting tool.',
    'The user reads your output WHILE the meeting continues: it must be instant to parse.',
    `Reformulate the LATEST part of the meeting transcript below in SIMPLE ${DIGEST_LANG === 'fr' ? 'FRENCH' : 'ENGLISH'}.`,
    'Rules:',
    '- Maximum 3 short sentences, plain everyday words, no jargon.',
    '- Present tense. Say what was just said / asked / decided, and by whom when known.',
    '- Never quote verbatim, never add information that is not in the transcript.',
    '- No preamble, no headings, no quotation marks — ONLY the reformulation.',
    '- If the transcript excerpt contains nothing meaningful yet, reply with exactly: NONE',
].join('\n');

function trimTo(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

export class LiveDigestService {
    private current: LiveDigest | null = null;
    private pendingTimer: NodeJS.Timeout | null = null;
    private generating = false;
    private lastUpdateStartedAt = 0;
    private readonly getRecentTranscript: () => string;
    private readonly generate: (systemPrompt: string, context: string) => Promise<string | null>;
    private readonly onUpdate?: (digest: LiveDigest | null) => void;
    private stats = { updatesStarted: 0, updatesSucceeded: 0 };

    constructor(
        getRecentTranscript: () => string,
        generate: (systemPrompt: string, context: string) => Promise<string | null>,
        hooks?: { onUpdate?: (digest: LiveDigest | null) => void },
    ) {
        this.getRecentTranscript = getRecentTranscript;
        this.generate = generate;
        this.onUpdate = hooks?.onUpdate;
    }

    /**
     * Feed every FINAL transcript segment (any speaker except the user's own
     * mic channel) so the digest stays current with the conversation flow.
     */
    onFinalSegment(): void {
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            void this.updateNow();
        }, QUIET_PERIOD_MS);
    }

    private async updateNow(): Promise<void> {
        if (this.generating) return;
        const sinceLast = Date.now() - this.lastUpdateStartedAt;
        if (this.lastUpdateStartedAt !== 0 && sinceLast < MIN_INTERVAL_BETWEEN_UPDATES_MS) return;

        const context = trimTo(this.getRecentTranscript(), MAX_CONTEXT_CHARS);
        if (!context || context.length < 40) return;

        this.generating = true;
        this.lastUpdateStartedAt = Date.now();
        this.stats.updatesStarted += 1;
        try {
            const raw = await this.generate(SYSTEM_PROMPT, context);
            const cleaned = (raw || '').trim();
            if (!cleaned || /^none\b/i.test(cleaned)) return;
            this.current = {
                text: trimTo(cleaned, MAX_DIGEST_CHARS),
                updatedAt: Date.now(),
                coversThrough: Date.now(),
            };
            this.stats.updatesSucceeded += 1;
            try { this.onUpdate?.(this.current); } catch { /* UI hooks must never break routing */ }
            console.log(`[LiveDigest] Refreshed (${this.current.text.length} chars): "${this.current.text.substring(0, 60)}..."`);
        } catch (error: any) {
            console.warn('[LiveDigest] Update failed (non-fatal):', error?.message);
        } finally {
            this.generating = false;
        }
    }

    getCurrent(): LiveDigest | null {
        return this.current;
    }

    getStats() {
        return { ...this.stats };
    }

    clear(): void {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        const had = this.current !== null;
        this.current = null;
        this.lastUpdateStartedAt = 0;
        if (had) {
            try { this.onUpdate?.(null); } catch { /* UI hooks must never break routing */ }
        }
    }
}
