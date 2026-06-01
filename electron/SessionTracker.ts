// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

import { RecapLLM } from './llm';
import { isVerboseLogging } from './verboseLog';
import type { CanonicalTranscriptRole, TranscriptQualityFlag } from './transcript/types';

export interface TranscriptSegment {
    marker?: string;
    speaker: string;
    text: string;
    timestamp: number;
    final: boolean;
    confidence?: number;
    canonicalRole?: CanonicalTranscriptRole;
    source?: 'mic' | 'system' | 'merged';
    qualityFlags?: TranscriptQualityFlag[];
    rawSpeaker?: string;
    speakerId?: number;
}

export interface SuggestionTrigger {
    context: string;
    lastQuestion: string;
    confidence: number;
}

// Context item matching Swift ContextManager structure
export interface ContextItem {
    role: 'interviewer' | 'user' | 'assistant';
    text: string;
    timestamp: number;
    speaker?: string;
    confidence?: number;
    source?: 'live' | 'recorded' | 'assistant';
    canonicalRole?: CanonicalTranscriptRole;
    qualityFlags?: TranscriptQualityFlag[];
}

export interface AssistantResponse {
    text: string;
    timestamp: number;
    questionContext: string;
}

export class SessionTracker {
    // Context management (mirrors Swift ContextManager)
    private contextItems: ContextItem[] = [];
    private readonly contextWindowDuration: number = 120; // 120 seconds
    private readonly maxContextItems: number = 500;

    // Last assistant message for follow-up mode
    private lastAssistantMessage: string | null = null;

    // Temporal RAG: Track all assistant responses in session for anti-repetition
    private assistantResponseHistory: AssistantResponse[] = [];

    // Meeting metadata
    private currentMeetingMetadata: {
        title?: string;
        calendarEventId?: string;
        source?: 'manual' | 'calendar';
    } | null = null;

    // Full Session Tracking (Persisted)
    private fullTranscript: TranscriptSegment[] = [];
    private fullUsage: any[] = []; // UsageInteraction
    private sessionStartTime: number = Date.now();

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private static readonly MAX_EPOCH_SUMMARIES = 5;
    private transcriptEpochSummaries: string[] = [];
    private isCompacting: boolean = false;

    // Track interim interviewer segment
    private lastInterimInterviewer: TranscriptSegment | null = null;

    // Detected coding question from transcript or screenshot extraction
    private detectedCodingQuestion: string | null = null;
    private codingQuestionSource: 'screenshot' | 'transcript' | null = null;
    private codingQuestionSetAt: number | null = null;

    // Rolling buffer for multi-segment interviewer question detection
    private recentInterviewerBuffer: { text: string; timestamp: number }[] = [];
    private static readonly INTERVIEWER_BUFFER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    // Screenshot-detected question stays sticky for 3 min before transcript can override
    private static readonly SCREENSHOT_STALE_MS = 3 * 60 * 1000;

    // Reference to RecapLLM for epoch summarization (injected later)
    private recapLLM: RecapLLM | null = null;

    // ============================================
    // Configuration
    // ============================================

    public setRecapLLM(recapLLM: RecapLLM | null): void {
        this.recapLLM = recapLLM;
    }

    public setMeetingMetadata(metadata: any): void {
        this.currentMeetingMetadata = metadata;
    }

    public getMeetingMetadata() {
        return this.currentMeetingMetadata;
    }

    public clearMeetingMetadata(): void {
        this.currentMeetingMetadata = null;
    }

    // ============================================
    // Coding Question Tracking
    // ============================================

    /**
     * Set the current coding question.
     * Priority rules (avoids stale Q1 blocking Q2 detection in multi-question interviews):
     *  - Screenshot → always stored immediately (explicit user action via Solve)
     *  - Transcript → stored if nothing is known yet, OR if existing question is also from
     *    transcript (newer detection = newer question), OR if screenshot question is stale
     *    (> 3 min old — user likely moved to the next question)
     */
    setCodingQuestion(question: string, source: 'screenshot' | 'transcript'): void {
        const now = Date.now();
        const trimmed = question.trim();
        if (!trimmed) return;

        if (this.detectedCodingQuestion === null) {
            // Nothing stored — accept any source
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question stored (source: ${source}): "${trimmed.substring(0, 80)}..."`);
            return;
        }

        if (source === 'screenshot') {
            // Screenshot always updates immediately (explicit user Solve action)
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question updated via screenshot: "${trimmed.substring(0, 80)}..."`);
            return;
        }

