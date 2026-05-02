import { LLMHelper } from '../LLMHelper';
import type { CopilotQuestionCandidate, CopilotSuggestionType } from './types';

const PROFESSIONAL_MEETING_SYSTEM_PROMPT = `You are a real-time meeting copilot.

Return exactly one JSON object and nothing else.

Task:
- Observe the meeting transcript and decide whether a short, useful suggestion can be offered.
- If the conversation is flowing naturally and no intervention is needed, return {"action":"WAIT","confidence":0,"reason":"..."}.
- If a specific, grounded suggestion would be helpful, return it.

Rules:
- The suggestion must be grounded in what was actually said — do not invent facts or assumptions.
- Keep suggestions under 30 words when possible. They should be said aloud as a quick interjection or question.
- Do not give generic advice like "clarify that" or "ask about scope" — be specific.
- Do not repeat suggestions that were already made.
- Do not answer questions being discussed — only ask clarifying or strategic questions.
- Prefer:
  - Clarifying undefined scope or ambiguous acceptance criteria
  - Surfacing unspoken deadlines or priorities
  - Identifying missing technical risks, dependencies, or constraints
  - Checking roles, permissions, or data model implications
  - Requesting concrete reproduction steps for bugs
  - Asking about the business goal or client need behind a feature
  - Questioning API contracts or data shape decisions early
- JSON keys must remain exactly: action, question, confidence, topic, suggestionType, reason.

Allowed suggestionType values:
scope, priority, deadline, technical_risk, security, api_contract, data_model, roles_permissions, bug_reproduction, acceptance_criteria, client_need, business_goal, follow_up_question`;

interface ProfessionalMeetingInput {
  mode: string;
  rollingText: string;
  structuredSummary: { currentTopic?: string; previousTopics: string[]; keyTerms: string[]; segmentCount: number; durationMs: number };
  recentSuggestions: string[];
  allowedTypes: CopilotSuggestionType[];
}

export class ProfessionalMeetingLLM {
  constructor(private readonly llmHelper: LLMHelper) {}

  async generateSuggestion(input: ProfessionalMeetingInput): Promise<CopilotQuestionCandidate | null> {
    const recentSuggestions = input.recentSuggestions.length
      ? input.recentSuggestions.map((s) => `- ${s}`).join('\n')
      : '- none';

    const allowedTypesStr = input.allowedTypes.join(', ');

    const context = [
      `<mode>${input.mode}</mode>`,
      `<summary>${JSON.stringify(input.structuredSummary)}</summary>`,
      `<recent_suggestions>\n${recentSuggestions}\n</recent_suggestions>`,
      `<allowed_suggestion_types>${allowedTypesStr}</allowed_suggestion_types>`,
      `<transcript>\n${input.rollingText}\n</transcript>`,
    ].join('\n\n');

    let raw = '';
    for await (const chunk of this.llmHelper.streamChat(
      'Evaluate the transcript and return the JSON object now.',
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
