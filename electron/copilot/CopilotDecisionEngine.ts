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
    CopilotContextQuality,
    CopilotContextStatus,
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
            return this.createWaitDecision(mode, 'A copilot suggestion is already being evaluated.', snapshot.segments, 'generating');
        }

        if (snapshot.lastSuggestionAt && Date.now() - snapshot.lastSuggestionAt < conservativeCooldown) {
            console.log('[CopilotDecisionEngine] Cooldown active, WAIT');
            return this.createWaitDecision(mode, 'Suggestion cooldown is active.', snapshot.segments, 'cooldown');
        }

        // Timing score check — only generate if score is sufficient
        const timingScore = this.timingScorer.score(snapshot, mode);
        console.log('[CopilotDecisionEngine] Timing score:', timingScore.toFixed(2));
        if (timingScore < 0.3) {
            return this.createWaitDecision(mode, `Timing score too low (${timingScore.toFixed(2)}).`, snapshot.segments, 'listening');
        }

        this.isGenerating = true;
        try {
            console.log('[CopilotDecisionEngine] Calling strategy.decide for mode:', mode);
            const decision = LECTURE_LIKE_MODES.has(mode)
                ? await this.lectureStrategy.decide(snapshot)
                : await this.professionalStrategy.decide(snapshot);
            const enrichedDecision = this.enrichDecision(decision, snapshot.segments);

            console.log('[CopilotDecisionEngine] Strategy decision:', {
                action: enrichedDecision.action,
                suggestion: enrichedDecision.suggestion?.substring(0, 60),
                confidence: enrichedDecision.confidence,
                contextScore: enrichedDecision.contextQuality?.score,
                contextStatus: enrichedDecision.contextQuality?.status,
            });

            if (enrichedDecision.suggestion && this.memory.isRepeatedSuggestion(enrichedDecision.suggestion)) {
                const repeated = this.createWaitDecision(mode, 'Generated suggestion is too similar to a recent one.', snapshot.segments);
                repeated.confidence = Math.min(enrichedDecision.confidence, 0.55);
                return repeated;
            }

            if (enrichedDecision.suggestion) {
                this.memory.recordDecision(enrichedDecision);
            }

            return enrichedDecision;
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

    private createWaitDecision(
        mode: CopilotMode,
        reason: string,
        segments: CopilotTranscriptSegment[],
        statusOverride?: CopilotContextStatus,
    ): CopilotDecision {
        const decision: CopilotDecision = {
            id: `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            mode,
            action: 'WAIT',
            confidence: 0,
            reason,
            createdAt: Date.now(),
            sourceSegmentIds: segments.slice(-6).map((segment) => segment.id),
        };
        return this.enrichDecision(decision, segments, statusOverride);
    }

    private enrichDecision(
        decision: CopilotDecision,
        segments: CopilotTranscriptSegment[],
        statusOverride?: CopilotContextStatus,
    ): CopilotDecision {
        const contextQuality = this.buildContextQuality(segments, decision.reason, statusOverride, decision.action === 'SUGGEST');
        return {
            ...decision,
            contextQuality,
            nextBestAction: this.resolveNextBestAction(decision, contextQuality),
        };
    }

    private buildContextQuality(
        segments: CopilotTranscriptSegment[],
        reason: string,
        statusOverride?: CopilotContextStatus,
        hasSuggestion = false,
    ): CopilotContextQuality {
        const finalSegments = segments.filter((segment) => segment.final && segment.text.trim());
        const reliableInterlocutorSegments = finalSegments.filter((segment) => this.isReliableInterlocutor(segment));
        const meSegments = finalSegments.filter((segment) => this.isMeSegment(segment));
        const lowConfidenceCount = finalSegments.filter((segment) => segment.qualityFlags?.includes('low_confidence')).length;
        const uncertainCount = finalSegments.filter((segment) =>
            segment.canonicalRole === 'uncertain' ||
            segment.qualityFlags?.some((flag) => flag === 'speaker_uncertain' || flag === 'possible_overlap'),
        ).length;
        const latestInterlocutor = reliableInterlocutorSegments[reliableInterlocutorSegments.length - 1];
        const latestInterlocutorAgeMs = latestInterlocutor ? Date.now() - latestInterlocutor.timestamp : undefined;

        let score = 0.08;
        if (reliableInterlocutorSegments.length > 0) {
            score = 0.42 + Math.min(0.34, reliableInterlocutorSegments.length * 0.055);
        }
        if (meSegments.length > 0 && reliableInterlocutorSegments.length > 0) score += 0.06;
        if (latestInterlocutorAgeMs !== undefined && latestInterlocutorAgeMs < 20_000) score += 0.12;
        if (latestInterlocutorAgeMs !== undefined && latestInterlocutorAgeMs > 45_000) score -= 0.22;
        score -= Math.min(0.18, lowConfidenceCount * 0.04);
        score -= Math.min(0.18, uncertainCount * 0.035);
        score = Math.max(0, Math.min(1, score));

        const status = statusOverride ?? this.resolveContextStatus(score, reliableInterlocutorSegments.length, latestInterlocutorAgeMs, hasSuggestion);
        const label = this.contextStatusLabel(status, score);

        return {
            score: Number(score.toFixed(2)),
            status,
            label,
            reason: this.contextStatusReason(status, reason, reliableInterlocutorSegments.length, latestInterlocutorAgeMs),
            reliableInterlocutorSegments: reliableInterlocutorSegments.length,
            meSegments: meSegments.length,
            totalSegments: finalSegments.length,
            latestInterlocutorAgeMs,
        };
    }

    private resolveContextStatus(
        score: number,
        reliableInterlocutorCount: number,
        latestInterlocutorAgeMs: number | undefined,
        hasSuggestion: boolean,
    ): CopilotContextStatus {
        if (reliableInterlocutorCount === 0) return 'weak';
        if (latestInterlocutorAgeMs !== undefined && latestInterlocutorAgeMs > 45_000) return 'weak';
        if (hasSuggestion || score >= 0.72) return 'ready';
        if (score >= 0.45) return 'listening';
        return 'weak';
    }

    private contextStatusLabel(status: CopilotContextStatus, score: number): string {
        if (status === 'ready') return 'Ready to assist';
        if (status === 'generating') return 'Thinking';
        if (status === 'cooldown') return 'Cooling down';
        if (status === 'weak') return score >= 0.35 ? 'Context fragile' : 'Need speaker context';
        return 'Listening';
    }

    private contextStatusReason(
        status: CopilotContextStatus,
        reason: string,
        reliableInterlocutorCount: number,
        latestInterlocutorAgeMs: number | undefined,
    ): string {
        if (status === 'weak' && reliableInterlocutorCount === 0) {
            return 'No reliable interlocutor segment is available yet.';
        }
        if (latestInterlocutorAgeMs !== undefined && latestInterlocutorAgeMs > 45_000) {
            return 'The last reliable interlocutor segment is stale.';
        }
        return reason;
    }

    private resolveNextBestAction(
        decision: CopilotDecision,
        quality: CopilotContextQuality,
    ): CopilotDecision['nextBestAction'] {
        if (decision.action === 'SUGGEST' && decision.suggestion) {
            if (decision.suggestionType === 'vibe_interview_say_this' || decision.suggestionType === 'interview_answer') {
                return 'say_this';
            }
            return 'ask_this';
        }
        if (quality.status === 'ready' || quality.status === 'listening') return 'listen';
        return 'wait';
    }

    private isReliableInterlocutor(segment: CopilotTranscriptSegment): boolean {
        if (segment.qualityFlags?.includes('low_confidence')) return false;
        if (segment.canonicalRole === 'interlocutor' || /^speaker_\d+$/i.test(segment.canonicalRole || '')) {
            return true;
        }
        if (segment.source === 'system') return true;
        const speaker = String(segment.speaker || '').toLowerCase();
        return speaker === 'interlocutor' || /^speaker[_-]?\d+$/i.test(speaker) || /^locuteur[_-]?\d+$/i.test(speaker);
    }

    private isMeSegment(segment: CopilotTranscriptSegment): boolean {
        if (segment.canonicalRole === 'me') return true;
        const speaker = String(segment.speaker || '').toLowerCase();
        return speaker === 'me' || speaker === 'mic' || speaker === 'user';
    }
}
