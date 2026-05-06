import type {
  CanonicalTranscriptSegment,
  RawTranscriptSegment,
  TranscriptQualityFlag,
  TranscriptRouteResult,
} from './types';

const MAX_RECENT_SEGMENTS = 80;
const ECHO_WINDOW_MS = 12_000;
const SYSTEM_ACTIVE_WINDOW_MS = 3_500;

export class TranscriptRouter {
  private recentSystem: CanonicalTranscriptSegment[] = [];
  private recentCanonical: CanonicalTranscriptSegment[] = [];
  private sequence = 0;

  route(raw: RawTranscriptSegment): TranscriptRouteResult {
    const text = raw.text.trim();
    if (!text) {
      return { suppressed: true, reason: 'empty_text' };
    }

    const now = raw.timestamp || Date.now();
    this.prune(now);

    if (raw.channel === 'system') {
      const segment = this.toSystemSegment({ ...raw, text, timestamp: now });
      this.remember(segment);
      return { segment };
    }

    const echo = this.findSystemEcho(text, now);
    if (echo && !this.looksLikeLocalUserIntervention(text)) {
      return {
        suppressed: true,
        reason: 'mic_echo_of_system_audio',
        matchedSpeaker: echo.segment.speaker,
        similarity: echo.similarity,
      };
    }

    const systemRecentlyActive = Boolean(raw.systemAudioActive) || this.wasSystemRecentlyActive(now);
    if (systemRecentlyActive && !this.looksLikeLocalUserIntervention(text)) {
      return {
        suppressed: true,
        reason: 'mic_during_system_audio_without_local_intent',
      };
    }

    const flags: TranscriptQualityFlag[] = [];
    if (raw.confidence !== undefined && raw.confidence < 0.72) flags.push('low_confidence');
    if (systemRecentlyActive) flags.push('possible_overlap');
    if (this.looksLikeLocalUserIntervention(text)) flags.push('mic_intervention');

    const segment: CanonicalTranscriptSegment = {
      id: this.nextId(raw.channel, raw.timestamp),
      role: 'me',
      source: 'mic',
      speaker: 'me',
      text,
      timestamp: now,
      final: raw.final,
      confidence: raw.confidence,
      qualityFlags: flags,
      rawSpeaker: raw.speaker,
      provider: raw.provider,
      speakerId: raw.speakerId,
    };

    this.remember(segment);
    return { segment };
  }

  reset(): void {
    this.recentSystem = [];
    this.recentCanonical = [];
    this.sequence = 0;
  }

  getRecentCanonicalSegments(): CanonicalTranscriptSegment[] {
    return [...this.recentCanonical];
  }

  private toSystemSegment(raw: RawTranscriptSegment): CanonicalTranscriptSegment {
    const flags: TranscriptQualityFlag[] = ['system_audio'];
    const hasReliableDiarization =
      raw.diarized === true &&
      raw.speakerId !== undefined &&
      Number.isFinite(raw.speakerId);

    if (raw.confidence !== undefined && raw.confidence < 0.72) flags.push('low_confidence');

    let role: CanonicalTranscriptSegment['role'] = 'interlocutor';
    let speaker = 'interlocutor';
    if (hasReliableDiarization) {
      const normalizedSpeakerId = Math.max(0, Number(raw.speakerId));
      role = normalizedSpeakerId === 0
        ? 'speaker_1'
        : normalizedSpeakerId === 1
          ? 'speaker_2'
          : 'uncertain';
      speaker = normalizedSpeakerId <= 1 ? `speaker_${normalizedSpeakerId + 1}` : `speaker_${normalizedSpeakerId + 1}`;
      if (role === 'uncertain' || raw.confidence === undefined || raw.confidence < 0.85) {
        flags.push('speaker_uncertain');
      }
    }

    return {
      id: this.nextId(raw.channel, raw.timestamp),
      role,
      source: 'system',
      speaker,
      text: raw.text.trim(),
      timestamp: raw.timestamp,
      final: raw.final,
      confidence: raw.confidence,
      qualityFlags: flags,
      rawSpeaker: raw.speaker,
      provider: raw.provider,
      speakerId: raw.speakerId,
    };
  }

