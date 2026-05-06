/**
 * DecisionTracker — Live extraction of structured meeting decisions.
 * Complements CopilotMemory with persistent meeting-wide state tracking:
 * decisions, owners, deadlines, risks, open questions, and dependencies.
 */
export interface TrackedDecision {
  what: string;
  owner?: string;
  deadline?: string;
  confidence: number;
}

export interface TrackedRisk {
  description: string;
  category: 'technical' | 'scope' | 'deadline' | 'dependency' | 'security' | 'unknown';
  severity: 'low' | 'medium' | 'high';
}

export interface TrackedQuestion {
  question: string;
  topic?: string;
  resolved: boolean;
}

export interface MeetingState {
  decisions: TrackedDecision[];
  risks: TrackedRisk[];
  openQuestions: TrackedQuestion[];
  dependencies: string[];
  actionItems: { task: string; owner?: string; deadline?: string }[];
  constraints: string[];
  deadlines: string[];
  responsibilities: string[];
  topics: string[];
  summaryText: string;
}

export class DecisionTracker {
  private state: MeetingState = {
    decisions: [],
    risks: [],
    openQuestions: [],
    dependencies: [],
    actionItems: [],
    constraints: [],
    deadlines: [],
    responsibilities: [],
    topics: [],
    summaryText: '',
  };

  private followUpQueue: TrackedQuestion[] = [];

  getState(): Readonly<MeetingState> {
    return this.state;
  }

  addDecision(decision: TrackedDecision): void {
    const exists = this.state.decisions.some(
      (d) => d.what === decision.what
    );
    if (!exists) this.state.decisions.push(decision);
  }

  addRisk(risk: TrackedRisk): void {
    const exists = this.state.risks.some(
      (r) => r.description === risk.description
    );
    if (!exists) this.state.risks.push(risk);
  }

  addOpenQuestion(q: TrackedQuestion): void {
    const exists = this.state.openQuestions.some(
      (oq) => oq.question === q.question
    );
    if (!exists) {
      this.state.openQuestions.push({ ...q, resolved: false });
      this.followUpQueue.push({ ...q, resolved: false });
    }
  }

  markQuestionResolved(questionText: string): void {
    this.state.openQuestions = this.state.openQuestions.map((oq) =>
      oq.question === questionText ? { ...oq, resolved: true } : oq,
    );
    this.followUpQueue = this.followUpQueue.filter(
      (q) => q.question !== questionText,
    );
  }

  addDependency(dep: string): void {
    if (!this.state.dependencies.includes(dep))
      this.state.dependencies.push(dep);
  }

  addActionItem(item: { task: string; owner?: string; deadline?: string }): void {
    const exists = this.state.actionItems.some((a) => a.task === item.task);
    if (!exists) this.state.actionItems.push(item);
  }

  observeTranscript(segment: { speaker: string; text: string; timestamp: number; canonicalRole?: string }): void {
    const text = this.clean(segment.text);
    if (text.length < 8) return;

    this.extractTopics(text);

    if (/\?/.test(text) || /\b(est ce que|pourquoi|comment|quand|qui|quel|quelle|combien|what|why|how|when|who|which)\b/i.test(this.normalize(text))) {
      this.addOpenQuestion({
        question: this.truncate(text, 220),
        topic: this.state.topics.slice(-1)[0],
        resolved: false,
      });
    }

    if (/\b(on a décidé|on décide|c est validé|validé|retenu|we decided|decision|approved|go with)\b/i.test(text)) {
      this.addDecision({
        what: this.truncate(text, 220),
        confidence: 0.72,
      });
    }

    if (/\b(je vais|tu vas|vous allez|on doit|il faut|à faire|a faire|next step|todo|we need to|i will|you will)\b/i.test(text)) {
      this.addActionItem({
        task: this.truncate(text, 220),
        owner: this.inferOwner(text),
        deadline: this.inferDeadline(text),
      });
    }

    if (/\b(risque|bloquant|blocked|problème|probleme|issue|attention|security|sécurité|depend|dépend|deadline|retard)\b/i.test(text)) {
      this.addRisk({
        description: this.truncate(text, 220),
        category: this.inferRiskCategory(text),
        severity: /\b(bloquant|critical|critique|urgent|security|sécurité)\b/i.test(text) ? 'high' : 'medium',
      });
    }

    const deadline = this.inferDeadline(text);
    if (deadline && !this.state.deadlines.includes(deadline)) {
      this.state.deadlines.push(deadline);
      this.trimList(this.state.deadlines, 12);
    }

    if (/\b(doit|must|obligatoire|required|contrainte|constraint|limite|cannot|ne peut pas|il faut)\b/i.test(text)) {
      this.pushUnique(this.state.constraints, this.truncate(text, 180), 16);
    }

    const owner = this.inferOwner(text);
    if (owner) {
      this.pushUnique(this.state.responsibilities, `${owner}: ${this.truncate(text, 160)}`, 12);
    }
  }

