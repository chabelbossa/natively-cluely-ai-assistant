/**
 * modelFetcher.ts - Dynamic Model Discovery
 * Fetches available models from AI provider APIs
 */

import axios from 'axios';

export interface ProviderModel {
    id: string;
    label: string;
}

type Provider = 'gemini' | 'groq' | 'deepinfra' | 'opencode_go' | 'openai' | 'claude';

const DEEPINFRA_DEFAULT_ORDER = [
    'stepfun-ai/Step-3.5-Flash',
    'Qwen/Qwen3.5-4B',
    'meta-llama/Meta-Llama-3.1-8B-Instruct',
    'openai/gpt-oss-20b',
    'Qwen/Qwen3-8B',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'deepseek-ai/DeepSeek-V3',
];

const OPENCODE_GO_DEFAULT_ORDER = [
    'deepseek-v4-flash',
    'qwen3.5-plus',
    'mimo-v2.5',
    'kimi-k2.5',
    'glm-5',
    'deepseek-v4-pro',
    'kimi-k2.6',
    'glm-5.1',
];

/**
 * Fetch available models from a provider's API.
 * Returns a filtered, sorted array of { id, label } objects.
 */
export async function fetchProviderModels(
    provider: Provider,
    apiKey: string
): Promise<ProviderModel[]> {
    switch (provider) {
        case 'openai':
            return fetchOpenAIModels(apiKey);
        case 'groq':
            return fetchGroqModels(apiKey);
        case 'deepinfra':
            return fetchDeepInfraModels(apiKey);
        case 'opencode_go':
            return fetchOpenCodeGoModels(apiKey);
        case 'claude':
            return fetchAnthropicModels(apiKey);
        case 'gemini':
            return fetchGeminiModels(apiKey);
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

function sortByPreference(models: ProviderModel[], orderedIds: string[], idMapper: (id: string) => string = id => id): ProviderModel[] {
    const rank = new Map(orderedIds.map((id, index) => [id.toLowerCase(), index]));
    return [...models].sort((a, b) => {
        const aRank = rank.get(idMapper(a.id).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        const bRank = rank.get(idMapper(b.id).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) return aRank - bRank;
        return a.label.localeCompare(b.label);
    });
}

function prettifyModelLabel(id: string): string {
    return id
        .replace(/^deepinfra:/, '')
        .replace(/^opencode-go[/:]/, '')
        .split(/[/:]/)
        .pop()!
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function fetchOpenAIModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
    });

    const models: any[] = response.data?.data || [];

    // Only include: gpt-4o series, gpt-5.x+, o1, o3, o4 series
    const filtered = models.filter((m: any) => {
        const id = (m.id || '').toLowerCase();
        // Include gpt-4o variants
        if (id.includes('gpt-4o')) return true;
        // Include gpt-5 and above
        if (/gpt-[5-9]/.test(id)) return true;
        // Include o1/o3/o4 reasoning models (but not audio/realtime variants)
        if (/^o[134]/.test(id) && !id.includes('audio') && !id.includes('realtime')) return true;
        return false;
    });

    return filtered
        .map((m: any) => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Groq ────────────────────────────────────────────────────────────────────

async function fetchGroqModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
    });

    const models: any[] = response.data?.data || [];

    // Only include text/chat models — exclude everything non-chat
    const excludePatterns = [
        'whisper', 'distil', 'guard', 'tool-use',
        'vision-preview', 'tts', 'playai', 'speech',
    ];

    const filtered = models.filter((m: any) => {
        const id = (m.id || '').toLowerCase();
        return !excludePatterns.some(p => id.includes(p));
    });

    const mapped = filtered
        .map((m: any) => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return sortByPreference(mapped, ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile']);
}

// ─── DeepInfra ───────────────────────────────────────────────────────────────

async function fetchDeepInfraModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get('https://api.deepinfra.com/v1/openai/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        timeout: 15000,
    });

    const models: any[] = response.data?.data || [];
    const excludePatterns = [
        'embedding', 'rerank', 'whisper', 'tts', 'speech', 'audio',
        'image', 'vision', 'stable-diffusion', 'flux', 'sdxl', 'ocr',
    ];

    const filtered = models.filter((m: any) => {
        const id = String(m.id || '');
        const lower = id.toLowerCase();
        if (!id || excludePatterns.some(p => lower.includes(p))) return false;
        const hasChatMetadata = !!m.metadata?.context_length || !!m.metadata?.max_tokens;
        const likelyChat = /instruct|chat|gpt-oss|deepseek|qwen|mistral|llama|glm|kimi/i.test(id);
        return hasChatMetadata || likelyChat;
    });

    const mapped = filtered.map((m: any) => ({
        id: `deepinfra:${m.id}`,
        label: prettifyModelLabel(m.id),
    }));

    return sortByPreference(mapped, DEEPINFRA_DEFAULT_ORDER, id => id.replace(/^deepinfra:/, ''));
}

