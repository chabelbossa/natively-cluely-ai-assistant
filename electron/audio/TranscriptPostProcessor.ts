export interface TranscriptPostProcessorConfig {
  glossary?: string;
}

export interface TranscriptPostProcessorResult {
  text: string;
  dropped: boolean;
  reason?: string;
}

export interface TranscriptPostProcessorOptions {
  final: boolean;
  confidence?: number;
}

const DEFAULT_GLOSSARY_TERMS = [
  "Kyntia",
  "SSO",
  "Next.js",
  "NestJS",
  "WaChap",
  "Kloo",
  "Artiweb",
  "API",
  "frontend",
  "backend",
];

const LOW_INFORMATION_UTTERANCES = new Set([
  "you",
  "thank you",
  "thanks",
  "hello",
  "hi",
  "uh",
  "um",
  "hmm",
  "안녕하세요",
  "i am sorry",
  "i'm sorry",
  "three",
  "people may have",
  "there s um",
  "there's um",
  "more due",
  "oh they go",
]);

const DEFAULT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(?:kinshara|quintia|kentia|cynthia|kintia|kyntia)\b/gi, "Kyntia"],
  [/\b(?:s s o|single sign on|single sign-on)\b/gi, "SSO"],
  [/\b(?:net\s?js|next js|nextjs)\b/gi, "Next.js"],
  [/\b(?:nest\s?js|nsjs|nesjs)\b/gi, "NestJS"],
  [/\b(?:whats\s?app|watch\s?app|wachap|wa\s?chap)\b/gi, "WaChap"],
  [/\b(?:clos|kloo|cloo)\b/gi, "Kloo"],
  [/\b(?:arti\s?web|arty\s?web|artiweb)\b/gi, "Artiweb"],
  [/\b(?:a p i|apis)\b/gi, "API"],
  [/\bfront[\s-]?end\b/gi, "frontend"],
  [/\bback[\s-]?end\b/gi, "backend"],
  [/\b(?:voice\s?ink|voice\s?inc|voicink|voiceinc|please ink)\b/gi, "VoiceInk"],
  [/\bi\s+don['’]?t\s+know\b/gi, "je ne sais pas"],
  [/\bj\s+say\b/gi, "je sais"],
];

const FRENCH_SIGNAL_WORDS = new Set([
  "je",
  "j",
  "tu",
  "il",
  "elle",
  "nous",
  "vous",
  "ils",
  "elles",
  "on",
  "me",
  "moi",
  "toi",
  "lui",
  "est",
  "suis",
  "es",
  "sommes",
  "etes",
  "sont",
  "ai",
  "as",
  "a",
  "avons",
  "avez",
  "ont",
  "pas",
  "ne",
  "que",
  "qui",
  "quoi",
  "quand",
  "comment",
  "pour",
  "avec",
  "dans",
  "sur",
  "mais",
  "donc",
  "c",
  "ce",
  "ces",
  "cette",
  "ca",
  "ça",
  "les",
  "des",
  "une",
  "un",
  "de",
  "du",
  "au",
  "aux",
  "et",
  "ou",
  "la",
  "le",
  "l",
  "transcription",
  "pause",
  "pauses",
  "parle",
  "dire",
  "dit",
  "fait",
  "faire",
  "fonctionne",
  "bonjour",
  "oui",
  "non",
  "d accord",
  "c'est",
]);

const SHORT_ENGLISH_HALLUCINATION_WORDS = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "be",
  "do",
  "due",
  "go",
  "have",
  "hello",
  "hi",
  "i",
  "is",
  "it",
  "may",
  "more",
  "oh",
  "people",
  "s",
  "say",
  "thank",
  "thanks",
  "there",
  "they",
  "three",
  "to",
  "um",
  "you",
]);

export class TranscriptPostProcessor {
  private readonly glossaryTerms: string[];

  constructor(config: TranscriptPostProcessorConfig = {}) {
    this.glossaryTerms = TranscriptPostProcessor.parseGlossary(config.glossary);
  }

  process(
    text: string,
    options: TranscriptPostProcessorOptions,
  ): TranscriptPostProcessorResult {
    const trimmed = this.normalizeWhitespace(text);
    if (!trimmed) {
      return { text: "", dropped: true, reason: "empty" };
    }

    const normalized = this.applyGlossary(trimmed);

    if (this.isLowInformation(normalized)) {
      return { text: "", dropped: true, reason: "low_information" };
    }

    if (this.isLikelyShortEnglishHallucination(normalized)) {
      return { text: "", dropped: true, reason: "short_english_hallucination" };
    }

    return { text: normalized, dropped: false };
  }

  static parseGlossary(glossary?: string): string[] {
    const userTerms = (glossary || "")
      .split(/[\n,]/)
      .map((term) => term.trim())
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
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      next = next.replace(new RegExp(`\\b${escaped}\\b`, "gi"), term);
    }

    return this.normalizeWhitespace(next);
  }

  private isLowInformation(text: string): boolean {
    const normalized = this.normalizeForFiltering(text);

    if (!normalized) return true;
    if (LOW_INFORMATION_UTTERANCES.has(normalized)) return true;
    return normalized.length <= 2;
  }

  private isLikelyShortEnglishHallucination(text: string): boolean {
    if (/[àâäçéèêëîïôöùûüÿœ]/i.test(text)) return false;

    const normalized = this.normalizeForFiltering(text);
    if (!normalized) return true;

    const words = normalized.split(" ").filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;
    if (words.some((word) => FRENCH_SIGNAL_WORDS.has(word))) return false;
    if (this.hasGlossarySignal(normalized)) return false;

    return words.every((word) => SHORT_ENGLISH_HALLUCINATION_WORDS.has(word));
  }

  private hasGlossarySignal(normalizedText: string): boolean {
    return this.glossaryTerms.some((term) => {
      if (!term || term.length < 2) return false;
      const normalizedTerm = this.normalizeForFiltering(term);
      return Boolean(normalizedTerm) && normalizedText.includes(normalizedTerm);
    });
  }

  private normalizeForFiltering(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[’']/g, " ")
      .replace(/[.!?,;:…]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }
}
