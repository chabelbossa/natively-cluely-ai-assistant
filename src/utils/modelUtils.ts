export const STANDARD_CLOUD_MODELS: Record<string, {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
    pmKey: 'geminiPreferredModel' | 'codexPreferredModel';
}> = {
    gemini: {
        hasKeyCheck: (creds) => !!creds?.hasGeminiKey,
        ids: ['gemini-3.5-flash', 'gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview'],
        names: ['Gemini 3.5 Flash', 'Gemini 3.1 Flash', 'Gemini 3.1 Pro'],
        descs: ['Fast • Multimodal • Latest', 'Fastest • Multimodal', 'Reasoning • High Quality'],
        pmKey: 'geminiPreferredModel'
    },
    codex: {
        hasKeyCheck: (creds) => !!creds?.hasCodexAccounts,
        ids: ['codex:gpt-5.5', 'codex:gpt-5.4', 'codex:gpt-5.4-mini', 'codex:gpt-5.3', 'codex:gpt-5.3-codex-spark', 'codex:gpt-5.2', 'codex:gpt-5.1', 'codex:gpt-5'],
        names: ['GPT 5.5 Codex', 'GPT 5.4 Codex', 'GPT 5.4 Mini Codex', 'GPT 5.3 Codex', 'GPT 5.3 Codex Spark', 'GPT 5.2 Codex', 'GPT 5.1 Codex', 'GPT 5 Codex'],
        descs: ['ChatGPT Plus/Pro • Fast mode', 'ChatGPT Plus/Pro • Fast mode', 'ChatGPT Plus/Pro • Fast fallback', 'ChatGPT Plus/Pro • Balanced', 'ChatGPT Plus/Pro • Spark fallback', 'ChatGPT Plus/Pro • Stable', 'ChatGPT Plus/Pro • Legacy', 'ChatGPT Plus/Pro • Base'],
        pmKey: 'codexPreferredModel'
    },
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    return id
        .replace(/^codex:/, '')
        .replace(/[\/:_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};
