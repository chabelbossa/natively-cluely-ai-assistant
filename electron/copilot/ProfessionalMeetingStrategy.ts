import type { CopilotContextSnapshot, CopilotDecision } from './types';

export class ProfessionalMeetingStrategy {
    async decide(snapshot: CopilotContextSnapshot): Promise<CopilotDecision> {
        return {
            id: `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            mode: snapshot.mode,
            action: 'WAIT',
            confidence: 0,
            reason: 'Automatic professional meeting suggestions are modeled but disabled in the MVP.',
            createdAt: Date.now(),
            sourceSegmentIds: snapshot.segments.slice(-6).map(segment => segment.id)
        };
    }
}
