export const STANDARD_CLOUD_MODELS: Record<string, {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
    pmKey: 'geminiPreferredModel' | 'groqPreferredModel' | 'deepinfraPreferredModel' | 'openCodeGoPreferredModel' | 'openaiPreferredModel' | 'claudePreferredModel' | 'codexPreferredModel';
}> = {
    gemini: {
        hasKeyCheck: (creds) => !!creds?.hasGeminiKey,
        ids: ['gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview'],
        names: ['Gemini 3.1 Flash', 'Gemini 3.1 Pro'],
        descs: ['Fastest • Multimodal', 'Reasoning • High Quality'],
        pmKey: 'geminiPreferredModel'
    },
    groq: {
        hasKeyCheck: (creds) => !!creds?.hasGroqKey,
        ids: ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
        names: ['Groq GPT OSS 20B', 'Groq Llama 3.3 70B'],
        descs: ['Very fast • Strong', 'Balanced • Larger'],
        pmKey: 'groqPreferredModel'
    },
    deepinfra: {
        hasKeyCheck: (creds) => !!creds?.hasDeepInfraKey,
        ids: ['deepinfra:stepfun-ai/Step-3.5-Flash', 'deepinfra:meta-llama/Meta-Llama-3.1-8B-Instruct'],
        names: ['DeepInfra Step 3.5 Flash', 'DeepInfra Llama 3.1 8B'],
        descs: ['Flash • Low latency', 'Fast • Open source'],
        pmKey: 'deepinfraPreferredModel'
    },
    opencode_go: {
        hasKeyCheck: (creds) => !!creds?.hasOpenCodeGoKey,
        ids: ['opencode-go/deepseek-v4-flash'],
        names: ['OpenCode Go DeepSeek V4 Flash'],
        descs: ['Flash • Low latency'],
        pmKey: 'openCodeGoPreferredModel'
    },
    openai: {
        hasKeyCheck: (creds) => !!creds?.hasOpenaiKey,
        ids: ['gpt-5.4'],
        names: ['GPT 5.4'],
        descs: ['OpenAI'],
        pmKey: 'openaiPreferredModel'
    },
    claude: {
        hasKeyCheck: (creds) => !!creds?.hasClaudeKey,
        ids: ['claude-sonnet-4-6'],
        names: ['Sonnet 4.6'],
        descs: ['Anthropic'],
        pmKey: 'claudePreferredModel'
    },
    codex: {
        hasKeyCheck: (creds) => !!creds?.hasCodexAccounts,
        ids: ['gpt-5.2', 'gpt-5.1'],
        names: ['GPT 5.2 Codex', 'GPT 5.1 Codex'],
        descs: ['ChatGPT Plus/Pro • Best', 'ChatGPT Plus/Pro • Fast'],
        pmKey: 'codexPreferredModel'
    },
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    return id
        .replace(/^deepinfra:/, '')
        .replace(/^opencode-go[/:]/, '')
        .replace(/[\/:_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};
