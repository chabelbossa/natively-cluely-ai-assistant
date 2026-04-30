import { getCopilotModeProfile } from './ModeProfiles';
import { clamp, countWordOverlap } from './textUtils';
import type {
    CopilotContextSnapshot,
    CopilotDecision,
    CopilotQuestionGenerator,
    CopilotSuggestionType
} from './types';

const CONTINUATION_PATTERNS = [
    /\b(and|or|but|because|so|then|therefore|for example|such as)$/i,
    /\b(et|ou|mais|parce que|donc|ensuite|par exemple|c'est-a-dire|c est a dire)$/i,
    /[,;:]$/
];

const CLOSURE_PATTERNS = [
    /\b(therefore|so|as a result|in summary|the key point|this means|that's why)\b/i,
    /\b(donc|en resume|en résumé|cela signifie|ce qui veut dire|c'est pourquoi|on conclut)\b/i,
    /[.!?]$/
];

export class LectureStrategy {
    constructor(
        private readonly generator: CopilotQuestionGenerator,
        private readonly now: () => number = () => Date.now()
    ) {}

    async decide(snapshot: CopilotContextSnapshot): Promise<CopilotDecision> {
        const profile = getCopilotModeProfile(snapshot.mode);
        const sourceSegmentIds = snapshot.segments.slice(-6).map(segment => segment.id);
        const base = {
            id: createDecisionId(),
            mode: snapshot.mode,
            createdAt: this.now(),
            sourceSegmentIds
        };

        if (snapshot.segments.length < profile.minSegments) {
            return {
                ...base,
                action: 'WAIT',
                confidence: 0.25,
                reason: `Need at least ${profile.minSegments} final transcript segments before asking.`
            };
        }

        if (snapshot.structuredSummary.durationMs < profile.minContextMs) {
            return {
                ...base,
                action: 'WAIT',
                confidence: 0.3,
                reason: `Need at least ${Math.round(profile.minContextMs / 1000)} seconds of lecture context.`
            };
        }

        const pointEnd = this.detectPointEnd(snapshot);
        if (!pointEnd.ended) {
            return {
                ...base,
                action: 'WAIT',
                confidence: pointEnd.confidence,
                reason: pointEnd.reason
            };
        }

        const candidate = await this.generator.generateLectureQuestion({
            mode: snapshot.mode,
            rollingText: snapshot.rollingText,
            structuredSummary: snapshot.structuredSummary,
            recentSuggestions: snapshot.recentSuggestions
                .map(decision => decision.suggestion)
                .filter((suggestion): suggestion is string => !!suggestion)
        });

        if (!candidate) {
            return {
                ...base,
                action: 'WAIT',
                confidence: 0.5,
                reason: 'Question generator chose to wait.'
            };
        }

        const confidence = clamp(candidate.confidence, 0, 1);
        if (confidence < profile.minConfidence) {
            return {
                ...base,
                action: 'WAIT',
                confidence,
                topic: candidate.topic,
                reason: `Generated question confidence ${confidence.toFixed(2)} is below threshold.`
            };
        }

        if (!this.isGrounded(candidate.question, snapshot.rollingText, candidate.topic)) {
            return {
                ...base,
                action: 'WAIT',
                confidence: Math.min(confidence, 0.55),
                topic: candidate.topic,
                reason: 'Generated question was not grounded enough in the transcript.'
            };
        }

        return {
            ...base,
            action: 'ASK',
            confidence,
            topic: candidate.topic ?? snapshot.structuredSummary.currentTopic,
            reason: candidate.reason || pointEnd.reason,
            suggestionType: this.normalizeSuggestionType(candidate.suggestionType),
            suggestion: candidate.question
        };
    }

    private detectPointEnd(snapshot: CopilotContextSnapshot): { ended: boolean; confidence: number; reason: string } {
        const last = snapshot.segments[snapshot.segments.length - 1];
        const recentText = snapshot.segments.slice(-3).map(segment => segment.text).join(' ');
        const lastText = last.text.trim();

        if (lastText.length < 35) {
            return { ended: false, confidence: 0.25, reason: 'Latest segment is too short to mark a completed point.' };
        }

        if (CONTINUATION_PATTERNS.some(pattern => pattern.test(lastText))) {
            return { ended: false, confidence: 0.3, reason: 'Latest segment appears to continue the same idea.' };
        }

        const closureSignals = CLOSURE_PATTERNS.filter(pattern => pattern.test(lastText) || pattern.test(recentText)).length;
        const hasEnoughRecentSubstance = recentText.length >= 220;
        const confidence = clamp(0.45 + closureSignals * 0.18 + (hasEnoughRecentSubstance ? 0.18 : 0), 0, 0.9);

        if (closureSignals === 0) {
            return { ended: false, confidence: 0.45, reason: 'No clear closure signal was detected yet.' };
        }

        if (confidence < 0.62) {
            return { ended: false, confidence, reason: 'The current explanation does not look complete yet.' };
        }

        return { ended: true, confidence, reason: 'A lecture point appears to have ended.' };
    }

    private isGrounded(question: string, transcript: string, topic?: string): boolean {
        const questionOverlap = countWordOverlap(question, transcript);
        const topicOverlap = topic ? countWordOverlap(topic, transcript) : 0;
        return questionOverlap >= 2 || (questionOverlap >= 1 && topicOverlap >= 1);
    }

    private normalizeSuggestionType(value: unknown): CopilotSuggestionType {
        const allowed = new Set<CopilotSuggestionType>([
            'course_clarification',
            'course_edge_case',
            'course_application',
            'course_comparison',
            'follow_up_question'
        ]);

        return allowed.has(value as CopilotSuggestionType)
            ? value as CopilotSuggestionType
            : 'course_clarification';
    }
}

function createDecisionId(): string {
    return `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
