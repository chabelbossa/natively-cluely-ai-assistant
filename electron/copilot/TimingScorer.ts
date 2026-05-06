import { clamp } from './textUtils';
import type { CopilotContextSnapshot, CopilotMode } from './types';
import type { DecisionTracker } from './DecisionTracker';

/**
 * TimingScorer — Decides whether NOW is the right moment to display a suggestion.
 * Aggregates multiple signals into a single 0-1 score.
 */
export class TimingScorer {
  constructor(private readonly tracker: DecisionTracker) {}

  score(snapshot: CopilotContextSnapshot, mode: CopilotMode): number {
    let score = 0;

    // ── 1. Segment-based signals ──────────────────────────
    score += this.segmentSubstanceScore(snapshot);

    // ── 2. Turn-taking / pause detection ──────────────────
    score += this.turnTakingScore(snapshot);

    // ── 3. Ambiguity / decision gap ──────────────────────
    score += this.ambiguityScore(mode);

    // ── 4. Follow-up opportunity ─────────────────────────
    score += this.followUpScore(snapshot);

    // ── 5. Cooldown penalty ──────────────────────────────
    score -= this.cooldownPenalty(snapshot);

    // ── 6. Repeated suggestion penalty ───────────────────
    score -= this.repetitionPenalty(snapshot);

    return clamp(score, 0, 1);
  }

  /** Score based on recent segment substance — longer, more substantial = more likely ready */
  private segmentSubstanceScore(snapshot: CopilotContextSnapshot): number {
    const segments = snapshot.segments;
    const last = segments[segments.length - 1];
    if (!last) return 0;

    const recentThree = segments
      .slice(-3)
      .map((s) => s.text.length)
      .reduce((sum, len) => sum + len, 0);

    // 3 recent segments totaling > 300 chars = substantial context
    if (recentThree >= 300) return 0.2;
    if (recentThree >= 180) return 0.12;
    if (recentThree >= 100) return 0.06;
    return 0.02;
  }

  /** Multi-speaker turn-taking signals a point is complete */
  private turnTakingScore(snapshot: CopilotContextSnapshot): number {
    const recentSpeakers = new Set(
      snapshot.segments.slice(-5).map((s) => s.speaker),
    );
    if (recentSpeakers.size >= 3) return 0.18;
    if (recentSpeakers.size >= 2) return 0.12;
    return 0;
  }

  /** If recent transcript contains ambiguous language, boost score (we should clarify) */
  private ambiguityScore(_mode: CopilotMode): number {
    const metrics = this.tracker.getHealthMetrics();
    let score = 0;

    // Unassigned actions = opportunity to ask "who owns this?"
    if (metrics.unassignedActions > 0) score += 0.08;
    // Open questions = opportunity to revisit
    if (metrics.openQuestions > 0) score += 0.05;
    // Low clarity = more need for intervention
    if (metrics.clarityScore < 5) score += 0.1;

    return Math.min(score, 0.15);
  }

  /** If we have follow-up questions related to the current topic */
  private followUpScore(snapshot: CopilotContextSnapshot): number {
    const currentTopics = snapshot.structuredSummary.keyTerms || [];
    const followUps = this.tracker.getFollowUpQuestions(currentTopics);
    if (followUps.length > 0) return 0.1;
    return 0;
  }

  /** Penalty for recent suggestion — exponential decay */
  private cooldownPenalty(snapshot: CopilotContextSnapshot): number {
    if (!snapshot.lastSuggestionAt) return 0;
    const elapsed = Date.now() - snapshot.lastSuggestionAt;
    const cooldownMs = 90_000; // 90s base cooldown

    if (elapsed < 30_000) return 0.5; // hard penalty
    if (elapsed < cooldownMs) return 0.3;
    if (elapsed < cooldownMs * 2) return 0.1;
    return 0;
  }

  /** Penalty if suggestion is too similar to recent ones */
  private repetitionPenalty(snapshot: CopilotContextSnapshot): number {
    const badRatings = snapshot.recentFeedback.filter(
      (f) => f.rating === 'too_early' || f.rating === 'not_relevant',
    ).length;
    if (badRatings >= 3) return 0.3;
    if (badRatings >= 2) return 0.15;
    if (badRatings >= 1) return 0.05;
    return 0;
  }
}
