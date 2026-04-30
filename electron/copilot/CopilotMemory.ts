import type {
    CopilotContextSnapshot,
    CopilotDecision,
    CopilotFeedback,
    CopilotMode,
    CopilotStructuredSummary,
    CopilotTranscriptSegment
} from './types';
import { getContentWords, similarityScore } from './textUtils';

const MAX_SEGMENTS = 80;
const MAX_DECISIONS = 20;
const MAX_FEEDBACK = 50;
const MAX_ROLLING_CHARS = 12_000;

export class CopilotMemory {
    private segments: CopilotTranscriptSegment[] = [];
    private decisions: CopilotDecision[] = [];
    private feedback: CopilotFeedback[] = [];

    addSegment(segment: CopilotTranscriptSegment): CopilotTranscriptSegment | null {
        if (!segment.final) return null;
        const text = segment.text.trim();
        if (!text) return null;

        const last = this.segments[this.segments.length - 1];
        if (last && last.speaker === segment.speaker && last.text === text && Math.abs(last.timestamp - segment.timestamp) < 750) {
            return null;
        }

        const stored = { ...segment, text };
        this.segments.push(stored);
        if (this.segments.length > MAX_SEGMENTS) {
            this.segments = this.segments.slice(-MAX_SEGMENTS);
        }
        return stored;
    }

    getSnapshot(mode: CopilotMode): CopilotContextSnapshot {
        return {
            mode,
            segments: [...this.segments],
            rollingText: this.getRollingText(),
            structuredSummary: this.getStructuredSummary(),
            lastSuggestionAt: this.getLastSuggestionAt(mode),
            recentSuggestions: this.decisions.filter(decision => decision.mode === mode && !!decision.suggestion).slice(-5),
            recentFeedback: this.feedback.slice(-10)
        };
    }

    recordDecision(decision: CopilotDecision): void {
        this.decisions.push(decision);
        if (this.decisions.length > MAX_DECISIONS) {
            this.decisions = this.decisions.slice(-MAX_DECISIONS);
        }
    }

    recordFeedback(feedback: CopilotFeedback): void {
        this.feedback.push(feedback);
        if (this.feedback.length > MAX_FEEDBACK) {
            this.feedback = this.feedback.slice(-MAX_FEEDBACK);
        }
    }

    isRepeatedSuggestion(suggestion: string): boolean {
        return this.decisions
            .filter(decision => !!decision.suggestion)
            .slice(-6)
            .some(decision => similarityScore(decision.suggestion || '', suggestion) >= 0.58);
    }

    shouldBeExtraConservative(): boolean {
        const recent = this.feedback.slice(-5);
        return recent.some(item => item.rating === 'too_early' || item.rating === 'not_relevant');
    }

    reset(): void {
        this.segments = [];
        this.decisions = [];
        this.feedback = [];
    }

    private getLastSuggestionAt(mode: CopilotMode): number | null {
        const last = [...this.decisions]
            .reverse()
            .find(decision => decision.mode === mode && !!decision.suggestion);
        return last?.createdAt ?? null;
    }

    private getRollingText(): string {
        const text = this.segments.map(segment => `${segment.speaker}: ${segment.text}`).join('\n');
        if (text.length <= MAX_ROLLING_CHARS) return text;
        return text.slice(text.length - MAX_ROLLING_CHARS);
    }

    private getStructuredSummary(): CopilotStructuredSummary {
        const segments = this.segments;
        const firstTimestamp = segments[0]?.timestamp ?? Date.now();
        const lastTimestamp = segments[segments.length - 1]?.timestamp ?? firstTimestamp;
        const keyTerms = this.extractKeyTerms(segments.map(segment => segment.text).join(' '));
        const currentTopic = keyTerms.slice(0, 3).join(', ') || undefined;

        return {
            currentTopic,
            previousTopics: this.decisions
                .map(decision => decision.topic)
                .filter((topic): topic is string => !!topic)
                .slice(-5),
            keyTerms,
            segmentCount: segments.length,
            durationMs: Math.max(0, lastTimestamp - firstTimestamp)
        };
    }

    private extractKeyTerms(text: string): string[] {
        const counts = new Map<string, number>();
        for (const word of getContentWords(text)) {
            counts.set(word, (counts.get(word) ?? 0) + 1);
        }

        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([word]) => word);
    }
}