  /**
   * Returns up to 3 unresolved questions that should be re-raised.
   * Only returns a question if the current topic relates to it.
   */
  getFollowUpQuestions(currentTopics: string[]): TrackedQuestion[] {
    if (currentTopics.length === 0 || this.followUpQueue.length === 0)
      return [];

    const candidates = this.followUpQueue
      .filter((q) => !q.resolved)
      .slice(0, 3)
      .filter((q) => {
        if (!q.topic) return true;
        const qWords = q.topic.toLowerCase().split(/\s+/);
        return currentTopics.some((topic) =>
          qWords.some(
            (word) =>
              word.length >= 4 && topic.toLowerCase().includes(word),
          ),
        );
      });

    return candidates;
  }

  /** Number-based metrics for the dashboard */
  getHealthMetrics(): {
    clarityScore: number;
    openRisks: number;
    confirmedDecisions: number;
    unassignedActions: number;
    openQuestions: number;
    readyToSuggest: number;
  } {
    const totalDecisions = this.state.decisions.length;
    const totalRisks = this.state.risks.length;
    const totalActions = this.state.actionItems.length;
    const assignedActions = this.state.actionItems.filter(
      (a) => a.owner,
    ).length;
    const unresolvedQuestions = this.state.openQuestions.filter(
      (q) => !q.resolved,
    ).length;

    const clarityScore = Math.min(
      10,
      Math.round(
        (totalDecisions * 2 +
          assignedActions * 1.5 +
          (totalActions > 0 ? 1 : 0) -
          totalRisks * 0.5 -
          unresolvedQuestions * 0.5) *
          0.6 +
          4,
      ),
    );

    return {
      clarityScore: Math.max(1, clarityScore),
      openRisks: totalRisks,
      confirmedDecisions: totalDecisions,
      unassignedActions: totalActions - assignedActions,
      openQuestions: unresolvedQuestions,
      readyToSuggest: this.followUpQueue.length,
    };
  }

  getSummary(): string {
    const parts: string[] = [];
    if (this.state.decisions.length)
      parts.push(
        `Decisions: ${this.state.decisions.map((d) => d.what).join('; ')}`,
      );
    if (this.state.risks.length)
      parts.push(
        `Risks: ${this.state.risks.map((r) => r.description).join('; ')}`,
      );
    if (this.state.openQuestions.length)
      parts.push(
        `Open: ${this.state.openQuestions.filter((q) => !q.resolved).map((q) => q.question).join('; ')}`,
      );
    if (this.state.dependencies.length)
      parts.push(`Deps: ${this.state.dependencies.join(', ')}`);
    if (this.state.constraints.length)
      parts.push(`Constraints: ${this.state.constraints.slice(-4).join('; ')}`);
    if (this.state.actionItems.length)
      parts.push(`Actions: ${this.state.actionItems.slice(-4).map((a) => a.task).join('; ')}`);
    this.state.summaryText = parts.join(' | ');
    return this.state.summaryText;
  }

  reset(): void {
    this.state = {
      decisions: [],
      risks: [],
      openQuestions: [],
      dependencies: [],
      actionItems: [],
      constraints: [],
      deadlines: [],
      responsibilities: [],
      topics: [],
      summaryText: '',
    };
    this.followUpQueue = [];
  }

  private inferRiskCategory(text: string): TrackedRisk['category'] {
    if (/\b(deadline|retard|date|delay)\b/i.test(text)) return 'deadline';
    if (/\b(security|sécurité|permission|role|auth)\b/i.test(text)) return 'security';
    if (/\b(depend|dépend|blocked|bloquant)\b/i.test(text)) return 'dependency';
    if (/\b(scope|périmètre|perimetre|mvp)\b/i.test(text)) return 'scope';
    if (/\b(api|backend|frontend|database|architecture|technique)\b/i.test(text)) return 'technical';
    return 'unknown';
  }

  private inferOwner(text: string): string | undefined {
    if (/\bje vais|i will|moi je\b/i.test(text)) return 'me';
    if (/\btu vas|vous allez|you will\b/i.test(text)) return 'interlocutor';
    return undefined;
  }

  private inferDeadline(text: string): string | undefined {
    const match = text.match(/\b(aujourd'hui|demain|cette semaine|semaine prochaine|vendredi|lundi|mardi|mercredi|jeudi|samedi|dimanche|today|tomorrow|next week|friday|monday|tuesday|wednesday|thursday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i);
    return match?.[0];
  }

  private extractTopics(text: string): void {
    const normalized = this.normalize(text);
    const candidates = normalized
      .split(/\s+/)
      .filter((word) => word.length >= 5)
      .filter((word) => !/^(alors|comme|merci|bonjour|quelle|quelles|comment|pourquoi|there|about|would|should|could|avec|dans|pour|cette|celui|avoir|faire)$/.test(word))
      .slice(0, 4);

    for (const candidate of candidates) {
      this.pushUnique(this.state.topics, candidate, 18);
    }
  }

  private pushUnique(list: string[], value: string, max: number): void {
    const cleanValue = this.clean(value);
    if (!cleanValue) return;
    if (!list.some((item) => this.normalize(item) === this.normalize(cleanValue))) {
      list.push(cleanValue);
      this.trimList(list, max);
    }
  }

  private trimList(list: string[], max: number): void {
    if (list.length > max) {
      list.splice(0, list.length - max);
    }
  }

  private truncate(text: string, max: number): string {
    const clean = this.clean(text);
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 3).trim()}...`;
  }

  private clean(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
