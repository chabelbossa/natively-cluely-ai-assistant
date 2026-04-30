const STOP_WORDS = new Set([
    'about', 'after', 'again', 'ainsi', 'also', 'avec', 'because', 'before', 'cela', 'cette',
    'dans', 'donc', 'elle', 'elles', 'encore', 'entre', 'est', 'etait', 'etre', 'from',
    'have', 'here', 'il', 'ils', 'into', 'les', 'leur', 'mais', 'more', 'nous', 'pour',
    'quand', 'que', 'qui', 'sans', 'sont', 'sur', 'that', 'the', 'their', 'then', 'there',
    'this', 'très', 'une', 'vous', 'what', 'when', 'where', 'with', 'would'
]);

export function normalizeText(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function getContentWords(value: string): string[] {
    const seen = new Set<string>();
    const words: string[] = [];

    for (const word of normalizeText(value).split(' ')) {
        if (word.length < 4 || STOP_WORDS.has(word) || seen.has(word)) continue;
        seen.add(word);
        words.push(word);
    }

    return words;
}

export function countWordOverlap(left: string, right: string): number {
    const rightWords = new Set(getContentWords(right));
    return getContentWords(left).filter(word => rightWords.has(word)).length;
}

export function similarityScore(left: string, right: string): number {
    const leftWords = getContentWords(left);
    const rightWords = new Set(getContentWords(right));
    if (leftWords.length === 0 || rightWords.size === 0) return 0;

    const overlap = leftWords.filter(word => rightWords.has(word)).length;
    return overlap / Math.max(leftWords.length, rightWords.size);
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
