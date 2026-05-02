import { LLMHelper } from '../LLMHelper';
import { ModesManager } from '../services/ModesManager';
import { CopilotMemory } from './CopilotMemory';
import { LectureQuestionLLM } from './LectureQuestionLLM';
import { LectureStrategy } from './LectureStrategy';
import { getCopilotModeProfile, LECTURE_LIKE_MODES, resolveCopilotMode } from './ModeProfiles';
import { ProfessionalMeetingLLM } from './ProfessionalMeetingLLM';
import { ProfessionalMeetingStrategy } from './ProfessionalMeetingStrategy';
import type {
    CopilotDecision,
    CopilotFeedback,
    CopilotMode,
    CopilotTranscriptSegment
} from './types';

export class CopilotDecisionEngine {
    private readonly memory = new CopilotMemory();
    private readonly lectureStrategy: LectureStrategy;
    private readonly professionalStrategy: ProfessionalMeetingStrategy;
    private isGenerating = false;

    constructor(llmHelper: LLMHelper) {
        this.lectureStrategy = new LectureStrategy(new LectureQuestionLLM(llmHelper));
        this.professionalStrategy = new ProfessionalMeetingStrategy(
            new ProfessionalMeetingLLM(llmHelper),
        );
    }

    async handleTranscript(segment: CopilotTranscriptSegment): Promise<CopilotDecision | null> {
        if (!this.shouldObserveSegment(segment)) return null;

        const mode = this.getActiveCopilotMode();
        if (!mode) return null;

        const stored = this.memory.addSegment(segment);
        if (!stored) return null;

        const profile = getCopilotModeProfile(mode);
        const snapshot = this.memory.getSnapshot(mode);
        const conservativeCooldown = this.memory.shouldBeExtraConservative()
            ? Math.round(profile.cooldownMs * 1.5)
            : profile.cooldownMs;

        if (this.isGenerating) {
            return this.createWaitDecision(mode, 'A copilot suggestion is already being evaluated.', snapshot.segments);
        }

        if (snapshot.lastSuggestionAt && Date.now() - snapshot.lastSuggestionAt < conservativeCooldown) {
            return this.createWaitDecision(mode, 'Suggestion cooldown is active.', snapshot.segments);
        }

        this.isGenerating = true;
        try {
            const decision = LECTURE_LIKE_MODES.has(mode)
                ? await this.lectureStrategy.decide(snapshot)
                : await this.professionalStrategy.decide(snapshot);

            if (decision.suggestion && this.memory.isRepeatedSuggestion(decision.suggestion)) {
                const repeated = this.createWaitDecision(mode, 'Generated suggestion is too similar to a recent one.', snapshot.segments);
                repeated.confidence = Math.min(decision.confidence, 0.55);
                return repeated;
            }

            if (decision.suggestion) {
                this.memory.recordDecision(decision);
            }

            return decision;
        } finally {
            this.isGenerating = false;
        }
    }

    submitFeedback(feedback: CopilotFeedback): void {
        this.memory.recordFeedback(feedback);
    }

    reset(): void {
        this.memory.reset();
        this.isGenerating = false;
    }

    private shouldObserveSegment(segment: CopilotTranscriptSegment): boolean {
        if (!segment.final) return false;
        if (!segment.text.trim()) return false;
        return segment.speaker === 'interviewer'
            || segment.speaker === 'system'
            || /^locuteur[_-]\d+$/i.test(segment.speaker)
            || /^speaker[_-]\d+$/i.test(segment.speaker);
    }

    private getActiveCopilotMode(): CopilotMode | null {
        try {
            return resolveCopilotMode(ModesManager.getInstance().getActiveMode());
        } catch (error: any) {
            console.warn('[CopilotDecisionEngine] Failed to resolve active mode:', error?.message);
            return null;
        }
    }

    private createWaitDecision(mode: CopilotMode, reason: string, segments: CopilotTranscriptSegment[]): CopilotDecision {
        return {
            id: `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            mode,
            action: 'WAIT',
            confidence: 0,
            reason,
            createdAt: Date.now(),
            sourceSegmentIds: segments.slice(-6).map(segment => segment.id)
        };
    }
}
