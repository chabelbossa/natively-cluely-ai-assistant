/**
 * RiskRadar — Detects patterns of missing or incomplete information
 * in meeting transcripts, so the copilot can flag it before it's too late.
 */
interface RiskDetectionResult {
  type: string;
  explanation: string;
  severity: 'low' | 'medium' | 'high';
  suggestion?: string;
}

const RISK_PATTERNS = [
  {
    name: 'missing_deadline',
    keywords: [
      /\b(deliver|ship|launch|release|deploy|done|ready)\b/i,
      /\b(livrer|déployer|lancer|terminer|prêt)\b/i,
    ],
    blocker: /(\d{4}-\d{2}-\d{2}|tomorrow|demain|next week|semaine prochaine|monday|tuesday|wednesday|thursday|friday|by \w+|\b\d{1,2}(st|nd|rd|th)?\b|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i,
    explanation: 'A deliverable was mentioned but no deadline was set.',
    severity: 'medium' as const,
    suggestion: 'Quelle est la deadline pour cette livraison ?',
  },
  {
    name: 'missing_owner',
    keywords: [
      /\/\/\w+\b(?: needs to| should| will| must| va | doit | va faire| va gérer)/i,
      /\b(action|task|TODO|à faire|action)\b/i,
    ],
    blocker: /\b(assigned to|owner:|responsable:|c'est \w+ qui|attribué à|assigné à|je m'en charge|je le fais|je vais|I'll |I will |let me )/i,
    explanation: 'An action item was mentioned with no clear owner.',
    severity: 'high' as const,
    suggestion: 'Qui est responsable de cette tâche ?',
  },
  {
    name: 'missing_acceptance_criteria',
    keywords: [
      /\b(feature|fonctionnalité|screen|page|endpoint|API|component)\b/i,
      /\b(build|create|add|implement|faire|créer|ajouter|implémenter)\b/i,
    ],
    blocker: /\b(criteria|AC|acceptance|critère|vérifié|validé|testé|when|given|étant donné|quand)\b/i,
    explanation: 'A feature was discussed without defining how to verify completion.',
    severity: 'medium' as const,
    suggestion: 'Quels sont les critères d\'acceptation pour cette fonctionnalité ?',
  },
  {
    name: 'missing_reproduction',
    keywords: [
      /\b(bug|issue|error|crash|broken|not working|cassé|ne marche pas|erreur|plantage)\b/i,
    ],
    blocker: /\b(repro|steps to repro|étapes|scénario|on fait|click|clique|happens when|arrive quand)\b/i,
    explanation: 'A bug was mentioned but no reproduction steps were discussed.',
    severity: 'high' as const,
    suggestion: 'Est-ce qu\'on a un scénario de reproduction fiable ?',
  },
  {
    name: 'missing_api_contract',
    keywords: [
      /\b(endpoint|route|API|REST|graphql|POST|GET|PUT|DELETE|payload)\b/i,
    ],
    blocker: /\b(contract|schema|request body|response|shape|type|interface|format|JSON|fields?|param)/i,
    explanation: 'An API was mentioned but the contract is not defined.',
    severity: 'medium' as const,
    suggestion: 'Quel est le contrat d\'API — format de requête et réponse ?',
  },
  {
    name: 'missing_data_model',
    keywords: [
      /\b(database|table|collection|migration|schema|model|entity|relation)\b/i,
    ],
    blocker: /\b(columns?|fields?|index|foreign key|constraint|type|relation|nullable|required|primary)\b/i,
    explanation: 'A data model change was mentioned without specifying the schema.',
    severity: 'medium' as const,
    suggestion: 'Quelle est la structure du modèle de données ?',
  },
  {
    name: 'missing_roles_permissions',
    keywords: [
      /\b(only \w+|admin|user|role|permission|access|authorization|allowed|can\b|who can)\b/i,
    ],
    blocker: /\b(is accessible to|has access|can access|for \w+ users|only for|restricted to)\b/i,
    explanation: 'An access control requirement was mentioned without specifying roles.',
    severity: 'low' as const,
    suggestion: 'Quels rôles ou permissions sont concernés ?',
  },
  {
    name: 'missing_scope_boundary',
    keywords: [
      /\b(MVP|scope|v1|first version|minimum|phase 1|première version)\b/i,
    ],
    blocker: /\b(out of scope|hors scope|plus tard|later|v2|next|après|won't include)\b/i,
    explanation: 'MVP scope was mentioned but boundaries are not defined.',
    severity: 'medium' as const,
    suggestion: 'Est-ce que le scope MVP est clairement séparé des améliorations futures ?',
  },
];

export class RiskRadar {
  /**
   * Scan the last N segments of transcript for risky patterns.
   * Returns detected risks with suggestions.
   */
  scan(segments: { text: string }[], lastNSegments: number = 8): RiskDetectionResult[] {
    const recentText = segments.slice(-lastNSegments).map((s) => s.text).join(' ');

    return RISK_PATTERNS
      .filter((pattern) => {
        const hasKeyword = pattern.keywords.some((kw) => kw.test(recentText));
        const hasBlocker = pattern.blocker.test(recentText);
        return hasKeyword && !hasBlocker;
      })
      .map((pattern) => ({
        type: pattern.name,
        explanation: pattern.explanation,
        severity: pattern.severity,
        suggestion: pattern.suggestion,
      }));
  }

  /** Check if there are any high-severity risks needing immediate attention */
  hasCriticalRisks(segments: { text: string }[]): boolean {
    return this.scan(segments).some((r) => r.severity === 'high');
  }
}
