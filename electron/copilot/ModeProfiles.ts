import type { ActiveModeLike, CopilotMode, CopilotModeProfile } from './types';

const BASE_COOLDOWN_MS = 90_000;
const BASE_MIN_CONTEXT_MS = 45_000;

export const COPILOT_MODE_PROFILES: Record<CopilotMode, CopilotModeProfile> = {
    interview: {
        mode: 'interview',
        label: 'Interview Copilot',
        automaticEnabled: false,
        minSegments: 3,
        minContextMs: 30_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.75,
        allowedActions: ['WAIT', 'SUGGEST', 'ANSWER'],
        suggestionTypes: ['interview_answer', 'follow_up_question'],
        systemBehavior: 'Help answer interview questions only when explicitly triggered.'
    },
    technical_interview: {
        mode: 'technical_interview',
        label: 'Technical Interview Copilot',
        automaticEnabled: false,
        minSegments: 3,
        minContextMs: 30_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.75,
        allowedActions: ['WAIT', 'SUGGEST', 'ANSWER'],
        suggestionTypes: ['interview_answer', 'coding_hint', 'technical_risk'],
        systemBehavior: 'Support technical explanations and problem solving without interrupting existing flows.'
    },
    coding_assessment: {
        mode: 'coding_assessment',
        label: 'Coding Assessment Copilot',
        automaticEnabled: false,
        minSegments: 2,
        minContextMs: 20_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.8,
        allowedActions: ['WAIT', 'SUGGEST', 'ANSWER'],
        suggestionTypes: ['coding_hint'],
        systemBehavior: 'Offer coding hints only when explicitly requested in the MVP.'
    },
    manager_meeting: {
        mode: 'manager_meeting',
        label: 'Manager Meeting Copilot',
        automaticEnabled: false,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.78,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['scope', 'priority', 'deadline', 'acceptance_criteria', 'technical_risk'],
        systemBehavior: 'Clarify scope, ownership, priorities, risks, dependencies, and acceptance criteria.'
    },
    client_meeting: {
        mode: 'client_meeting',
        label: 'Client Meeting Copilot',
        automaticEnabled: false,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.78,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['client_need', 'business_goal', 'scope', 'priority', 'acceptance_criteria'],
        systemBehavior: 'Clarify the business need, users, constraints, validation, and ambiguity.'
    },
    feature_planning: {
        mode: 'feature_planning',
        label: 'Feature Planning Copilot',
        automaticEnabled: false,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.78,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['scope', 'priority', 'acceptance_criteria', 'api_contract', 'data_model'],
        systemBehavior: 'Clarify feature scope, API contracts, data shape, dependencies, and validation criteria.'
    },
    bug_triage: {
        mode: 'bug_triage',
        label: 'Bug Triage Copilot',
        automaticEnabled: false,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.78,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['bug_reproduction', 'technical_risk', 'roles_permissions', 'acceptance_criteria'],
        systemBehavior: 'Clarify reproduction, expected behavior, severity, impact, logs, and ownership.'
    },
    architecture_review: {
        mode: 'architecture_review',
        label: 'Architecture Review Copilot',
        automaticEnabled: false,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.78,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['technical_risk', 'security', 'api_contract', 'data_model', 'roles_permissions'],
        systemBehavior: 'Surface architectural tradeoffs, failure modes, scalability, maintainability, and security questions.'
    },
    lecture: lectureProfile('lecture', 'Lecture Copilot'),
    course: lectureProfile('course', 'Course Copilot'),
    conference: lectureProfile('conference', 'Conference Copilot'),
    formation: lectureProfile('formation', 'Formation Copilot')
};

export const LECTURE_LIKE_MODES = new Set<CopilotMode>([
    'lecture',
    'course',
    'conference',
    'formation'
]);

function lectureProfile(mode: CopilotMode, label: string): CopilotModeProfile {
    return {
        mode,
        label,
        automaticEnabled: true,
        minSegments: 4,
        minContextMs: BASE_MIN_CONTEXT_MS,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.75,
        allowedActions: ['WAIT', 'ASK'],
        suggestionTypes: [
            'course_clarification',
            'course_edge_case',
            'course_application',
            'course_comparison',
            'follow_up_question'
        ],
        systemBehavior: 'Wait while the speaker develops an idea, then suggest one grounded question when a point is complete.'
    };
}

export function getCopilotModeProfile(mode: CopilotMode): CopilotModeProfile {
    return COPILOT_MODE_PROFILES[mode];
}

export function resolveCopilotMode(activeMode: ActiveModeLike): CopilotMode | null {
    if (!activeMode) return null;

    const label = activeMode.name.toLowerCase();

    if (activeMode.templateType === 'lecture') {
        if (/\b(course|cours)\b/.test(label)) return 'course';
        if (/\b(conf|conference|conférence)\b/.test(label)) return 'conference';
        if (/\b(formation|training)\b/.test(label)) return 'formation';
        return 'lecture';
    }

    if (activeMode.templateType === 'technical-interview') return 'technical_interview';
    if (activeMode.templateType === 'looking-for-work') return 'interview';
    if (activeMode.templateType === 'sales') return 'client_meeting';
    if (activeMode.templateType === 'team-meet') return 'manager_meeting';
    if (activeMode.templateType === 'recruiting') return 'interview';

    return null;
}
