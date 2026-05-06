import { MeetingBriefManager } from './MeetingBriefManager';

export type MeetingAction =
  | 'WHAT_TO_SAY'
  | 'CLARIFY'
  | 'FOLLOW_UP_QUESTION'
  | 'ANSWER'
  | 'RECAP'
  | 'VIBE_INTERVIEW_SAY_THIS';

interface BuildActionContextInput {
  action: MeetingAction;
  activeModeBlock?: string;
  transcriptContext?: string;
  fallback?: string;
  liveStateBlock?: string;
}

export class MeetingActionOrchestrator {
  constructor(private readonly getLiveStateBlock?: () => string) {}

  buildActionContext(input: BuildActionContextInput): string {
    const liveState = input.liveStateBlock ?? this.safeLiveStateBlock();
    const briefBlock = MeetingBriefManager.getInstance().buildContextBlock();
    const parts = [
      this.buildActionContract(input.action),
      briefBlock,
      input.activeModeBlock?.trim(),
      liveState,
      input.transcriptContext?.trim(),
    ].filter(Boolean);

    if (parts.length > 0) return parts.join('\n\n');
    return input.fallback || '';
  }

  private safeLiveStateBlock(): string {
    try {
      return this.getLiveStateBlock?.().trim() || '';
    } catch (error: any) {
      console.warn('[MeetingActionOrchestrator] Failed to load live state:', error?.message || error);
      return '';
    }
  }

  private buildActionContract(action: MeetingAction): string {
    const actionRule = (() => {
      switch (action) {
        case 'WHAT_TO_SAY':
        case 'VIBE_INTERVIEW_SAY_THIS':
          return 'Return one short phrase the user can say aloud now. Prioritize what the interlocutor just said.';
        case 'CLARIFY':
          return 'Return one precise clarifying question based on the interlocutor context. Avoid generic questions.';
        case 'FOLLOW_UP_QUESTION':
          return 'Return one useful follow-up question that has not already been answered.';
        case 'RECAP':
          return 'Summarize decisions, open questions, risks, responsibilities, and next steps from reliable context.';
        case 'ANSWER':
        default:
          return 'Answer the user question using reliable interlocutor context first, then meeting brief background.';
      }
    })();

    return `[PREMIUM MEETING COPILOT CONTRACT]
Action: ${action}
- ${actionRule}
- Use the dominant language of the meeting. If the transcript is French, answer in French.
- Treat ME / Mic as the local user. Never use ME lines as proof of what the interlocutor said.
- Treat INTERLOCUTOR / Speaker as the source to answer from.
- If there is no reliable interlocutor context, say so briefly and use the meeting brief only as background.
- Do not hallucinate names, decisions, requirements, or quotes.
- Keep output concise and directly usable during a live meeting.
[/PREMIUM MEETING COPILOT CONTRACT]`;
  }
}
