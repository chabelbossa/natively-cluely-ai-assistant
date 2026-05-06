import { LLMHelper } from '../LLMHelper';
import { ModesManager } from '../services/ModesManager';
import { CopilotMemory } from './CopilotMemory';
import { LectureQuestionLLM } from './LectureQuestionLLM';
import { LectureStrategy } from './LectureStrategy';
import { getCopilotModeProfile, LECTURE_LIKE_MODES, resolveCopilotMode } from './ModeProfiles';
import { ProfessionalMeetingLLM } from './ProfessionalMeetingLLM';
import { ProfessionalMeetingStrategy } from './ProfessionalMeetingStrategy';
import { TimingScorer } from './TimingScorer';
import type {
    CopilotDecision,
    CopilotFeedback,
    CopilotMode,
    CopilotTranscriptSegment,
    MeetingHealthSnapshot,
    DetectedRisk,
} from './types';

export class CopilotDecisionEngine {
    private readonly memory = new CopilotMemory();
    private readonly timingScorer = new TimingScorer(this.memory.tracker);
    private readonly lectureStrategy: LectureStrategy;
    private readonly professionalStrategy: ProfessionalMeetingStrategy;
    private isGenerating = false;

    constructor(llmHelper: LLMHelper) {
        this.lectureStrategy = new LectureStrategy(new LectureQuestionLLM(llmHelper));
        this.professionalStrategy = new ProfessionalMeetingStrategy(
            new ProfessionalMeetingLLM(llmHelper),
            this.timingScorer,
            this.memory.tracker,
        );
    }

    async handleTranscript(segment: CopilotTranscriptSegment): Promise<CopilotDecision | null> {
        if (!this.shouldObserveSegment(segment)) {
            console.log('[CopilotDecisionEngine] Segment rejected by shouldObserveSegment:', { final: segment.final, textLen: segment.text?.length });
            return null;
        }

        const mode = this.getActiveCopilotMode();
        if (!mode) {
            console.log('[CopilotDecisionEngine] No active copilot mode resolved');
            return null;
        }

        const stored = this.memory.addSegment(segment);
        if (!stored) {
            console.log('[CopilotDecisionEngine] Segment deduplicated by memory');
            return null;
        }

        const profile = getCopilotModeProfile(mode);
        const snapshot = this.memory.getSnapshot(mode);
        const conservativeCooldown = this.memory.shouldBeExtraConservative()
            ? Math.round(profile.cooldownMs * 1.5)
            : profile.cooldownMs;

        console.log('[CopilotDecisionEngine] Processing segment', {
            mode,
            segmentsCount: snapshot.segments.length,
            durationMs: snapshot.structuredSummary.durationMs,
            lastSuggestionAgo: snapshot.lastSuggestionAt ? Date.now() - snapshot.lastSuggestionAt : null,
            cooldownMs: conservativeCooldown,
        });

        if (this.isGenerating) {
            console.log('[CopilotDecisionEngine] Already generating, WAIT');
            return this.createWaitDecision(mode, 'A copilot suggestion is already being evaluated.', snapshot.segments);
        }

        if (snapshot.lastSuggestionAt && Date.now() - snapshot.lastSuggestionAt < conservativeCooldown) {
            console.log('[CopilotDecisionEngine] Cooldown active, WAIT');
            return this.createWaitDecision(mode, 'Suggestion cooldown is active.', snapshot.segments);
        }

        // Timing score check — only generate if score is sufficient
        const timingScore = this.timingScorer.score(snapshot, mode);
        console.log('[CopilotDecisionEngine] Timing score:', timingScore.toFixed(2));
        if (timingScore < 0.3) {
            return this.createWaitDecision(mode, `Timing score too low (${timingScore.toFixed(2)}).`, snapshot.segments);
        }

        this.isGenerating = true;
        try {
            console.log('[CopilotDecisionEngine] Calling strategy.decide for mode:', mode);
            const decision = LECTURE_LIKE_MODES.has(mode)
                ? await this.lectureStrategy.decide(snapshot)
                : await this.professionalStrategy.decide(snapshot);

            console.log('[CopilotDecisionEngine] Strategy decision:', { action: decision.action, suggestion: decision.suggestion?.substring(0, 60), confidence: decision.confidence });

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

    /** Expose meeting health for the dashboard UI */
    getMeetingHealth(): MeetingHealthSnapshot | null {
        const metrics = this.memory.tracker.getHealthMetrics();
        const state = this.memory.tracker.getState();
        return {
            clarityScore: metrics.clarityScore,
            openRisks: metrics.openRisks,
            confirmedDecisions: metrics.confirmedDecisions,
            unassignedActions: metrics.unassignedActions,
            openQuestions: metrics.openQuestions,
            readyToSuggest: metrics.readyToSuggest,
            decisions: state.decisions.map((d) => ({
                what: d.what,
                owner: d.owner,
            })),
            risks: state.risks.map((r) => ({
                description: r.description,
                severity: r.severity,
            })),
            actions: state.actionItems.slice(-6),
            constraints: state.constraints.slice(-6),
            topics: state.topics.slice(-8),
            deadlines: state.deadlines.slice(-6),
            responsibilities: state.responsibilities.slice(-6),
            summarySoFar: this.memory.tracker.getSummary(),
        };
    }

    /** Expose detected risks for the dashboard */
    getDetectedRisks(): DetectedRisk[] {
        return this.memory.radar.scan(this.memory.getSegments());
    }

    getMeetingStateContextBlock(): string {
        const state = this.memory.tracker.getState();
        const lines = [
            state.decisions.length ? `Decisions: ${state.decisions.slice(-6).map((d) => d.what).join('; ')}` : '',
            state.actionItems.length ? `Actions: ${state.actionItems.slice(-6).map((a) => `${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.deadline ? ` (deadline: ${a.deadline})` : ''}`).join('; ')}` : '',
            state.risks.length ? `Risks: ${state.risks.slice(-6).map((r) => `${r.description} (${r.severity})`).join('; ')}` : '',
            state.openQuestions.length ? `Open questions: ${state.openQuestions.filter((q) => !q.resolved).slice(-6).map((q) => q.question).join('; ')}` : '',
            state.constraints.length ? `Constraints: ${state.constraints.slice(-6).join('; ')}` : '',
            state.deadlines.length ? `Deadlines: ${state.deadlines.slice(-6).join('; ')}` : '',
            state.topics.length ? `Topics: ${state.topics.slice(-8).join(', ')}` : '',
        ].filter(Boolean);

        if (lines.length === 0) return '';
        return [
            '[LIVE MEETING STATE]',
            ...lines,
            '[/LIVE MEETING STATE]',
            'Use this state to avoid repeating questions already answered and to keep actions aligned with the meeting goals.',
        ].join('\n');
    }

    private shouldObserveSegment(segment: CopilotTranscriptSegment): boolean {
        if (!segment.final) return false;
        if (!segment.text.trim()) return false;
        // Accept any non-empty final segment — let the strategy decide if it's useful
        return true;
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
            sourceSegmentIds: segments.slice(-6).map((segment) => segment.id),
        };
    }
}