  private remember(segment: CanonicalTranscriptSegment): void {
    this.recentCanonical.push(segment);
    if (this.recentCanonical.length > MAX_RECENT_SEGMENTS) {
      this.recentCanonical = this.recentCanonical.slice(-MAX_RECENT_SEGMENTS);
    }

    if (segment.source === 'system') {
      this.recentSystem.push(segment);
      if (this.recentSystem.length > MAX_RECENT_SEGMENTS) {
        this.recentSystem = this.recentSystem.slice(-MAX_RECENT_SEGMENTS);
      }
    }
  }

  private prune(now: number): void {
    const cutoff = now - ECHO_WINDOW_MS;
    this.recentSystem = this.recentSystem.filter((segment) => segment.timestamp >= cutoff);
    this.recentCanonical = this.recentCanonical.filter((segment) => segment.timestamp >= cutoff);
  }

  private wasSystemRecentlyActive(timestamp: number): boolean {
    return this.recentSystem.some((segment) => timestamp - segment.timestamp <= SYSTEM_ACTIVE_WINDOW_MS);
  }

  private findSystemEcho(text: string, timestamp: number): { segment: CanonicalTranscriptSegment; similarity: number } | null {
    let best: { segment: CanonicalTranscriptSegment; similarity: number } | null = null;
    for (const segment of this.recentSystem) {
      if (Math.abs(timestamp - segment.timestamp) > ECHO_WINDOW_MS) continue;
      const similarity = this.textSimilarity(text, segment.text);
      if (similarity >= 0.45 && (!best || similarity > best.similarity)) {
        best = { segment, similarity };
      }
    }
    return best;
  }

  private looksLikeLocalUserIntervention(text: string): boolean {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 3) return false;

    const hasQuestionSignal = /\?$/.test(text.trim()) ||
      /\b(est ce que|est ce qu|pourquoi|comment|quand|qui|quel|quelle|quels|quelles|combien|ou|où|what|why|how|when|where|who|which|can you|could you|do you|does it)\b/i.test(normalized);

    const hasLearnerSignal = /\b(si je comprends|je comprends|si j ai bien compris|j ai bien compris|je ne comprends|je n ai pas compris|je veux comprendre|ca veut dire|ça veut dire|donc si|pour mieux comprendre|que dire)\b/i.test(normalized);

    const hasPromptingSignal = /\b(explique|expliquez|precise|précise|clarifie|clarifiez|reprends|reprenez|dis nous|dites nous|dis moi|dites moi|peux tu|pouvez vous|tu peux|vous pouvez|tell me|explain|clarify)\b/i.test(normalized);

    const hasTurnSignal = /\b(ok|okay|d accord|daccord|attends|attendez|pardon|excuse moi|excusez moi|je te suis|je vous suis)\b/i.test(normalized) &&
      words.length >= 5;

    return hasQuestionSignal || hasLearnerSignal || hasPromptingSignal || hasTurnSignal;
  }

  private textSimilarity(a: string, b: string): number {
    const aWords = this.normalize(a).split(' ').filter(Boolean);
    const bWords = this.normalize(b).split(' ').filter(Boolean);
    if (aWords.length === 0 || bWords.length === 0) return 0;

    const aSet = new Set(aWords);
    const bSet = new Set(bWords);
    let intersection = 0;
    for (const word of aSet) {
      if (bSet.has(word)) intersection++;
    }

    const union = new Set([...aSet, ...bSet]).size;
    return union === 0 ? 0 : intersection / union;
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private nextId(channel: string, timestamp: number): string {
    this.sequence += 1;
    return `canonical_${channel}_${timestamp}_${this.sequence}`;
  }
}
