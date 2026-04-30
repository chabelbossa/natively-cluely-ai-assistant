export interface TranscriptPostProcessorConfig {
    glossary?: string;
}

export interface TranscriptPostProcessorResult {
    text: string;
    dropped: boolean;
    reason?: string;
}

const DEFAULT_GLOSSARY_TERMS = [
    'Kyntia',
    'SSO',
    'Next.js',
    'NestJS',
    'WaChap',
    'Kloo',
    'Artiweb',
    'API',
    'frontend',
    'backend',
];

const LOW_INFORMATION_UTTERANCES = new Set([
    'you',
    'thank you',
    'thanks',
    'hello',
    'hi',
    'uh',
    'um',
    'hmm',
    '안녕하세요',
    'i am sorry',
    "i'm sorry",
]);

const DEFAULT_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(?:kinshara|quintia|kentia|cynthia|kintia|kyntia)\b/gi, 'Kyntia'],
    [/\b(?:s s o|single sign on|single sign-on)\b/gi, 'SSO'],
    [/\b(?:net\s?js|next js|nextjs)\b/gi, 'Next.js'],
    [/\b(?:nest\s?js|nsjs|nesjs)\b/gi, 'NestJS'],
    [/\b(?:whats\s?app|watch\s?app|wachap|wa\s?chap)\b/gi, 'WaChap'],
    [/\b(?:clos|kloo|cloo)\b/gi, 'Kloo'],
    [/\b(?:arti\s?web|arty\s?web|artiweb)\b/gi, 'Artiweb'],
    [/\b(?:a p i|apis)\b/gi, 'API'],
    [/\bfront[\s-]?end\b/gi, 'frontend'],
    [/\bback[\s-]?end\b/gi, 'backend'],
];

export class TranscriptPostProcessor {
    private readonly glossaryTerms: string[];

    constructor(config: TranscriptPostProcessorConfig = {}) {
        this.glossaryTerms = TranscriptPostProcessor.parseGlossary(config.glossary);
    }

    process(text: string, options: { final: boolean }): TranscriptPostProcessorResult {
        const trimmed = this.normalizeWhitespace(text);
        if (!trimmed) {
            return { text: '', dropped: true, reason: 'empty' };
        }

        if (options.final && this.isLowInformation(trimmed)) {
            return { text: '', dropped: true, reason: 'low_information' };
        }

        const normalized = this.applyGlossary(trimmed);
        return { text: normalized, dropped: false };
    }

    static parseGlossary(glossary?: string): string[] {
        const userTerms = (glossary || '')
            .split(/[\n,]/)
            .map(term => term.trim())
            .filter(Boolean);

        return Array.from(new Set([...DEFAULT_GLOSSARY_TERMS, ...userTerms]));
    }

    private applyGlossary(text: string): string {
        let next = text;
        for (const [pattern, replacement] of DEFAULT_REPLACEMENTS) {
            next = next.replace(pattern, replacement);
        }

        for (const term of this.glossaryTerms) {
            if (!term || term.length < 2) continue;
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            next = next.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), term);
        }

        return this.normalizeWhitespace(next);
    }

    private isLowInformation(text: string): boolean {
        const normalized = text
            .toLowerCase()
            .replace(/[.!?,;:…]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalized) return true;
        if (LOW_INFORMATION_UTTERANCES.has(normalized)) return true;
        return normalized.length <= 2;
    }

    private normalizeWhitespace(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }
}

