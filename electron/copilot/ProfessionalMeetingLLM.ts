import { LLMHelper } from '../LLMHelper';
import { MeetingBriefManager } from '../meeting/MeetingBriefManager';
import type { CopilotQuestionCandidate, CopilotSuggestionType } from './types';

const PROFESSIONAL_MEETING_SYSTEM_PROMPT = `You are a real-time meeting copilot. Return exactly one JSON object and nothing else.

Task:
- Observe the meeting transcript and decide whether a short, strategic suggestion or question would be helpful RIGHT NOW.
- If the moment is not right or no clear intervention is needed, return {"action":"WAIT","confidence":0,"reason":"..."}.
- If you have a grounded suggestion, return it as a ONE-LINE question or phrase the user can say aloud (under 25 words).

CRITICAL: One-line interjections only. The user needs a single short sentence they can verbalize immediately.
Examples:
- "Before we move on, do we have a deadline for this?"
- "Who's the owner for this task?"
- "Is this part of the MVP or a future iteration?"
- "Can we confirm the reproduction steps for this bug?"
- "What happens if that API is down?"

Rules:
- The suggestion MUST be grounded in what was actually said — do not invent.
- Meeting brief is only background memory. Never present brief content as something said by the interlocutor unless the transcript supports it.
- Align with the user's meeting objective when it helps, but the transcript is always the source of truth.
- Keep it under 25 words. One sentence. No explanations.
- Do not give generic advice. Be specific to the conversation.
- Do not repeat recent suggestions.
- Prefer: clarifying scope/priority/deadline, assigning owners, surfacing risks, checking acceptance criteria.
- If the transcript shows a risk was detected (missing deadline, missing owner, missing criteria), your question should address it.
- In Vibe Interview style, prefer a direct "say this" phrase only when the transcript clearly supports it.
- If a follow-up question from an earlier topic is relevant now, use it.
- JSON keys: action, question, confidence, topic, suggestionType, reason.

Allowed suggestionType: scope, priority, deadline, technical_risk, security, api_contract, data_model, roles_permissions, bug_reproduction, acceptance_criteria, client_need, business_goal, vibe_interview_say_this, follow_up_question`;

interface ProfessionalMeetingInput {
  mode: string;
  rollingText: string;
  structuredSummary: { currentTopic?: string; previousTopics: string[]; keyTerms: string[]; segmentCount: number; durationMs: number };
  recentSuggestions: string[];
  allowedTypes: CopilotSuggestionType[];
  followUpQuestions?: string[];
  detectedRisks?: string[];
}

export class ProfessionalMeetingLLM {
  constructor(private readonly llmHelper: LLMHelper) {}

  async generateSuggestion(input: ProfessionalMeetingInput): Promise<CopilotQuestionCandidate | null> {
    const recentSuggestions = input.recentSuggestions.length
      ? input.recentSuggestions.map((s) => `- ${s}`).join('\n')
      : '- none';

    const allowedTypesStr = input.allowedTypes.join(', ');

    const risksBlock = input.detectedRisks?.length
      ? `<detected_risks>\n${input.detectedRisks.map((r) => `- ${r}`).join('\n')}\n</detected_risks>`
      : '';

    const followUpBlock = input.followUpQuestions?.length
      ? `<follow_up_questions>\n${input.followUpQuestions.map((q) => `- ${q}`).join('\n')}\n</follow_up_questions>`
      : '';

    const briefBlock = MeetingBriefManager.getInstance().buildContextBlock();

    const context = [
      `<mode>${input.mode}</mode>`,
      `<summary>${JSON.stringify(input.structuredSummary)}</summary>`,
      briefBlock,
      `<recent_suggestions>\n${recentSuggestions}\n</recent_suggestions>`,
      `<allowed_suggestion_types>${allowedTypesStr}</allowed_suggestion_types>`,
      risksBlock,
      followUpBlock,
      `<transcript>\n${input.rollingText}\n</transcript>`,
    ].filter(Boolean).join('\n\n');

    let raw = '';
    for await (const chunk of this.llmHelper.streamChat(
      'Evaluate the transcript and return the JSON object with a one-line suggestion now.',
      undefined,
      context,
      PROFESSIONAL_MEETING_SYSTEM_PROMPT,
      true,
    )) {
      raw += chunk;
    }

    return this.parseResponse(raw);
  }

  private parseResponse(raw: string): CopilotQuestionCandidate | null {
    const parsed = this.tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const action = String((parsed as any).action || '').toUpperCase();
    if (action === 'WAIT') return null;

    const question = String((parsed as any).question || '').trim();
    const confidence = Number((parsed as any).confidence);
    if (!question || !Number.isFinite(confidence)) return null;

    return {
      question,
      confidence,
      topic: typeof (parsed as any).topic === 'string' ? (parsed as any).topic.trim() : undefined,
      reason: typeof (parsed as any).reason === 'string' ? (parsed as any).reason.trim() : undefined,
      suggestionType: (parsed as any).suggestionType,
    };
  }

  private tryParseJson(raw: string): unknown | null {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() ?? trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      const objectMatch = candidate.match(/\{[\s\S]*\}/);
      if (!objectMatch) return null;
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
  }
}
