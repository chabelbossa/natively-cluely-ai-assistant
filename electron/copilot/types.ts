import type { Mode } from '../services/ModesManager';

export type CopilotAction = 'WAIT' | 'SUGGEST' | 'ASK' | 'ANSWER';

export type CopilotMode =
    | 'interview'
    | 'technical_interview'
    | 'coding_assessment'
    | 'manager_meeting'
    | 'client_meeting'
    | 'feature_planning'
    | 'bug_triage'
    | 'architecture_review'
    | 'product_owner'
    | 'tech_lead'
    | 'backend_api'
    | 'frontend_handoff'
    | 'client_discovery'
    | 'sprint_planning'
    | 'lecture'
    | 'course'
    | 'conference'
    | 'formation';

export type CopilotSuggestionType =
    | 'scope'
    | 'priority'
    | 'deadline'
    | 'technical_risk'
    | 'security'
    | 'api_contract'
    | 'data_model'
    | 'roles_permissions'
    | 'bug_reproduction'
    | 'acceptance_criteria'
    | 'client_need'
    | 'business_goal'
    | 'course_clarification'
    | 'course_edge_case'
    | 'course_application'
    | 'course_comparison'
    | 'coding_hint'
    | 'interview_answer'
    | 'follow_up_question';

export type CopilotFeedbackRating =
    | 'useful'
    | 'too_early'
    | 'not_relevant'
    | 'already_discussed';

export interface CopilotDecision {
    id: string;
    mode: CopilotMode;
    action: CopilotAction;
    confidence: number;
    topic?: string;
    reason: string;
    suggestionType?: CopilotSuggestionType;
    suggestion?: string;
    createdAt: number;
    sourceSegmentIds: string[];
}

export interface CopilotFeedback {
    decisionId: string;
    rating: CopilotFeedbackRating;
    mode?: CopilotMode;
    timestamp: number;
}

export interface CopilotTranscriptSegment {
    id: string;
    speaker: string;
    text: string;
    timestamp: number;
    final: boolean;
    confidence?: number;
    canonicalRole?: string;
    source?: 'mic' | 'system' | 'merged';
    qualityFlags?: string[];
    rawSpeaker?: string;
    speakerId?: number;
}

export interface CopilotStructuredSummary {
    currentTopic?: string;
    previousTopics: string[];
    keyTerms: string[];
    segmentCount: number;
    durationMs: number;
}

export interface CopilotContextSnapshot {
    mode: CopilotMode;
    segments: CopilotTranscriptSegment[];
    rollingText: string;
    structuredSummary: CopilotStructuredSummary;
    lastSuggestionAt: number | null;
    recentSuggestions: CopilotDecision[];
    recentFeedback: CopilotFeedback[];
    /** Aggregated meeting health metrics for the dashboard */
    meetingHealth?: MeetingHealthSnapshot;
    /** Risks detected by the risk radar */
    detectedRisks?: DetectedRisk[];
}

/** Live meeting health for the dashboard UI */
export interface MeetingHealthSnapshot {
    clarityScore: number;
    openRisks: number;
    confirmedDecisions: number;
    unassignedActions: number;
    openQuestions: number;
    readyToSuggest: number;
    decisions: { what: string; owner?: string }[];
    risks: { description: string; severity: string }[];
    actions?: { task: string; owner?: string; deadline?: string }[];
    constraints?: string[];
    topics?: string[];
    deadlines?: string[];
    responsibilities?: string[];
    summarySoFar?: string;
}

/** A risk detected by the RiskRadar */
export interface DetectedRisk {
    type: string;
    explanation: string;
    severity: 'low' | 'medium' | 'high';
    suggestion?: string;
}

export interface CopilotModeProfile {
    mode: CopilotMode;
    label: string;
    automaticEnabled: boolean;
    minSegments: number;
    minContextMs: number;
    cooldownMs: number;
    minConfidence: number;
    allowedActions: CopilotAction[];
    suggestionTypes: CopilotSuggestionType[];
    systemBehavior: string;
}

export interface CopilotQuestionCandidate {
    question: string;
    confidence: number;
    topic?: string;
    reason?: string;
    suggestionType?: CopilotSuggestionType;
}

export interface LectureQuestionInput {
    mode: CopilotMode;
    rollingText: string;
    structuredSummary: CopilotStructuredSummary;
    recentSuggestions: string[];
}

export interface CopilotQuestionGenerator {
    generateLectureQuestion(input: LectureQuestionInput): Promise<CopilotQuestionCandidate | null>;
}

export interface CopilotStrategy {
    decide(snapshot: CopilotContextSnapshot): Promise<CopilotDecision>;
}

export type ActiveModeLike = Pick<Mode, 'name' | 'templateType'> | null;
