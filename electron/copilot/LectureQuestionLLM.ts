import { LLMHelper } from '../LLMHelper';
import type { CopilotQuestionCandidate, LectureQuestionInput } from './types';

const LECTURE_QUESTION_SYSTEM_PROMPT = `You are a real-time lecture copilot.

Return exactly one JSON object and nothing else.

Task:
- Decide whether the lecture point is complete enough for the listener to ask one useful question.
- If not, return {"action":"WAIT","confidence":0,"reason":"..."}.
- If yes, return a short, natural question the listener can say out loud.

Rules:
- The question must be grounded in the transcript.
- Do not invent facts, names, examples, formulas, or claims.
- Do not ask generic questions.
- Do not answer the lecture.
- Keep the question under 26 words when possible.
- Prefer clarification, edge case, comparison, practical application, or implicit assumption questions.
- JSON keys must remain exactly: action, question, confidence, topic, suggestionType, reason.

Allowed suggestionType values:
course_clarification, course_edge_case, course_application, course_comparison, follow_up_question`;

export class LectureQuestionLLM {
    constructor(private readonly llmHelper: LLMHelper) {}

    async generateLectureQuestion(input: LectureQuestionInput): Promise<CopilotQuestionCandidate | null> {
        const recentSuggestions = input.recentSuggestions.length
            ? input.recentSuggestions.map(item => `- ${item}`).join('\n')
            : '- none';

        const context = [
            `<mode>${input.mode}</mode>`,
            `<summary>${JSON.stringify(input.structuredSummary)}</summary>`,
            `<recent_suggestions>\n${recentSuggestions}\n</recent_suggestions>`,
            `<transcript>\n${input.rollingText}\n</transcript>`
        ].join('\n\n');

        let raw = '';
        for await (const chunk of this.llmHelper.streamChat(
            'Evaluate the transcript and return the JSON object now.',
            undefined,
            context,
            LECTURE_QUESTION_SYSTEM_PROMPT,
            true
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
            suggestionType: (parsed as any).suggestionType
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
