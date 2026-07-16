import { CODEX_MODELS, getCodexModelLabel } from '../config/codexModels';

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
        ids: CODEX_MODELS.map(model => model.id),
        names: CODEX_MODELS.map(model => model.label),
        descs: CODEX_MODELS.map(model => model.description),
        pmKey: 'codexPreferredModel'
    },
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    const codexLabel = getCodexModelLabel(id);
    if (codexLabel) return codexLabel;
    return id
        .replace(/^codex:/, '')
        .replace(/[\/:_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};