        // source === 'transcript'
        const isStale = this.codingQuestionSetAt !== null
            && (now - this.codingQuestionSetAt) > SessionTracker.SCREENSHOT_STALE_MS;
        const canOverride = this.codingQuestionSource === 'transcript' || isStale;

        if (canOverride) {
            this.detectedCodingQuestion = trimmed;
            this.codingQuestionSource = source;
            this.codingQuestionSetAt = now;
            console.log(`[SessionTracker] Coding question updated via transcript (prev was ${this.codingQuestionSource}, stale=${isStale}): "${trimmed.substring(0, 80)}..."`);
        } else {
            console.log(`[SessionTracker] Transcript question ignored — screenshot question is recent (< ${SessionTracker.SCREENSHOT_STALE_MS / 1000}s)`);
        }
    }

    getDetectedCodingQuestion(): { question: string | null; source: 'screenshot' | 'transcript' | null } {
        return { question: this.detectedCodingQuestion, source: this.codingQuestionSource };
    }

    clearCodingQuestion(): void {
        this.detectedCodingQuestion = null;
        this.codingQuestionSource = null;
        this.codingQuestionSetAt = null;
        this.recentInterviewerBuffer = [];
    }

    /**
     * Heuristic to decide if an interviewer statement looks like a coding question.
     * Requires ≥2 of the signal patterns and minimum length to avoid false positives
     * on casual conversation ("can you implement X?" → yes, "sounds good!" → no).
     */
    private looksLikeCodingQuestion(text: string): boolean {
        if (text.length < 50) return false;
        const patterns = [
            /\b(implement|write|code|solve|design|build|create)\b/i,
            /\b(given\s+(an?|the)\s+(array|string|list|tree|graph|matrix|number|integer|node|linked list|stack|queue|heap))\b/i,
            /\b(return|find\s+(all|the|a|any)|count|check\s+if|determine|calculate|maximize|minimize|sort)\b/i,
            /\b(function|method|algorithm|data structure|class)\b/i,
            /\b(O\(n\)|time complexity|space complexity|optimal|efficient|brute force)\b/i,
            /\b(two sum|three sum|binary search|dynamic programming|BFS|DFS|palindrome|anagram|substring|subarray|rotation)\b/i,
        ];
        const matchCount = patterns.filter(p => p.test(text)).length;
        return matchCount >= 2;
    }

    // ============================================
    // Context Management
    // ============================================

    /**
     * Add a transcript segment to context.
     * Only stores FINAL transcripts.
     * Returns { role, isRefinementCandidate } so the engine can decide whether to trigger follow-up.
     */
    addTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
        if (!segment.final) return null;

        const role = this.mapSpeakerToRole(segment.speaker, segment.canonicalRole);
        const text = segment.text.trim();

        if (!text) return null;

        // Deduplicate: check if this exact item already exists
        const lastItem = this.contextItems[this.contextItems.length - 1];
        if (lastItem &&
            lastItem.role === role &&
            Math.abs(lastItem.timestamp - segment.timestamp) < 500 &&
            lastItem.text === text) {
            return null;
        }

        this.contextItems.push({
            role,
            text,
            timestamp: segment.timestamp,
            speaker: segment.speaker,
            confidence: segment.confidence,
            source: 'live',
            canonicalRole: segment.canonicalRole,
            qualityFlags: segment.qualityFlags
        });

        this.evictOldEntries();

        // Filter out internal system prompts that might be passed via IPC
        const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
            text.startsWith("You are a helper") ||
            text.startsWith("CONTEXT:");

        if (!isInternalPrompt) {
            // Add to session transcript
            this.upsertFullTranscript(segment, text);
            // Compact transcript with summarization instead of losing early context
            // Fire-and-forget: sync context; errors are caught internally
            void this.compactTranscriptIfNeeded().catch(e =>
                console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
            );
        }

        return { role };
    }

    /**
     * Add assistant-generated message to context
     */
    addAssistantMessage(text: string): void {
        console.log(`[SessionTracker] addAssistantMessage called with:`, text.substring(0, 50));

        // Natively-style filtering
        if (!text) return;

        const cleanText = text.trim();
        if (cleanText.length < 10) {
            console.warn(`[SessionTracker] Ignored short message (<10 chars)`);
            return;
        }

        if (cleanText.includes("I'm not sure") ||
            cleanText.includes("I can't answer") ||
            cleanText.includes("Je n'ai pas encore assez de contexte fiable") ||
            cleanText.includes("Je n'ai pas assez de contexte de l'interlocuteur")) {
            console.warn(`[SessionTracker] Ignored fallback message`);
            return;
        }

        this.contextItems.push({
            role: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            speaker: 'assistant',
            confidence: 1,
            source: 'assistant'
        });

        // Also add to fullTranscript so it persists in the session history (and summaries)
        this.fullTranscript.push({
            speaker: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            final: true,
            confidence: 1.0
        });

        // Compact transcript with summarization instead of losing early context
        // Fire-and-forget: sync context; errors are caught internally
        void this.compactTranscriptIfNeeded().catch(e =>
            console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
        );

        this.lastAssistantMessage = cleanText;

        // Temporal RAG: Track response history for anti-repetition
        this.assistantResponseHistory.push({
            text: cleanText,
            timestamp: Date.now(),
            questionContext: this.getLastInterviewerTurn() || 'unknown'
        });

        // Keep history bounded (last 10 responses)
        if (this.assistantResponseHistory.length > 10) {
            this.assistantResponseHistory = this.assistantResponseHistory.slice(-10);
        }

        console.log(`[SessionTracker] lastAssistantMessage updated, history size: ${this.assistantResponseHistory.length}`);
        this.evictOldEntries();
    }

    /**
     * Handle incoming transcript from native audio service
     */
    handleTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
        // Track interim segments for interviewer to prevent data loss on stop
        const transcriptRole = this.mapSpeakerToRole(segment.speaker, segment.canonicalRole);
        if (transcriptRole === 'user') {
            if (isVerboseLogging() && (Math.random() < 0.05 || segment.final)) {
                console.log(`[SessionTracker] RX User Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }
        }
        if (transcriptRole === 'interviewer') {
            if (isVerboseLogging() && (Math.random() < 0.05 || segment.final)) {
                console.log(`[SessionTracker] RX Interviewer Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }

            if (!segment.final) {
                this.lastInterimInterviewer = segment;
            } else {
                this.lastInterimInterviewer = null;

                // Add segment to rolling buffer and evict old entries
                this.recentInterviewerBuffer.push({ text: segment.text, timestamp: segment.timestamp });
                const bufferCutoff = Date.now() - SessionTracker.INTERVIEWER_BUFFER_WINDOW_MS;
                this.recentInterviewerBuffer = this.recentInterviewerBuffer.filter(e => e.timestamp >= bufferCutoff);

                // Test single segment first; if no match, test accumulated recent turns
                // (interviewer may state a problem across multiple speech segments)
                if (this.looksLikeCodingQuestion(segment.text)) {
                    this.setCodingQuestion(segment.text, 'transcript');
                } else if (this.recentInterviewerBuffer.length > 1) {
                    const combinedText = this.recentInterviewerBuffer.map(e => e.text).join(' ');
                    if (this.looksLikeCodingQuestion(combinedText)) {
                        this.setCodingQuestion(combinedText, 'transcript');
                    }
                }
            }
        }

        return this.addTranscript(segment);
    }

    /**
     * Persist a final transcript segment without adding it to the live LLM context.
     * Useful for microphone capture: we want the post-meeting transcript/summary to
     * include it, but we don't want passive answers to treat mic echo as interviewer context.
     */
    recordTranscriptOnly(segment: TranscriptSegment): void {
        if (!segment.final) return;

        const text = segment.text.trim();
        if (!text) return;

        const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
            text.startsWith("You are a helper") ||
            text.startsWith("CONTEXT:");

        if (isInternalPrompt) return;

        this.upsertFullTranscript(segment, text);
        void this.compactTranscriptIfNeeded().catch(e =>
            console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
        );
    }

    // ============================================
    // Context Accessors
    // ============================================

    /**
     * Get context items within the last N seconds
     */
    getContext(lastSeconds: number = 120): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.contextItems.filter(item => item.timestamp >= cutoff);
    }

    getLastAssistantMessage(): string | null {
        return this.lastAssistantMessage;
    }

    getAssistantResponseHistory(): AssistantResponse[] {
        return this.assistantResponseHistory;
    }

    getLastInterimInterviewer(): TranscriptSegment | null {
        return this.lastInterimInterviewer;
    }

    /**
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const items = this.getContext(lastSeconds);
        return items.map(item => {
            const label = this.formatRoleLabel(item);
            return `[${label}]: ${item.text}`;
        }).join('\n');
    }

    /**
     * Explicit action buttons should use what the user can see in the transcript
     * panel. Passive context intentionally ignores mic-only audio, but buttons
     * like What to answer, Clarify, Follow-up and Answer are deliberate user
     * requests, so they can safely fall back to the persisted visible transcript.
     */
    getActionContext(lastSeconds: number = 120): ContextItem[] {
        const trustedContext = this.getContext(lastSeconds).map(item => ({
            ...item,
            source: item.source ?? ('live' as const)
        }));
        const recordedContext = this.getRecordedTranscriptContext(lastSeconds);

        const merged = recordedContext.length === 0
            ? trustedContext
            : this.mergeContextItems(trustedContext, recordedContext);

        return this.selectReliableActionContext(merged);
    }

    getFormattedActionContext(lastSeconds: number = 120): string {
        const items = this.getActionContext(lastSeconds);
        if (items.length === 0) return '';

        return `${this.getActionContextContract()}\n\n${items.map(item => this.formatActionContextItem(item)).join('\n')}`;
    }

    getActionContextDiagnostics(lastSeconds: number = 120): string[] {
        const items = this.getActionContext(lastSeconds);
        const counts = items.reduce((acc, item) => {
            const key = item.role === 'interviewer'
                ? this.isUncertainSpeakerLabel(item) ? 'interlocutor_uncertain' : 'interlocutor'
                : item.role;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        const lastInterlocutor = [...items].reverse().find(item => item.role === 'interviewer');

        return [
            'action_context_policy=interlocutor_first_no_mic_relabel',
            `action_context_items=${items.length}`,
            `action_context_counts=${JSON.stringify(counts)}`,
            `action_context_has_interlocutor=${Boolean(lastInterlocutor)}`,
            `action_context_last_interlocutor=${lastInterlocutor ? this.truncateForDiagnostics(lastInterlocutor.text, 180) : 'none'}`
        ];
    }

    /**
     * Get the last interviewer turn
     */
    getLastInterviewerTurn(): string | null {
        for (let i = this.contextItems.length - 1; i >= 0; i--) {
            if (this.contextItems[i].role === 'interviewer') {
                return this.contextItems[i].text;
            }
        }
        return null;
    }

    getLastInterviewerTurnForActions(lastSeconds: number = 180): string | null {
        const actionContext = this.getActionContext(lastSeconds);
        for (let i = actionContext.length - 1; i >= 0; i--) {
            if (actionContext[i].role === 'interviewer') {
                return actionContext[i].text;
            }
        }
        return null;
    }

    /**
     * Get full session context from accumulated transcript (User + Interviewer + Assistant)
     */
    getFullSessionContext(): string {
        const recentTranscript = this.fullTranscript.map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker, segment.canonicalRole);
            const label = this.formatRoleLabel({
                role,
                speaker: segment.speaker,
                canonicalRole: segment.canonicalRole
            });
            return `[${label}]: ${segment.text}`;
        }).join('\n');

        // Prepend epoch summaries for full session context preservation
        if (this.transcriptEpochSummaries.length > 0) {
            const epochContext = this.transcriptEpochSummaries.join('\n---\n');
            return `[SESSION HISTORY - EARLIER DISCUSSION]\n${epochContext}\n\n[RECENT TRANSCRIPT]\n${recentTranscript}`;
        }

        return recentTranscript;
    }

    // ============================================
    // Session Data Accessors (for MeetingPersistence)
    // ============================================

    getFullTranscript(): TranscriptSegment[] {
        return this.fullTranscript;
    }

    getFullUsage(): any[] {
        return this.fullUsage;
    }

    getSessionStartTime(): number {
        return this.sessionStartTime;
    }

    // ============================================
    // Usage Tracking
    // ============================================

    /**
     * Cap usage array with simple eviction (usage doesn't need summarization)
     */
    capUsageArray(): void {
        if (this.fullUsage.length > 500) {
            this.fullUsage = this.fullUsage.slice(-500);
        }
    }

    /**
     * Public method to log usage from external sources (e.g. IPC direct chat)
     */
    logUsage(type: string, question: string, answer: string): void {
        this.fullUsage.push({
            type,
            timestamp: Date.now(),
            question,
            answer
        });
    }

    pushUsage(entry: any): void {
        this.fullUsage.push(entry);
        this.capUsageArray();
    }

    // ============================================
    // Interim Transcript Flush
    // ============================================

    /**
     * Force-save any pending interim transcript (called on meeting stop)
     */
    flushInterimTranscript(): void {
        if (this.lastInterimInterviewer) {
            console.log('[SessionTracker] Force-saving pending interim transcript:', this.lastInterimInterviewer.text);
            const finalSegment = { ...this.lastInterimInterviewer, final: true };
            this.addTranscript(finalSegment);
            this.lastInterimInterviewer = null;
        }
    }

    // ============================================
    // Reset
    // ============================================

    reset(): void {
        this.contextItems = [];
        this.fullTranscript = [];
        this.fullUsage = [];
        this.transcriptEpochSummaries = [];
        this.sessionStartTime = Date.now();
        this.lastAssistantMessage = null;
        this.assistantResponseHistory = [];
        this.lastInterimInterviewer = null;
        this.detectedCodingQuestion = null;
        this.codingQuestionSource = null;
        this.codingQuestionSetAt = null;
        this.recentInterviewerBuffer = [];
    }

    // ============================================
    // Private Helpers
    // ============================================

    mapSpeakerToRole(speaker: string, canonicalRole?: CanonicalTranscriptRole): 'interviewer' | 'user' | 'assistant' {
        if (canonicalRole) {
            if (canonicalRole === 'me') return 'user';
            if (canonicalRole === 'assistant') return 'assistant';
            return 'interviewer';
        }

        const normalized = String(speaker || '').toLowerCase();
        if (['user', 'me', 'mic', 'microphone'].includes(normalized)) return 'user';
        if (['assistant', 'ai', 'model'].includes(normalized)) return 'assistant';
        return 'interviewer'; // system audio = interviewer
    }

    private upsertFullTranscript(segment: TranscriptSegment, textOverride?: string): void {
        const text = (textOverride ?? segment.text).trim();
        if (!text) return;

        const next: TranscriptSegment = { ...segment, text };
        const last = this.fullTranscript[this.fullTranscript.length - 1];
        if (last && last.speaker === next.speaker) {
            const elapsed = Math.abs(next.timestamp - last.timestamp);
            const lastText = this.normalizeTranscriptForComparison(last.text);
            const nextText = this.normalizeTranscriptForComparison(next.text);

            if (lastText && nextText && elapsed < 45_000) {
                if (lastText === nextText || lastText.includes(nextText)) {
                    return;
                }
                if (nextText.includes(lastText)) {
                    this.fullTranscript[this.fullTranscript.length - 1] = next;
                    return;
                }

                const similarity = this.transcriptSimilarity(lastText, nextText);
                if (similarity >= 0.82) {
                    if (nextText.length > lastText.length) {
                        this.fullTranscript[this.fullTranscript.length - 1] = next;
                    }
                    return;
                }
            }
        }

        this.fullTranscript.push(next);
    }

    private getRecordedTranscriptContext(lastSeconds: number): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.fullTranscript
            .filter(segment => segment.final && segment.timestamp >= cutoff)
            .map(segment => ({
                role: this.mapSpeakerToRole(segment.speaker, segment.canonicalRole),
                text: segment.text.trim(),
                timestamp: segment.timestamp,
                speaker: segment.speaker,
                confidence: segment.confidence,
                source: 'recorded' as const,
                canonicalRole: segment.canonicalRole,
                qualityFlags: segment.qualityFlags
            }))
            .filter(item => item.text.length > 0);
    }

    private getActionContextContract(): string {
        return `[ACTION CONTEXT CONTRACT]
- ME / Mic / user = the local user. Use these lines only as the user's own words or explicit question.
- INTERLOCUTOR = the other participant(s), professor, client, manager, recruiter, or system audio.
- Canonical roles from TranscriptRouter are authoritative: ME is local mic, INTERLOCUTOR/SPEAKER_* is system audio.
- Action buttons must primarily answer, clarify, or suggest questions from INTERLOCUTOR context.
- DIARIZATION_UNCERTAIN can be noisy or mixed. Use it only when it matches nearby INTERLOCUTOR context.
- If only ME is available, say the conversation context is insufficient instead of inventing what the interlocutor said.`;
    }

    private selectReliableActionContext(items: ContextItem[]): ContextItem[] {
        const meaningful = items
            .filter(item => this.isUsefulActionContextItem(item))
            .sort((a, b) => a.timestamp - b.timestamp);

        const reliableInterlocutor = meaningful.filter(item =>
            item.role === 'interviewer' && !this.isUncertainSpeakerLabel(item)
        );
        const uncertainInterlocutor = meaningful.filter(item =>
            item.role === 'interviewer' && this.isUncertainSpeakerLabel(item)
        );
        const interlocutorForEchoCheck = [...reliableInterlocutor, ...uncertainInterlocutor];
        const localUser = meaningful.filter(item =>
            item.role === 'user' &&
            this.isTrustedLocalUserContextItem(item, interlocutorForEchoCheck)
        );
        const assistant = meaningful.filter(item => item.role === 'assistant');

        const hasInterlocutor = reliableInterlocutor.length > 0 || uncertainInterlocutor.length > 0;
        const selected: ContextItem[] = [];

        if (hasInterlocutor) {
            selected.push(...this.takeRecent(reliableInterlocutor, 14));
            selected.push(...this.takeRecent(uncertainInterlocutor, reliableInterlocutor.length > 0 ? 2 : 6));
            selected.push(...this.takeRecent(localUser, 2));
            selected.push(...this.takeRecent(assistant, 1));
        } else {
            selected.push(...this.takeRecent(localUser, 6));
            selected.push(...this.takeRecent(assistant, 2));
        }

        return this.mergeContextItems([], selected)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-18);
    }

    private isUsefulActionContextItem(item: ContextItem): boolean {
        const text = item.text.trim();
        if (!text) return false;

        const normalized = this.normalizeTranscriptForComparison(text);
        if (!normalized) return false;

        const words = normalized.split(' ').filter(Boolean);
        if (item.role !== 'interviewer' && words.length < 3) return false;

        if (this.isLowValueTranscriptText(normalized)) return false;

        if (this.isUncertainSpeakerLabel(item) && text.length > 1600) {
            return false;
        }

        const flags = new Set(item.qualityFlags || []);
        if (flags.has('late_flush_duplicate') || flags.has('mic_rejected')) return false;
        if (flags.has('stt_low_quality') && item.role !== 'interviewer') return false;
        if (item.role === 'user' && (flags.has('echo_suspect') || flags.has('mic_gate_held'))) {
            return this.looksLikeDirectLocalQuestion(text) && text.length <= 240;
        }

        return true;
    }

    private isLowValueTranscriptText(normalizedText: string): boolean {
        if (normalizedText.length < 4) return true;
        return /^(ok|okay|merci|thank you|thanks|bonjour|hello|allo|oui|non|d accord|daccord|parfait|super)$/.test(normalizedText);
    }

    private isUncertainSpeakerLabel(item: ContextItem): boolean {
        if (item.canonicalRole === 'uncertain') return true;
        if (this.isReliableInterlocutorCanonicalRole(item.canonicalRole)) return false;
        const speaker = String(item.speaker || '').toLowerCase();
        if (/^locuteur[_-]?\d+$/.test(speaker) || /^speaker[_-]?\d+$/.test(speaker)) return false;
        return speaker === 'unknown' || speaker === 'speaker';
    }

    private isTrustedLocalUserContextItem(item: ContextItem, interlocutorItems: ContextItem[]): boolean {
        const text = item.text.trim();
        if (!text) return false;
        if (text.length > 650) return false;

        const flags = new Set(item.qualityFlags || []);
        if (flags.has('mic_rejected') || flags.has('echo_suspect')) return false;
        if (flags.has('low_confidence') && text.length > 180) return false;

        const localScore = this.scoreLocalUserIntent(text);
        const directQuestion = this.looksLikeDirectLocalQuestion(text);
        const hasOverlapFlag = flags.has('possible_overlap') || flags.has('mic_gate_held');

        if (hasOverlapFlag && localScore < 0.62 && !directQuestion) return false;

        const normalized = this.normalizeTranscriptForComparison(text);
        const similarToInterlocutor = interlocutorItems.some(other => {
            const otherText = this.normalizeTranscriptForComparison(other.text);
            if (!otherText || otherText.length < 25) return false;
            const elapsed = Math.abs(item.timestamp - other.timestamp);
            if (elapsed > 120_000) return false;
            return this.transcriptSimilarity(normalized, otherText) >= 0.42 ||
                (normalized.length > 60 && otherText.includes(normalized.slice(0, Math.min(80, normalized.length))));
        });

        if (similarToInterlocutor && localScore < 0.75) return false;

        return localScore >= 0.42 || directQuestion;
    }

    private scoreLocalUserIntent(text: string): number {
        const normalized = this.normalizeTranscriptForComparison(text);
        const words = normalized.split(' ').filter(Boolean);
        if (words.length === 0) return 0;

        let score = 0;
        if (this.looksLikeDirectLocalQuestion(text)) score += 0.42;
        if (/\b(si je comprends|j ai bien compris|je veux comprendre|je voulais demander|je voudrais savoir|j aimerais savoir|ce que je demandais|pour mieux comprendre|je veux etre certain|je veux être certain)\b/i.test(normalized)) score += 0.38;
        if (/\b(pouvez vous|peux tu|tu peux|est ce que|confirmer|préciser|preciser|clarifier|explique|expliquer|dis moi|dites moi)\b/i.test(normalized)) score += 0.24;
        if (/\b(je|j ai|j aimerais|je veux|je voudrais|moi|mon|ma|mes|nous|on peut|i|me|my|we)\b/i.test(normalized)) score += 0.14;
        if (words.length > 80) score -= 0.3;
        if (words.length > 120) score -= 0.5;

        return Math.max(0, Math.min(1, score));
    }

    private looksLikeDirectLocalQuestion(text: string): boolean {
        const normalized = this.normalizeTranscriptForComparison(text);
        const words = normalized.split(' ').filter(Boolean);
        if (words.length === 0 || words.length > 90) return false;
        if (/\?$/.test(text.trim())) return true;
        return /(^|\b)(est ce que|pourquoi|comment|quand|quel|quelle|quels|quelles|combien|où|ou est|pouvez vous|peux tu|tu peux|vous pouvez|can you|could you|what|why|how|when|where|which)\b/i.test(normalized);
    }

    private takeRecent<T>(items: T[], count: number): T[] {
        if (count <= 0) return [];
        return items.slice(-count);
    }

    private truncateForDiagnostics(text: string, maxLength: number): string {
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean.length <= maxLength) return clean;
        return `${clean.slice(0, maxLength - 3)}...`;
    }

    private formatActionContextItem(item: ContextItem): string {
        const label = this.formatRoleLabel(item);
        return `[${label}]: ${item.text}`;
    }

    private formatRoleLabel(item: Pick<ContextItem, 'role' | 'speaker' | 'canonicalRole'>): string {
        if (item.role === 'user') return 'ME (LOCAL MIC)';
        if (item.role === 'assistant') return 'ASSISTANT (PREVIOUS SUGGESTION)';
        if (item.canonicalRole === 'uncertain') return 'INTERLOCUTOR (DIARIZATION_UNCERTAIN)';

        const speakerLabel = this.resolveInterlocutorSpeakerLabel(item.canonicalRole, item.speaker);
        return speakerLabel ? `INTERLOCUTOR_${speakerLabel}` : 'INTERLOCUTOR';
    }

    private resolveInterlocutorSpeakerLabel(canonicalRole?: CanonicalTranscriptRole, speaker?: string): string | null {
        const canonical = this.extractOneBasedSpeakerNumber(canonicalRole);
        if (canonical !== null) return `SPEAKER_${canonical}`;

        const rawSpeaker = String(speaker || '').toLowerCase();
        const speakerMatch = /^speaker[_-]?(\d+)$/i.exec(rawSpeaker);
        if (speakerMatch) return `SPEAKER_${Number(speakerMatch[1])}`;

        const locuteurMatch = /^locuteur[_-]?(\d+)$/i.exec(rawSpeaker);
        if (locuteurMatch) return `SPEAKER_${Number(locuteurMatch[1]) + 1}`;

        return null;
    }

    private extractOneBasedSpeakerNumber(role?: CanonicalTranscriptRole): number | null {
        if (!role) return null;
        const match = /^speaker_(\d+)$/i.exec(role);
        if (!match) return null;
        const value = Number(match[1]);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    private isReliableInterlocutorCanonicalRole(role?: CanonicalTranscriptRole): boolean {
        return role === 'interlocutor' || this.extractOneBasedSpeakerNumber(role) !== null;
    }

    private mergeContextItems(primary: ContextItem[], secondary: ContextItem[]): ContextItem[] {
        const merged: ContextItem[] = [];

        for (const item of [...primary, ...secondary].sort((a, b) => a.timestamp - b.timestamp)) {
            const normalizedText = this.normalizeTranscriptForComparison(item.text);
            const duplicate = merged.some(existing =>
                existing.role === item.role &&
                Math.abs(existing.timestamp - item.timestamp) < 1000 &&
                this.normalizeTranscriptForComparison(existing.text) === normalizedText
            );

            if (!duplicate) {
                merged.push(item);
            }
        }

        return merged;
    }

    private normalizeTranscriptForComparison(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private transcriptSimilarity(a: string, b: string): number {
        const aWords = a.split(' ').filter(Boolean);
        const bWords = b.split(' ').filter(Boolean);
        if (aWords.length === 0 || bWords.length === 0) return 0;

        const aSet = new Set(aWords);
        const bSet = new Set(bWords);
        let intersection = 0;
        for (const word of aSet) {
            if (bSet.has(word)) intersection++;
        }

        const union = new Set([...aSet, ...bSet]).size;
        return union === 0 ? 0 : intersection / union;
    }

    private evictOldEntries(): void {
        const cutoff = Date.now() - (this.contextWindowDuration * 1000);
        this.contextItems = this.contextItems.filter(item => item.timestamp >= cutoff);

        // Safety limit
        if (this.contextItems.length > this.maxContextItems) {
            this.contextItems = this.contextItems.slice(-this.maxContextItems);
        }
    }

    /**
     * Compact transcript buffer by summarizing oldest entries into an epoch summary.
     * Called instead of raw slice() to preserve early meeting context.
     */
    private async compactTranscriptIfNeeded(): Promise<void> {
        if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

        this.isCompacting = true;
        try {
            // Take the oldest 500 entries to summarize
            const summarizeCount = 500;
            const oldEntries = this.fullTranscript.slice(0, summarizeCount);
            const summaryInput = oldEntries.map(seg => {
                const role = this.mapSpeakerToRole(seg.speaker, seg.canonicalRole);
                const label = this.formatRoleLabel({
                    role,
                    speaker: seg.speaker,
                    canonicalRole: seg.canonicalRole
                });
                return `[${label}]: ${seg.text}`;
            }).join('\n');

            // Fire-and-forget LLM summarization (non-blocking)
            if (this.recapLLM) {
                try {
                    const epochSummary = await this.recapLLM.generate(
                        `Summarize this conversation segment into 3-5 concise bullet points preserving key topics, decisions, and questions:\n\n${summaryInput}`
                    );
                    if (epochSummary && epochSummary.trim().length > 0) {
                        this.transcriptEpochSummaries.push(epochSummary.trim());
                        console.log(`[SessionTracker] Epoch summary created (${this.transcriptEpochSummaries.length} total)`);
                    } else {
                        // Empty LLM response — store a basic marker so context is not lost
                        const marker = `[Earlier discussion: ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                        this.transcriptEpochSummaries.push(marker);
                    }
                } catch (e) {
                    // If summarization fails, store a simple marker
                    const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                    this.transcriptEpochSummaries.push(fallback);
                    console.warn('[SessionTracker] Epoch summarization failed, using fallback marker');
                }
            } else {
                // BUG-03 fix: recapLLM not yet available — always push a plain marker so early
                // context is not silently discarded with no record in transcriptEpochSummaries.
                const marker = `[Earlier discussion (no LLM): ${oldEntries.length} segments — ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                this.transcriptEpochSummaries.push(marker);
                console.warn('[SessionTracker] recapLLM not available — storing plain epoch marker');
            }

            // Cap epoch summaries to prevent LLM context window overflow
            if (this.transcriptEpochSummaries.length > SessionTracker.MAX_EPOCH_SUMMARIES) {
                this.transcriptEpochSummaries = this.transcriptEpochSummaries.slice(-SessionTracker.MAX_EPOCH_SUMMARIES);
            }

            // Evict ONLY the exact 500 oldest entries that we just summarized
            this.fullTranscript = this.fullTranscript.slice(summarizeCount);
        } finally {
            this.isCompacting = false;
        }
    }
}
