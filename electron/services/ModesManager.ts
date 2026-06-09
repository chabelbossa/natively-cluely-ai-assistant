import { DatabaseManager } from '../db/DatabaseManager';
import {
    MODE_GENERAL_PROMPT,
    MODE_LOOKING_FOR_WORK_PROMPT,
    MODE_SALES_PROMPT,
    MODE_RECRUITING_PROMPT,
    MODE_TEAM_MEET_PROMPT,
    MODE_LECTURE_PROMPT,
    MODE_TECHNICAL_INTERVIEW_PROMPT,
    MODE_BUG_TRIAGE_PROMPT,
    MODE_FEATURE_PLANNING_PROMPT,
    MODE_ARCHITECTURE_REVIEW_PROMPT,
    MODE_CODING_ASSESSMENT_PROMPT,
} from '../llm/prompts';

export type ModeTemplateType =
    | 'general'
    | 'looking-for-work'
    | 'sales'
    | 'recruiting'
    | 'team-meet'
    | 'lecture'
    | 'technical-interview'
    | 'bug-triage'
    | 'feature-planning'
    | 'architecture-review'
    | 'coding-assessment'
    | 'product-owner'
    | 'tech-lead'
    | 'backend-api'
    | 'frontend-handoff'
    | 'client-discovery'
    | 'sprint-planning';

export interface Mode {
    id: string;
    name: string;
    templateType: ModeTemplateType;
    customContext: string;
    isActive: boolean;
    createdAt: string;
}

export interface ModeReferenceFile {
    id: string;
    modeId: string;
    fileName: string;
    content: string;
    createdAt: string;
}

export interface ModeNoteSection {
    id: string;
    modeId: string;
    title: string;
    description: string;
    sortOrder: number;
    createdAt: string;
}

export const MODE_TEMPLATES: Array<{
    type: ModeTemplateType;
    label: string;
    description: string;
}> = [
    { type: 'sales',                label: 'Sales',                description: 'Close deals with strategic discovery and objection handling.' },
    { type: 'recruiting',           label: 'Recruiting',           description: 'Evaluate candidates with structured interview insights.' },
    { type: 'team-meet',            label: 'Team Meet',            description: 'Track action items and key decisions from meetings.' },
    { type: 'looking-for-work',     label: 'Looking for work',     description: 'Answer interview questions with confidence and clarity.' },
    { type: 'lecture',              label: 'Lecture',              description: 'Capture key concepts and content from lectures.' },
    { type: 'technical-interview',  label: 'Technical Interview',  description: 'Solve coding problems and system design with progressive hints.' },
    { type: 'bug-triage',           label: 'Bug Triage',           description: 'Clarify reproduction, impact, priority, and ownership of bugs.' },
    { type: 'feature-planning',     label: 'Feature Planning',     description: 'Define scope, acceptance criteria, dependencies, and risks.' },
    { type: 'architecture-review',  label: 'Architecture Review',  description: 'Surface tradeoffs, failure modes, scalability, and security.' },
    { type: 'coding-assessment',    label: 'Coding Assessment',    description: 'Progressive coding hints, complexity analysis, edge cases.' },
    { type: 'product-owner',        label: 'Product Owner',         description: 'User needs, business value, MVP scope, user stories, AC.' },
    { type: 'tech-lead',            label: 'Tech Lead',             description: 'Architecture, technical debt, tradeoffs, team capacity.' },
    { type: 'backend-api',          label: 'Backend API',           description: 'API contracts, auth, pagination, error handling, DB schema.' },
    { type: 'frontend-handoff',     label: 'Frontend Handoff',      description: 'UI states, responsive, validations, API contract needs.' },
    { type: 'client-discovery',     label: 'Client Discovery',      description: 'Business objectives, constraints, budget, decision-makers.' },
    { type: 'sprint-planning',      label: 'Sprint Planning',       description: 'Priorities, capacity, dependencies, ticket breakdown.' },
];

