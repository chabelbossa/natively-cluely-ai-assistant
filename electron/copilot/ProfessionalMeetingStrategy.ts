import { getCopilotModeProfile } from './ModeProfiles';
import { clamp, countWordOverlap } from './textUtils';
import type {
  CopilotContextSnapshot,
  CopilotDecision,
  CopilotSuggestionType,
} from './types';
import type { ProfessionalMeetingLLM } from './ProfessionalMeetingLLM';

// ─── Meeting-specific point-end detection ──────────────────────────
// Meetings are faster-paced than lectures — shorter segments, more back-and-forth.
// We detect "turn-taking pauses": when the speaker has been silent for a few segments
// AND the other party hasn't jumped in yet, a discussion point may be ripe for a suggestion.
const MEETING_CLOSURE_PATTERNS = [
  /\b(so|therefore|okay|alright|makes sense|sounds good|agreed|let's move on|next|any questions)\b/i,
  /\b(donc|ok|d'accord|ça marche|entendu|on avance|suivant|des questions)\b/i,
  /[.!?]$/,
];

const CONTINUATION_PATTERNS = [
  /\b(and|or|but|also|additionally|furthermore|however|another thing)\b/i,
  /\b(et|ou|mais|aussi|également|en plus|cependant|par contre)\b/i,
  /[,;:]$/,
];

export class ProfessionalMeetingStrategy {
  constructor(
    private readonly llm: ProfessionalMeetingLLM,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async decide(snapshot: CopilotContextSnapshot): Promise<CopilotDecision> {
    const profile = getCopilotModeProfile(snapshot.mode);
    const sourceSegmentIds = snapshot.segments.slice(-6).map((s) => s.id);
    const base = {
      id: createDecisionId(),
      mode: snapshot.mode,
      createdAt: this.now(),
      sourceSegmentIds,
    };

    // Gate 1 — Minimum segments
    if (snapshot.segments.length < profile.minSegments) {
      return {
        ...base,
        action: 'WAIT',
        confidence: 0.2,
        reason: `Need at least ${profile.minSegments} final transcript segments.`,
      };
    }

    // Gate 2 — Minimum context duration
    if (snapshot.structuredSummary.durationMs < profile.minContextMs) {
      return {
        ...base,
        action: 'WAIT',
        confidence: 0.25,
        reason: `Need at least ${Math.round(profile.minContextMs / 1000)}s of context.`,
      };
    }

    // Gate 3 — Detect whether a discussion point may have ended
    const pointEnd = this.detectMeetingPause(snapshot);
    if (!pointEnd.ended) {
      return {
        ...base,
        action: 'WAIT',
        confidence: pointEnd.confidence,
        reason: pointEnd.reason,
      };
    }

    // Gate 4 — LLM-based suggestion generation
    const candidate = await this.llm.generateSuggestion({
      mode: snapshot.mode,
      rollingText: snapshot.rollingText,
      structuredSummary: snapshot.structuredSummary,
      recentSuggestions: snapshot.recentSuggestions
        .map((d) => d.suggestion)
        .filter((s): s is string => !!s),
      allowedTypes: profile.suggestionTypes,
    });

    if (!candidate) {
      return {
        ...base,
        action: 'WAIT',
        confidence: 0.4,
        reason: 'Suggestion generator chose to wait.',
      };
    }

    // Gate 5 — Confidence threshold
    const confidence = clamp(candidate.confidence, 0, 1);
    if (confidence < profile.minConfidence) {
      return {
        ...base,
        action: 'WAIT',
        confidence,
        topic: candidate.topic,
        reason: `Confidence ${confidence.toFixed(2)} below threshold ${profile.minConfidence}.`,
      };
    }

    // Gate 6 — Grounding check
    if (!this.isGrounded(candidate.question, snapshot.rollingText, candidate.topic)) {
      return {
        ...base,
        action: 'WAIT',
        confidence: Math.min(confidence, 0.5),
        topic: candidate.topic,
        reason: 'Suggestion not grounded enough in the transcript.',
      };
    }

    // ─── Passed all gates → SUGGEST ──────────────────────────
    return {
      ...base,
      action: 'SUGGEST',
      confidence,
      topic: candidate.topic ?? snapshot.structuredSummary.currentTopic,
      reason: candidate.reason || pointEnd.reason,
      suggestionType: this.normalizeSuggestionType(
        candidate.suggestionType,
        profile.suggestionTypes,
      ),
      suggestion: candidate.question,
    };
  }

  // ─── Meeting-specific endpoint detection ────────────────────────
  private detectMeetingPause(
    snapshot: CopilotContextSnapshot,
  ): { ended: boolean; confidence: number; reason: string } {
    const segments = snapshot.segments;
    const last = segments[segments.length - 1];
    const recentText = segments
      .slice(-4)
      .map((s) => s.text)
      .join(' ');
    const lastText = last.text.trim();

    // Short segments → probably still talking
    if (lastText.length < 20) {
      return {
        ended: false,
        confidence: 0.2,
        reason: 'Latest segment too short to mark a point.',
      };
    }

    // Still developing the same thought
    if (CONTINUATION_PATTERNS.some((p) => p.test(lastText))) {
      return {
        ended: false,
        confidence: 0.3,
        reason: 'Speaker appears to be developing their point.',
      };
    }

    // Check for closure patterns + substance
    const closureSignals = MEETING_CLOSURE_PATTERNS.filter(
      (p) => p.test(lastText) || p.test(recentText),
    ).length;
    const hasSubstance = recentText.length >= 160;
    let confidence = clamp(
      0.35 + closureSignals * 0.2 + (hasSubstance ? 0.15 : 0),
      0,
      0.85,
    );

    // Boost confidence if multiple segments from different speakers (turn-taking happened)
    const recentSpeakers = new Set(segments.slice(-4).map((s) => s.speaker));
    if (recentSpeakers.size >= 2) confidence = clamp(confidence + 0.1, 0, 0.9);

    if (closureSignals === 0 && confidence < 0.55) {
      return {
        ended: false,
        confidence,
        reason: 'No clear turn-taking pause or closure signal yet.',
      };
    }

    if (confidence < 0.55) {
      return {
        ended: false,
        confidence,
        reason: 'Discussion still ongoing.',
      };
    }

    return {
      ended: true,
      confidence,
      reason: 'A discussion point appears to be complete.',
    };
  }

  // ─── Grounding ───────────────────────────────────────────────────
  private isGrounded(
    question: string,
    transcript: string,
    topic?: string,
  ): boolean {
    const questionOverlap = countWordOverlap(question, transcript);
    const topicOverlap = topic ? countWordOverlap(topic, transcript) : 0;
    return questionOverlap >= 1 || topicOverlap >= 1;
  }

  // ─── Suggestion type normalization ──────────────────────────────
  private normalizeSuggestionType(
    value: unknown,
    allowed: CopilotSuggestionType[],
  ): CopilotSuggestionType {
    const set = new Set(allowed);
    if (set.has(value as CopilotSuggestionType)) {
      return value as CopilotSuggestionType;
    }
    // For meeting modes, scope is the safest default
    return set.has('scope') ? 'scope' : allowed[0];
  }
}

function createDecisionId(): string {
  return `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
