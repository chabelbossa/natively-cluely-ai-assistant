import type {
    CopilotContextSnapshot,
    CopilotDecision,
    CopilotFeedback,
    CopilotMode,
    CopilotStructuredSummary,
    CopilotTranscriptSegment,
    DetectedRisk,
} from './types';
import { getContentWords, similarityScore } from './textUtils';
import { DecisionTracker } from './DecisionTracker';
import { RiskRadar } from './RiskRadar';

const MAX_SEGMENTS = 80;
const MAX_DECISIONS = 20;
const MAX_FEEDBACK = 50;
const MAX_ROLLING_CHARS = 12_000;

export class CopilotMemory {
    private segments: CopilotTranscriptSegment[] = [];
    private decisions: CopilotDecision[] = [];
    private feedback: CopilotFeedback[] = [];
    public readonly tracker = new DecisionTracker();
    public readonly radar = new RiskRadar();

    getSegments(): CopilotTranscriptSegment[] {
        return this.segments;
    }

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
        this.tracker.observeTranscript(stored);
        if (this.segments.length > MAX_SEGMENTS) {
            this.segments = this.segments.slice(-MAX_SEGMENTS);
        }
        return stored;
    }

    getSnapshot(mode: CopilotMode): CopilotContextSnapshot {
        const metrics = this.tracker.getHealthMetrics();
        const risks = this.radar.scan(this.segments);

        return {
            mode,
            segments: [...this.segments],
            rollingText: this.getRollingText(),
            structuredSummary: this.getStructuredSummary(),
            lastSuggestionAt: this.getLastSuggestionAt(mode),
            recentSuggestions: this.decisions.filter(d => d.mode === mode && !!d.suggestion).slice(-5),
            recentFeedback: this.feedback.slice(-10),
            meetingHealth: {
                clarityScore: metrics.clarityScore,
                openRisks: metrics.openRisks,
                confirmedDecisions: metrics.confirmedDecisions,
                unassignedActions: metrics.unassignedActions,
                openQuestions: metrics.openQuestions,
                readyToSuggest: metrics.readyToSuggest,
                decisions: this.tracker.getState().decisions.map(d => ({ what: d.what, owner: d.owner })),
                risks: this.tracker.getState().risks.map(r => ({ description: r.description, severity: r.severity })),
                actions: this.tracker.getState().actionItems.slice(-6),
                constraints: this.tracker.getState().constraints.slice(-6),
                topics: this.tracker.getState().topics.slice(-8),
                deadlines: this.tracker.getState().deadlines.slice(-6),
                responsibilities: this.tracker.getState().responsibilities.slice(-6),
                summarySoFar: this.tracker.getSummary(),
            },
            detectedRisks: risks.map(r => ({
                type: r.type,
                explanation: r.explanation,
                severity: r.severity,
                suggestion: r.suggestion,
            })) as DetectedRisk[],
        };
    }

    recordDecision(decision: CopilotDecision): void {
        this.decisions.push(decision);
        if (this.decisions.length > MAX_DECISIONS) {
            this.decisions = this.decisions.slice(-MAX_DECISIONS);
        }

        // Auto-track decisions from copilot feedback
        if (decision.suggestion && decision.topic) {
            this.tracker.addDecision({
                what: decision.topic,
                confidence: decision.confidence,
            });
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
            .filter(d => !!d.suggestion)
            .slice(-6)
            .some(d => similarityScore(d.suggestion || '', suggestion) >= 0.58);
    }

    shouldBeExtraConservative(): boolean {
        const recent = this.feedback.slice(-5);
        return recent.some(item => item.rating === 'too_early' || item.rating === 'not_relevant');
    }

    reset(): void {
        this.segments = [];
        this.decisions = [];
        this.feedback = [];
        this.tracker.reset();
    }

    private getLastSuggestionAt(mode: CopilotMode): number | null {
        const last = [...this.decisions]
            .reverse()
            .find(d => d.mode === mode && !!d.suggestion);
        return last?.createdAt ?? null;
    }

    private getRollingText(): string {
        const text = this.segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
        if (text.length <= MAX_ROLLING_CHARS) return text;
        return text.slice(text.length - MAX_ROLLING_CHARS);
    }

    private getStructuredSummary(): CopilotStructuredSummary {
        const segments = this.segments;
        const firstTimestamp = segments[0]?.timestamp ?? Date.now();
        const lastTimestamp = segments[segments.length - 1]?.timestamp ?? firstTimestamp;
        const keyTerms = this.extractKeyTerms(segments.map(s => s.text).join(' '));
        const currentTopic = keyTerms.slice(0, 3).join(', ') || undefined;

        return {
            currentTopic,
            previousTopics: this.decisions
                .map(d => d.topic)
                .filter((topic): topic is string => !!topic)
                .slice(-5),
            keyTerms,
            segmentCount: segments.length,
            durationMs: Math.max(0, lastTimestamp - firstTimestamp),
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