// Default note sections seeded when a mode is created from a template
export const TEMPLATE_NOTE_SECTIONS: Record<ModeTemplateType, Array<{ title: string; description: string }>> = {
    general: [
        { title: 'Résumé exécutif',  description: 'Outcome, scope, and the few points someone needs first after the meeting.' },
        { title: 'Décisions',        description: 'Concrete decisions, retained directions, and explicit tradeoffs.' },
        { title: "Plan d'action",    description: 'Specific next steps, owners when known, and follow-up work.' },
        { title: 'Questions ouvertes', description: 'Unresolved product, business, technical, or implementation questions.' },
        { title: 'Risques',          description: 'Risks, blockers, fragile assumptions, or operational concerns.' },
        { title: 'Points à vérifier', description: 'Numbers, facts, provider behavior, or source details that must be checked.' },
    ],
    'looking-for-work': [
        { title: 'Follow-up actions',      description: 'Next interview steps or additional materials I said I would send if applicable.' },
        { title: 'Overview',               description: 'Overview of the interview, the company, and general structure.' },
        { title: 'Questions and responses', description: 'All questions asked to me during the interview and answers that gave.' },
        { title: 'Areas to improve',       description: 'What I could have done better during the interview.' },
        { title: 'Role details',           description: 'Anything discussed about the position, salary expectations, etc.' },
    ],
    sales: [
        { title: 'Action Items',         description: 'All action items that were said I would do after the meeting.' },
        { title: 'Outcome',              description: 'Did I close the sale and what was the outcome of the conversation.' },
        { title: 'Prospect background',  description: 'Background and context on who I was selling to.' },
        { title: 'Discovery',            description: 'What the prospect said during discovery.' },
        { title: 'Product',              description: "How I pitched the product and the prospect's reaction." },
        { title: 'Objections',           description: 'Objections from the prospect if there were any.' },
    ],
    recruiting: [
        { title: 'Action Items',          description: 'All action items that I have to do after the meeting.' },
        { title: 'Experience and skills', description: "Candidate's previous work experience and skills discussed." },
        { title: 'Quality of responses',  description: 'If there were questions asked, how well and how accurately the candidate answered each question.' },
        { title: 'Interest in company',   description: 'What the candidate said about their interest in the company.' },
        { title: 'Role expectations',     description: 'Anything discussed about the position, salary expectations, etc.' },
    ],
    'team-meet': [
        { title: 'Action Items',          description: 'All action items that were said I would do after the meeting.' },
        { title: 'Announcements',         description: 'Any team-wide announcements from the meeting.' },
        { title: 'Team updates',          description: "Each team member's progress, accomplishments, and current focus." },
        { title: 'Challenges or blockers', description: 'Any issues or obstacles raised that may affect progress.' },
        { title: 'Decisions made',        description: 'Key decisions or agreements reached during the meeting.' },
    ],
    lecture: [
        { title: 'Follow-up work',  description: 'Follow-up reading, assignments, or tasks to complete.' },
        { title: 'Topic',           description: 'Main subject or theme of the lecture.' },
        { title: 'Key concepts',    description: 'Core ideas or frameworks covered.' },
        { title: 'Content',         description: 'All content from the lecture with incredibly detailed bullet notes.' },
    ],
    'technical-interview': [
        { title: 'Problems covered',  description: 'Each problem asked, the approach used, and the outcome.' },
        { title: 'Concepts tested',   description: 'Key algorithms, data structures, or system design concepts that came up.' },
        { title: 'What went well',    description: 'Approaches or explanations that landed well.' },
        { title: 'Areas to study',    description: 'Topics or gaps identified that need more preparation.' },
        { title: 'Action items',      description: 'Follow-up steps — e.g. send code, study specific topics, await next round.' },
    ],
    'bug-triage': [
        { title: 'Bug description',     description: 'What is the bug — expected vs actual behavior.' },
        { title: 'Reproduction steps',  description: 'Exact steps to reproduce the bug reliably.' },
        { title: 'Impact assessment',   description: 'Which users, roles, or environments are affected.' },
        { title: 'Technical hypotheses', description: 'Possible root causes and investigations needed.' },
        { title: 'Priority & owner',    description: 'Severity level and who is assigned to the fix.' },
    ],
    'feature-planning': [
        { title: 'Feature objective',  description: 'What user problem does this feature solve.' },
        { title: 'MVP scope',          description: 'Minimum viable version — what ships first.' },
        { title: 'Acceptance criteria', description: 'How we verify the feature is complete and correct.' },
        { title: 'Technical risks',    description: 'Dependencies, performance, security, or integration risks.' },
        { title: 'Frontend / Backend dependencies', description: 'What each side needs to deliver and in what order.' },
    ],
    'architecture-review': [
        { title: 'Decision',              description: 'The technical decision being discussed or made.' },
        { title: 'Alternatives considered', description: 'Other approaches evaluated and why they were not chosen.' },
        { title: 'Advantages',            description: 'Benefits of the chosen approach.' },
        { title: 'Disadvantages / Risks', description: 'Tradeoffs, failure modes, scalability concerns.' },
        { title: 'Long-term impact',      description: 'Migration cost, maintenance burden, future flexibility.' },
    ],
    'coding-assessment': [
        { title: 'Problem',         description: 'The coding problem as stated.' },
        { title: 'Approach',        description: 'The algorithm or data structure approach taken.' },
        { title: 'Edge cases',      description: 'Boundary conditions and edge cases considered.' },
        { title: 'Complexity',      description: 'Time and space complexity analysis.' },
        { title: 'Alternative solutions', description: 'Other valid approaches and their tradeoffs.' },
    ],
    'product-owner': [
        { title: 'User need',         description: 'The core user problem this feature solves.' },
        { title: 'Business value',    description: 'Expected business impact and success metrics.' },
        { title: 'MVP scope',         description: 'Minimum viable version — what ships first.' },
        { title: 'User stories',      description: 'Key user stories discussed and their priority.' },
        { title: 'Acceptance criteria', description: 'How each story will be verified as complete.' },
    ],
    'tech-lead': [
        { title: 'Architecture decisions', description: 'Technical decisions made and their rationale.' },
        { title: 'Technical debt',    description: 'Debt items identified and whether they block the current work.' },
        { title: 'Tradeoffs',         description: 'Alternatives considered and why the chosen approach wins.' },
        { title: 'Team capacity',     description: 'Who is doing what and any resourcing gaps.' },
        { title: 'Risks & mitigation', description: 'Technical risks and how they will be addressed.' },
    ],
    'backend-api': [
        { title: 'API contract',      description: 'Endpoints, request/response shapes, status codes.' },
        { title: 'Authentication',    description: 'Auth mechanism, token handling, permissions.' },
        { title: 'Data model',        description: 'Schema changes, relationships, migrations.' },
        { title: 'Error handling',    description: 'Error responses, retry logic, idempotency.' },
        { title: 'Performance',       description: 'Pagination, rate limiting, caching decisions.' },
    ],
    'frontend-handoff': [
        { title: 'UI states',         description: 'Loading, empty, error, and edge case states defined.' },
        { title: 'Responsive',        description: 'Breakpoints and behavior across screen sizes.' },
        { title: 'Validations',       description: 'Client-side validation rules and error messages.' },
        { title: 'API needs',         description: 'What data the frontend needs and in what format.' },
        { title: 'Accessibility',     description: 'A11y considerations and requirements.' },
    ],
    'client-discovery': [
        { title: 'Business objective', description: 'What the client wants to achieve.' },
        { title: 'Constraints',        description: 'Budget, timeline, technical, or organizational limits.' },
        { title: 'Decision-makers',    description: 'Who has authority and what matters to them.' },
        { title: 'Success metrics',    description: 'How the client will measure success.' },
        { title: 'Next steps',         description: 'What needs to happen before the next conversation.' },
    ],
    'sprint-planning': [
        { title: 'Sprint goal',        description: 'The primary objective for this sprint.' },
        { title: 'Prioritized items',  description: 'Tickets ranked by priority and estimated effort.' },
        { title: 'Dependencies',       description: 'Cross-team or external dependencies.' },
        { title: 'Risks',              description: 'Anything that could derail the sprint.' },
        { title: 'Capacity',           description: 'Team availability and any planned time off.' },
    ],
};