// ─── OpenCode Go ─────────────────────────────────────────────────────────────

async function fetchOpenCodeGoModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get('https://opencode.ai/zen/go/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        timeout: 15000,
    });

    const models: any[] = response.data?.data || [];

    const compatibleIds = new Set([
        'glm-5.1',
        'glm-5',
        'kimi-k2.5',
        'kimi-k2.6',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'mimo-v2-pro',
        'mimo-v2-omni',
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'qwen3.6-plus',
        'qwen3.5-plus',
    ]);

    const mapped = models
        .filter((m: any) => compatibleIds.has(String(m.id || '')))
        .map((m: any) => ({
            id: `opencode-go/${m.id}`,
            label: prettifyModelLabel(m.id),
        }));

    return sortByPreference(mapped, OPENCODE_GO_DEFAULT_ORDER, id => id.replace(/^opencode-go\//, ''));
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

async function fetchAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get('https://api.anthropic.com/v1/models', {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        timeout: 15000,
    });

    const models: any[] = response.data?.data || [];

    // Only include Claude 3.5+ models (haiku, sonnet, opus)
    const filtered = models.filter((m: any) => {
        const id = (m.id || '').toLowerCase();
        if (!id.includes('claude')) return false;
        
        // Match models that are version 3.5, 3.7, 4.0, etc.
        // e.g. claude-3-5-sonnet, claude-3-7-sonnet, claude-4-opus
        const versionMatch = id.match(/claude-(\d+)-(\d+)?/);
        if (versionMatch) {
            const major = parseInt(versionMatch[1], 10);
            const minor = versionMatch[2] ? parseInt(versionMatch[2], 10) : 0;
            if (major > 3 || (major === 3 && minor >= 5)) {
                return true;
            }
        }
        return false;
    });

    return filtered
        .map((m: any) => ({ id: m.id, label: m.display_name || m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

async function fetchGeminiModels(apiKey: string): Promise<ProviderModel[]> {
    const response = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        {
            timeout: 15000,
        }
    );

    const models: any[] = response.data?.models || [];

    // Only include Gemini 2.5+ models (gemini-2.5-*, gemini-3-*, etc.)
    // Must support generateContent
    const excludePatterns = ['nano', 'custom', 'computer-use', 'banana', 'tts', 'embedding', 'aqa', 'vision'];

    const filtered = models.filter((m: any) => {
        const name = (m.name || '').toLowerCase();
        const displayName = (m.displayName || '').toLowerCase();
        const combined = name + ' ' + displayName;

        // Must support generateContent
        const supportsChat = m.supportedGenerationMethods?.includes('generateContent');
        if (!supportsChat) return false;

        // Must NOT match any exclude patterns
        if (excludePatterns.some(p => combined.includes(p))) return false;

        // Match gemini-2.5, gemini-3, gemini-4, etc. (version 2.5 and above)
        return /gemini-([3-9]|2\.5)/.test(combined);
    });

    return filtered
        .map((m: any) => {
            const id = (m.name || '').replace(/^models\//, '');
            return { id, label: m.displayName || id };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
}
