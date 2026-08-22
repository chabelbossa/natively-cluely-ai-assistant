import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_RECAP_PROMPT } from "./prompts";
import { isUserVisibleLiveLlmError } from "./LiveLlmError";
import {
    ConferenceMemoryCompactionRequest,
    ConferenceMemorySnapshot,
    normalizeConferenceMemorySnapshot,
} from "../meeting/ConferenceMemory";

export class RecapLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    /**
     * Generate a neutral conversation summary
     */
    async generate(context: string): Promise<string> {
        if (!context.trim()) return "";
        try {
            const stream = this.llmHelper.streamChat(context, undefined, undefined, UNIVERSAL_RECAP_PROMPT);
            let fullResponse = "";
            for await (const chunk of stream) fullResponse += chunk;
            return this.clampRecapResponse(fullResponse);
        } catch (error) {
            console.error("[RecapLLM] Generation failed:", error);
            return "";
        }
    }

    /**
     * Generate a neutral conversation summary (Streamed)
     */
    async *generateStream(context: string): AsyncGenerator<string> {
        if (!context.trim()) return;
        try {
            // Use our universal helper
            yield* this.llmHelper.streamChat(context, undefined, undefined, UNIVERSAL_RECAP_PROMPT);
        } catch (error) {
            console.error("[RecapLLM] Streaming generation failed:", error);
            if (isUserVisibleLiveLlmError(error)) throw error;
        }
    }

    /**
     * Provider-neutral structured compaction. The model returns the arguments of
     * an update_conference_memory tool call; the application parses and validates
     * those arguments before SessionTracker accepts them.
     */
    async compactConferenceMemory(
        request: ConferenceMemoryCompactionRequest,
    ): Promise<ConferenceMemorySnapshot | null> {
        if (request.newSegments.length === 0) return request.previousMemory;

        const systemPrompt = `You maintain loss-aware semantic memory for a live conference.

Act as the argument generator for this tool:
update_conference_memory({
  currentTopic: string,
  narrativeDigest: string,
  openQuestions: MemoryItem[],
  activeProblems: MemoryItem[],
  decisions: MemoryItem[],
  keyFacts: MemoryItem[],
  constraints: MemoryItem[],
  uncertainties: MemoryItem[]
})

MemoryItem = {
  text: string,
  evidenceSegmentIds: string[],
  status: "open" | "confirmed" | "resolved" | "superseded"
}

COMPACTION CONTRACT:
- Return ONLY the JSON arguments object, without markdown or commentary.
- Produce a complete merged memory from PREVIOUS_MEMORY plus NEW_RAW_SEGMENTS.
- Never omit concrete numbers, names, methods, negations, constraints, decisions, unresolved questions, or uncertainty merely to shorten the result.
- Merge true repetition, but preserve meaning-changing qualifications and disagreements.
- Keep an earlier item unless new evidence explicitly resolves, supersedes, or corrects it; update its status instead of silently dropping it.
- Every item derived from new transcript content must cite one or more exact segment IDs.
- The recent raw transcript remains authoritative. Do not invent facts or evidence IDs.
- narrativeDigest should connect the discussion across turns and explain how the current problem evolved, while the structured arrays preserve actionable details.`;

        const context = JSON.stringify({
            previousMemory: request.previousMemory,
            newRawSegments: request.newSegments,
        });

        try {
            const response = await this.llmHelper.generateMeetingSummary(systemPrompt, context, systemPrompt);
            const parsed = this.parseConferenceMemoryToolArguments(response);
            if (!parsed) return null;

            const previousCoverage = request.previousMemory?.coverage;
            const first = request.newSegments[0];
            const last = request.newSegments[request.newSegments.length - 1];
            return normalizeConferenceMemorySnapshot(parsed, request, {
                fromSegmentId: previousCoverage?.fromSegmentId || first.id,
                throughSegmentId: last.id,
                segmentCount: (previousCoverage?.segmentCount || 0) + request.newSegments.length,
                updatedAt: Date.now(),
            });
        } catch (error) {
            console.warn('[RecapLLM] Conference memory compaction failed:', error);
            return null;
        }
    }

    private clampRecapResponse(text: string): string {
        if (!text) return "";
        // Simple clamp: max 5 lines
        return text.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
    }

    private parseConferenceMemoryToolArguments(text: string): unknown | null {
        if (!text?.trim()) return null;
        const cleaned = text
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) return null;

        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (parsed?.arguments && typeof parsed.arguments === 'string') {
                return JSON.parse(parsed.arguments);
            }
            if (parsed?.arguments && typeof parsed.arguments === 'object') return parsed.arguments;
            if (parsed?.update_conference_memory && typeof parsed.update_conference_memory === 'object') {
                return parsed.update_conference_memory;
            }
            return parsed;
        } catch (error) {
            console.warn('[RecapLLM] Invalid conference memory tool arguments:', error);
            return null;
        }
    }
}