const TEMPLATE_SYSTEM_PROMPTS: Record<ModeTemplateType, string> = {
    // General = universal adaptive copilot (own prompt, not technical interview)
    general: MODE_GENERAL_PROMPT,
    'technical-interview': MODE_TECHNICAL_INTERVIEW_PROMPT,

    'looking-for-work': MODE_LOOKING_FOR_WORK_PROMPT,
    sales: MODE_SALES_PROMPT,
    recruiting: MODE_RECRUITING_PROMPT,
    'team-meet': MODE_TEAM_MEET_PROMPT,
    lecture: MODE_LECTURE_PROMPT,
    'bug-triage': MODE_BUG_TRIAGE_PROMPT,
    'feature-planning': MODE_FEATURE_PLANNING_PROMPT,
    'architecture-review': MODE_ARCHITECTURE_REVIEW_PROMPT,
    'coding-assessment': MODE_CODING_ASSESSMENT_PROMPT,
    'product-owner': MODE_FEATURE_PLANNING_PROMPT,
    'tech-lead': MODE_ARCHITECTURE_REVIEW_PROMPT,
    'backend-api': MODE_ARCHITECTURE_REVIEW_PROMPT,
    'frontend-handoff': MODE_FEATURE_PLANNING_PROMPT,
    'client-discovery': MODE_SALES_PROMPT,
    'sprint-planning': MODE_TEAM_MEET_PROMPT,
};

