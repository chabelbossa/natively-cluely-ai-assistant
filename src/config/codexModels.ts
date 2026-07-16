export const CODEX_REASONING_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const;

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

export interface CodexModelDefinition {
    id: string;
    slug: string;
    label: string;
    shortLabel: string;
    description: string;
    defaultReasoningEffort: CodexReasoningEffort;
    supportedReasoningEfforts: readonly CodexReasoningEffort[];
    generation: 'gpt-5.6' | 'legacy';
    role: 'frontier' | 'balanced' | 'fast' | 'fallback';
}

const STANDARD_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const GPT_56_REASONING_EFFORTS = [
    ...STANDARD_REASONING_EFFORTS,
    'max',
    'ultra',
] as const;
const GPT_56_LUNA_REASONING_EFFORTS = [
    ...STANDARD_REASONING_EFFORTS,
    'max',
] as const;

export const CODEX_MODELS: readonly CodexModelDefinition[] = [
    {
        id: 'codex:gpt-5.6-sol',
        slug: 'gpt-5.6-sol',
        label: 'GPT 5.6 Sol',
        shortLabel: '5.6 Sol',
        description: 'Most capable • Complex, high-value work',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
        generation: 'gpt-5.6',
        role: 'frontier',
    },
    {
        id: 'codex:gpt-5.6-terra',
        slug: 'gpt-5.6-terra',
        label: 'GPT 5.6 Terra',
        shortLabel: '5.6 Terra',
        description: 'Recommended • Strong and responsive',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
        generation: 'gpt-5.6',
        role: 'balanced',
    },
    {
        id: 'codex:gpt-5.6-luna',
        slug: 'gpt-5.6-luna',
        label: 'GPT 5.6 Luna',
        shortLabel: '5.6 Luna',
        description: 'Fastest • Clear, repeatable tasks',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: GPT_56_LUNA_REASONING_EFFORTS,
        generation: 'gpt-5.6',
        role: 'fast',
    },
    {
        id: 'codex:gpt-5.5',
        slug: 'gpt-5.5',
        label: 'GPT 5.5',
        shortLabel: '5.5',
        description: 'Previous frontier • Compatibility fallback',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: STANDARD_REASONING_EFFORTS,
        generation: 'legacy',
        role: 'fallback',
    },
    {
        id: 'codex:gpt-5.4',
        slug: 'gpt-5.4',
        label: 'GPT 5.4',
        shortLabel: '5.4',
        description: 'Stable everyday coding fallback',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: STANDARD_REASONING_EFFORTS,
        generation: 'legacy',
        role: 'fallback',
    },
    {
        id: 'codex:gpt-5.4-mini',
        slug: 'gpt-5.4-mini',
        label: 'GPT 5.4 Mini',
        shortLabel: '5.4 Mini',
        description: 'Small, efficient fallback',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: STANDARD_REASONING_EFFORTS,
        generation: 'legacy',
        role: 'fallback',
    },
    {
        id: 'codex:gpt-5.3-codex-spark',
        slug: 'gpt-5.3-codex-spark',
        label: 'GPT 5.3 Codex Spark',
        shortLabel: '5.3 Spark',
        description: 'Ultra-fast text-only research preview',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: STANDARD_REASONING_EFFORTS,
        generation: 'legacy',
        role: 'fallback',
    },
];

export const DEFAULT_CODEX_MODEL = 'codex:gpt-5.6-terra';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium';

export const CODEX_EXPERIENCE_PRESETS = [
    {
        id: 'quick',
        label: 'Quick',
        description: 'Live prompts and short answers',
        modelId: 'codex:gpt-5.6-luna',
        reasoningEffort: 'low' as CodexReasoningEffort,
    },
    {
        id: 'balanced',
        label: 'Balanced',
        description: 'Recommended for everyday meetings',
        modelId: DEFAULT_CODEX_MODEL,
        reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        recommended: true,
    },
    {
        id: 'deep',
        label: 'Deep',
        description: 'Hard questions and polished analysis',
        modelId: 'codex:gpt-5.6-sol',
        reasoningEffort: 'high' as CodexReasoningEffort,
    },
] as const;

export const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
    ultra: 'Ultra',
};

const CODEX_MODEL_BY_ID = new Map(CODEX_MODELS.map((model) => [model.id, model]));
const CODEX_MODEL_BY_SLUG = new Map(CODEX_MODELS.map((model) => [model.slug, model]));

export const getCodexModel = (modelId: string): CodexModelDefinition | undefined => {
    const normalized = String(modelId || '').trim();
    return CODEX_MODEL_BY_ID.get(normalized)
        || CODEX_MODEL_BY_SLUG.get(normalized.replace(/^codex:/, ''));
};

export const isSupportedCodexModelId = (modelId: string): boolean => Boolean(getCodexModel(modelId));

export const getCodexModelLabel = (modelId: string): string | undefined => getCodexModel(modelId)?.label;

export const resolveCodexModelId = (modelId?: string | null): string => {
    const normalized = String(modelId || '').trim();
    return getCodexModel(normalized)?.id || DEFAULT_CODEX_MODEL;
};

export const resolveCodexReasoningEffort = (
    modelId: string,
    requestedEffort?: string | null,
): CodexReasoningEffort => {
    const model = getCodexModel(modelId) || getCodexModel(DEFAULT_CODEX_MODEL)!;
    const normalizedEffort = String(requestedEffort || '').trim() as CodexReasoningEffort;
    return model.supportedReasoningEfforts.includes(normalizedEffort)
        ? normalizedEffort
        : model.defaultReasoningEffort;
};
