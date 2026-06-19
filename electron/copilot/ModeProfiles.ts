import type { ActiveModeLike, CopilotMode, CopilotModeProfile } from './types';

const BASE_COOLDOWN_MS = 90_000;
const BASE_MIN_CONTEXT_MS = 45_000;

export const COPILOT_MODE_PROFILES: Record<CopilotMode, CopilotModeProfile> = {
    interview: {
        mode: 'interview',
        label: 'Interview Copilot',
        automaticEnabled: true,
        minSegments: 3,
        minContextMs: 30_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.75,
        allowedActions: ['WAIT', 'SUGGEST', 'ANSWER'],
        suggestionTypes: ['interview_answer', 'vibe_interview_say_this', 'follow_up_question'],
        systemBehavior: 'Help answer interview questions when a natural pause occurs.'
    },
    technical_interview: {
        mode: 'technical_interview',
        label: 'Technical Interview Copilot',
        automaticEnabled: true,
        minSegments: 3,
        minContextMs: 30_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.75,
        allowedActions: ['WAIT', 'SUGGEST', 'ANSWER'],
        suggestionTypes: ['interview_answer', 'vibe_interview_say_this', 'coding_hint', 'technical_risk'],
        systemBehavior: 'Support technical explanations and problem solving without interrupting existing flows.'
    },
    coding_assessment: {
        mode: 'coding_assessment',
        label: 'Coding Assessment Copilot',
        automaticEnabled: true,
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
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['scope', 'priority', 'deadline', 'acceptance_criteria', 'technical_risk', 'vibe_interview_say_this'],
        systemBehavior: 'Clarify scope, ownership, priorities, risks, dependencies, and acceptance criteria.'
    },
    client_meeting: {
        mode: 'client_meeting',
        label: 'Client Meeting Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['client_need', 'business_goal', 'scope', 'priority', 'acceptance_criteria', 'vibe_interview_say_this'],
        systemBehavior: 'Clarify the business need, users, constraints, validation, and ambiguity.'
    },
    feature_planning: {
        mode: 'feature_planning',
        label: 'Feature Planning Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['scope', 'priority', 'acceptance_criteria', 'api_contract', 'data_model'],
        systemBehavior: 'Clarify feature scope, API contracts, data shape, dependencies, and validation criteria.'
    },
    bug_triage: {
        mode: 'bug_triage',
        label: 'Bug Triage Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['bug_reproduction', 'technical_risk', 'roles_permissions', 'acceptance_criteria'],
        systemBehavior: 'Clarify reproduction, expected behavior, severity, impact, logs, and ownership.'
    },
    architecture_review: {
        mode: 'architecture_review',
        label: 'Architecture Review Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['technical_risk', 'security', 'api_contract', 'data_model', 'roles_permissions'],
        systemBehavior: 'Surface architectural tradeoffs, failure modes, scalability, maintainability, and security questions.'
    },
    product_owner: {
        mode: 'product_owner',
        label: 'Product Owner Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['business_goal', 'client_need', 'scope', 'acceptance_criteria', 'priority'],
        systemBehavior: 'Clarify user needs, business value, MVP scope, user stories, and acceptance criteria.'
    },
    tech_lead: {
        mode: 'tech_lead',
        label: 'Tech Lead Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['technical_risk', 'api_contract', 'data_model', 'security', 'priority'],
        systemBehavior: 'Surface architecture decisions, technical debt, tradeoffs, maintainability, and team capacity.'
    },
    backend_api: {
        mode: 'backend_api',
        label: 'Backend API Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['api_contract', 'data_model', 'roles_permissions', 'security', 'technical_risk'],
        systemBehavior: 'Clarify API contracts, auth, pagination, error handling, idempotency, and schema design.'
    },
    frontend_handoff: {
        mode: 'frontend_handoff',
        label: 'Frontend Handoff Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['api_contract', 'acceptance_criteria', 'scope', 'roles_permissions'],
        systemBehavior: 'Clarify UI states (loading, empty, error), responsive behavior, validations, and API contract needs.'
    },
    client_discovery: {
        mode: 'client_discovery',
        label: 'Opportunity Discovery Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['client_need', 'business_goal', 'scope', 'priority', 'deadline'],
        systemBehavior: 'Clarify project vision, business objectives, target users, expected contribution, constraints, stakeholders, timing, and success metrics.'
    },
    sprint_planning: {
        mode: 'sprint_planning',
        label: 'Sprint Planning Copilot',
        automaticEnabled: true,
        minSegments: 2,
        minContextMs: 15_000,
        cooldownMs: BASE_COOLDOWN_MS,
        minConfidence: 0.65,
        allowedActions: ['WAIT', 'SUGGEST', 'ASK'],
        suggestionTypes: ['scope', 'priority', 'deadline', 'acceptance_criteria', 'technical_risk'],
        systemBehavior: 'Clarify priorities, capacity, dependencies, risks, ticket breakdown, and sprint goals.'
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
    if (activeMode.templateType === 'coding-assessment') return 'coding_assessment';
    if (activeMode.templateType === 'looking-for-work') return 'interview';
    if (activeMode.templateType === 'sales') return 'client_meeting';
    if (activeMode.templateType === 'team-meet') return 'manager_meeting';
    if (activeMode.templateType === 'bug-triage') return 'bug_triage';
    if (activeMode.templateType === 'feature-planning') return 'feature_planning';
    if (activeMode.templateType === 'architecture-review') return 'architecture_review';
    if (activeMode.templateType === 'product-owner') return 'product_owner';
    if (activeMode.templateType === 'tech-lead') return 'tech_lead';
    if (activeMode.templateType === 'backend-api') return 'backend_api';
    if (activeMode.templateType === 'frontend-handoff') return 'frontend_handoff';
    if (activeMode.templateType === 'client-discovery') return 'client_discovery';
    if (activeMode.templateType === 'sprint-planning') return 'sprint_planning';
    if (activeMode.templateType === 'recruiting') return 'interview';

    // ── General fallback: infer copilot mode from mode name ─────────
    if (activeMode.templateType === 'general') {
        const name = activeMode.name.toLowerCase();
        if (/\b(bug|triage|reproduction)\b/.test(name)) return 'bug_triage';
        if (/\b(feature|planning|spec|grooming)\b/.test(name)) return 'feature_planning';
        if (/\b(arch|architecture|design|system)\b/.test(name)) return 'architecture_review';
        if (/\b(product owner|po|product)\b/.test(name)) return 'product_owner';
        if (/\b(tech lead|tech|lead)\b/.test(name)) return 'tech_lead';
        if (/\b(api|backend|endpoint|rest)\b/.test(name)) return 'backend_api';
        if (/\b(frontend|ui|ux|handoff)\b/.test(name)) return 'frontend_handoff';
        if (/\b(discovery|business|opportunity|opportunit|opportunité|partnership|partenariat|founder|fondateur|venture|projet)\b/.test(name)) return 'client_discovery';
        if (/\b(sprint|scrum|agile)\b/.test(name)) return 'sprint_planning';
        if (/\b(client|sales|vente|commercial|nego|meeting)\b/.test(name)) return 'client_meeting';
        if (/\b(interview|entretien|technical|technique|coding|code|assessment)\b/.test(name)) return 'technical_interview';
        if (/\b(team|manager|standup)\b/.test(name)) return 'manager_meeting';
        if (/\b(lecture|cours|course|formation|conf)\b/.test(name)) return 'lecture';
        return null;
    }

    return null;
}