function rowToMode(row: any): Mode {
    return {
        id: row.id,
        name: row.name,
        templateType: row.template_type as ModeTemplateType,
        customContext: row.custom_context ?? '',
        isActive: row.is_active === 1,
        createdAt: row.created_at,
    };
}

function rowToFile(row: any): ModeReferenceFile {
    return {
        id: row.id,
        modeId: row.mode_id,
        fileName: row.file_name,
        content: row.content ?? '',
        createdAt: row.created_at,
    };
}

function rowToSection(row: any): ModeNoteSection {
    return {
        id: row.id,
        modeId: row.mode_id,
        title: row.title,
        description: row.description ?? '',
        sortOrder: row.sort_order ?? 0,
        createdAt: row.created_at,
    };
}

export class ModesManager {
    private static instance: ModesManager;

    private constructor() {}

    public static getInstance(): ModesManager {
        if (!ModesManager.instance) {
            ModesManager.instance = new ModesManager();
        }
        return ModesManager.instance;
    }

    // ── Modes ─────────────────────────────────────────────────────

    public getModes(): Mode[] {
        const modes = DatabaseManager.getInstance().getModes().map(rowToMode);
        
        // Auto-seed the un-deletable General mode if it doesn't exist
        if (!modes.some(m => m.templateType === 'general')) {
            const generalMode = this.createMode({ name: 'General', templateType: 'general' });
            modes.push(generalMode);
        }
        
        // Always enforce 'general' at the very top of the list
        modes.sort((a, b) => {
            if (a.templateType === 'general') return -1;
            if (b.templateType === 'general') return 1;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); // oldest first or whatever default
        });
        
        return modes;
    }

    public getActiveMode(): Mode | null {
        const row = DatabaseManager.getInstance().getActiveMode();
        return row ? rowToMode(row) : null;
    }

    public createMode(params: { name: string; templateType: ModeTemplateType }): Mode {
        const id = `mode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        DatabaseManager.getInstance().createMode({
            id,
            name: params.name,
            templateType: params.templateType,
            customContext: '',
        });
        // Seed default note sections for this template type
        const defaultSections = TEMPLATE_NOTE_SECTIONS[params.templateType] ?? [];
        defaultSections.forEach((s, i) => {
            const sectionId = `ns_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
            DatabaseManager.getInstance().addNoteSection({
                id: sectionId,
                modeId: id,
                title: s.title,
                description: s.description,
                sortOrder: i,
            });
        });
        return {
            id,
            name: params.name,
            templateType: params.templateType,
            customContext: '',
            isActive: false,
            createdAt: new Date().toISOString(),
        };
    }

    public updateMode(id: string, updates: { name?: string; templateType?: ModeTemplateType; customContext?: string }): void {
        DatabaseManager.getInstance().updateMode(id, updates);
    }

    public deleteMode(id: string): void {
        DatabaseManager.getInstance().deleteMode(id);
    }

    public setActiveMode(id: string | null): void {
        DatabaseManager.getInstance().setActiveMode(id);
    }

    // ── Reference Files ───────────────────────────────────────────

    public getReferenceFiles(modeId: string): ModeReferenceFile[] {
        return DatabaseManager.getInstance().getReferenceFiles(modeId).map(rowToFile);
    }

    public addReferenceFile(params: { modeId: string; fileName: string; content: string }): ModeReferenceFile {
        const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        DatabaseManager.getInstance().addReferenceFile({
            id,
            modeId: params.modeId,
            fileName: params.fileName,
            content: params.content,
        });
        return {
            id,
            modeId: params.modeId,
            fileName: params.fileName,
            content: params.content,
            createdAt: new Date().toISOString(),
        };
    }

    public deleteReferenceFile(id: string): void {
        DatabaseManager.getInstance().deleteReferenceFile(id);
    }

    // ── Note Sections ─────────────────────────────────────────────

    public getNoteSections(modeId: string): ModeNoteSection[] {
        return DatabaseManager.getInstance().getNoteSections(modeId).map(rowToSection);
    }

    public addNoteSection(params: { modeId: string; title: string; description: string }): ModeNoteSection {
        const existingSections = this.getNoteSections(params.modeId);
        const sortOrder = existingSections.length;
        const id = `ns_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        DatabaseManager.getInstance().addNoteSection({
            id,
            modeId: params.modeId,
            title: params.title,
            description: params.description,
            sortOrder,
        });
        return {
            id,
            modeId: params.modeId,
            title: params.title,
            description: params.description,
            sortOrder,
            createdAt: new Date().toISOString(),
        };
    }

    public updateNoteSection(id: string, updates: { title?: string; description?: string }): void {
        DatabaseManager.getInstance().updateNoteSection(id, updates);
    }

    public deleteNoteSection(id: string): void {
        DatabaseManager.getInstance().deleteNoteSection(id);
    }

    public removeAllNoteSections(modeId: string): void {
        DatabaseManager.getInstance().deleteAllNoteSections(modeId);
    }

    // ── LLM Context ───────────────────────────────────────────────

    /**
     * Returns the system prompt suffix for the active mode's template type.
     * Empty string if general or no active mode.
     */
    public getActiveModeSystemPromptSuffix(): string {
        const mode = this.getActiveMode();
        if (!mode) return '';
        return TEMPLATE_SYSTEM_PROMPTS[mode.templateType] ?? '';
    }

    /**
     * Builds a context block to inject before the user message for the active mode.
     * Includes custom context text and reference file contents.
     *
     * Limits: each file is capped at MAX_FILE_CHARS to prevent context window overflow.
     * Total block is capped at MAX_TOTAL_CHARS across all files.
     */
    private static readonly MAX_FILE_CHARS = 12_000;
    private static readonly MAX_TOTAL_CHARS = 40_000;

    public buildActiveModeContextBlock(): string {
        const mode = this.getActiveMode();
        if (!mode) return '';

        const parts: string[] = [];

        if (mode.customContext.trim()) {
            parts.push(`<user_context>\n${mode.customContext.trim()}\n</user_context>`);
        }

        const files = this.getReferenceFiles(mode.id);
        let totalChars = 0;

        for (const file of files) {
            const raw = file.content.trim();
            if (!raw) continue;

            const remaining = ModesManager.MAX_TOTAL_CHARS - totalChars;
            if (remaining <= 0) break;

            // Slice first, then append truncation marker so total never exceeds MAX_FILE_CHARS
            const capped = raw.length > ModesManager.MAX_FILE_CHARS
                ? raw.slice(0, ModesManager.MAX_FILE_CHARS - 14) + '\n[...truncated]'
                : raw;
            const used = Math.min(capped.length, remaining);
            const content = capped.slice(0, used);

            parts.push(`<reference_file name="${file.fileName}">\n${content}\n</reference_file>`);
            totalChars += content.length;
        }

        return parts.join('\n\n');
    }
}
