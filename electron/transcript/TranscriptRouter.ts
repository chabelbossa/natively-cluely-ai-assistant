import type {
  CanonicalSpeakerRole,
  CanonicalTranscriptSegment,
  RawTranscriptSegment,
  TranscriptQualityFlag,
  TranscriptRouteResult,
} from './types';

const MAX_RECENT_SEGMENTS = 80;
const ECHO_WINDOW_MS = 12_000;
const LONG_SYSTEM_MEMORY_MS = 10 * 60_000;
const MAX_LONG_SYSTEM_FINALS = 240;
const MAX_LONG_CANONICAL_FINALS = 320;
const SYSTEM_ACTIVE_WINDOW_MS = 3_500;
const MIC_LOCAL_INTENT_THRESHOLD = 0.38;
const MIC_LOCAL_INTENT_WHILE_SYSTEM_ACTIVE_THRESHOLD = 0.52;
const LONG_OVERLAP_MIC_CHARS = 220;
const GIANT_FLUSH_CHARS = 1200;
const GIANT_MIC_FLUSH_CHARS = 700;

export class TranscriptRouter {
  private recentSystem: CanonicalTranscriptSegment[] = [];
  private recentSystemFinals: CanonicalTranscriptSegment[] = [];
  private recentCanonicalFinals: CanonicalTranscriptSegment[] = [];
  private recentCanonical: CanonicalTranscriptSegment[] = [];
  private sequence = 0;

  route(raw: RawTranscriptSegment): TranscriptRouteResult {
    let text = raw.text.trim();
    if (!text) {
      return { suppressed: true, reason: 'empty_text' };
    }

    const now = raw.timestamp || Date.now();
    this.prune(now);

    if (raw.channel === 'system') {
      if (this.isLowValueSystemFragment(text, raw.confidence)) {
        return {
          suppressed: true,
          reason: 'low_value_system_fragment',
        };
      }

      if (this.isLateSystemFlushDuplicate(text, now)) {
        return {
          suppressed: true,
          reason: 'late_system_flush_duplicate',
        };
      }

      const segment = this.toSystemSegment({ ...raw, text, timestamp: now });
      this.remember(segment);
      return { segment };
    }

    let lateFlushTrimmed = false;
    const lateMicFlush = this.resolveLateMicFlushDuplicate(text, now);
    if (lateMicFlush?.suppressed) {
      return {
        suppressed: true,
        reason: lateMicFlush.reason || 'mic_late_flush_duplicate',
      };
    }
    if (lateMicFlush?.text && lateMicFlush.text !== text) {
      text = lateMicFlush.text;
      lateFlushTrimmed = true;
    }

    const originalMicText = text;
    const echo = this.findSystemEcho(text, now);
    const systemRecentlyActive = Boolean(raw.systemAudioActive) || this.wasSystemRecentlyActive(now);
    const overlapLocalCandidate = systemRecentlyActive
      ? this.extractOverlapLocalInterventionText(text)
      : null;
    const trimmedOverlapEcho = Boolean(
      overlapLocalCandidate &&
      overlapLocalCandidate.text.length > 0 &&
      overlapLocalCandidate.text.length < text.length,
    );
    if (trimmedOverlapEcho && overlapLocalCandidate) {
      text = overlapLocalCandidate.text;
    }

    const localIntent = this.scoreLocalUserIntervention(text);
    const isLikelyLocalIntervention =
      localIntent >= MIC_LOCAL_INTENT_THRESHOLD ||
      (lateFlushTrimmed && this.looksLikeLocalComplaint(text));
    const isLongOverlap = systemRecentlyActive && originalMicText.length >= LONG_OVERLAP_MIC_CHARS;
    const isStrongLocalIntervention = localIntent >= MIC_LOCAL_INTENT_WHILE_SYSTEM_ACTIVE_THRESHOLD ||
      this.hasStrongLocalInterventionPhrase(text);
    const micSpeakerFallback = this.shouldRouteMicAsSpeakerFallback(raw, text, localIntent, systemRecentlyActive);

    if (echo && !trimmedOverlapEcho && localIntent < MIC_LOCAL_INTENT_WHILE_SYSTEM_ACTIVE_THRESHOLD) {
      return {
        suppressed: true,
        reason: 'mic_echo_of_system_audio',
        matchedSpeaker: echo.segment.speaker,
        similarity: echo.similarity,
      };
    }

    if (isLongOverlap && (raw.micGateActive || text.length >= 600) && !this.isShortDirectLocalQuestion(text) && !isStrongLocalIntervention) {
      return {
        suppressed: true,
        reason: 'mic_long_overlap_rejected',
      };
    }

    if (micSpeakerFallback) {
      const segment = this.toMicSpeakerFallbackSegment({ ...raw, text, timestamp: now }, systemRecentlyActive);
      this.remember(segment);
      return { segment };
    }

    if (!isLikelyLocalIntervention && !this.isShortDirectLocalQuestion(text)) {
      return {
        suppressed: true,
        reason: 'mic_without_local_intent',
      };
    }

    if (systemRecentlyActive && localIntent < MIC_LOCAL_INTENT_WHILE_SYSTEM_ACTIVE_THRESHOLD) {
      return {
        suppressed: true,
        reason: 'mic_during_system_audio_without_local_intent',
      };
    }

    const flags: TranscriptQualityFlag[] = [];
    if (raw.confidence !== undefined && raw.confidence < 0.72) flags.push('low_confidence');
    if (systemRecentlyActive) flags.push('possible_overlap');
    if (raw.micGateActive) flags.push('mic_gate_held');
    if (isLikelyLocalIntervention) flags.push('mic_intervention');
    if (isLongOverlap) flags.push('echo_suspect');
    if (trimmedOverlapEcho) flags.push('echo_suppressed');
    if (lateFlushTrimmed) flags.push('late_flush_trimmed');
    if (raw.provider === 'local' && (raw.confidence ?? 1) < 0.82) flags.push('stt_low_quality');
    if (!systemRecentlyActive && isLikelyLocalIntervention) flags.push('trusted_me');

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
    this.recentSystemFinals = [];
    this.recentCanonicalFinals = [];
    this.recentCanonical = [];
    this.sequence = 0;
  }

  getRecentCanonicalSegments(): CanonicalTranscriptSegment[] {
    return [...this.recentCanonical];
  }

  private toSystemSegment(raw: RawTranscriptSegment): CanonicalTranscriptSegment {
    const flags: TranscriptQualityFlag[] = ['system_audio', 'speaker_stable', 'trusted_interlocutor'];
    const hasReliableDiarization =
      raw.diarized === true &&
      raw.speakerId !== undefined &&
      Number.isFinite(raw.speakerId);

    if (raw.confidence !== undefined && raw.confidence < 0.72) flags.push('low_confidence');
    if (raw.provider === 'local' && (raw.confidence ?? 1) < 0.82) flags.push('stt_low_quality');
    if (raw.text.length >= GIANT_FLUSH_CHARS) flags.push('late_flush_duplicate');

    let role: CanonicalTranscriptSegment['role'] = 'interlocutor';
    let speaker = 'interlocutor';
    if (hasReliableDiarization) {
      const diarizedSpeaker = this.resolveCanonicalSpeakerRole(raw);
      role = diarizedSpeaker;
      speaker = diarizedSpeaker;
      if (raw.confidence !== undefined && raw.confidence < 0.72) {
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

  private toMicSpeakerFallbackSegment(raw: RawTranscriptSegment, systemRecentlyActive: boolean): CanonicalTranscriptSegment {
    const flags: TranscriptQualityFlag[] = [
      'system_audio_unavailable',
      'mic_speaker_fallback',
      'trusted_interlocutor',
    ];
    if (raw.confidence !== undefined && raw.confidence < 0.72) flags.push('low_confidence');
    if (raw.provider === 'local' && (raw.confidence ?? 1) < 0.82) flags.push('stt_low_quality');
    if (systemRecentlyActive) flags.push('possible_overlap');
    if (raw.micGateActive) flags.push('mic_gate_held');

    return {
      id: this.nextId('mic_speaker_fallback', raw.timestamp),
      role: 'interlocutor',
      source: 'merged',
      speaker: 'interlocutor',
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

  private resolveCanonicalSpeakerRole(raw: RawTranscriptSegment): CanonicalSpeakerRole {
    const speakerId = Math.max(0, Math.floor(Number(raw.speakerId)));
    const provider = String(raw.provider || '').toLowerCase();

    // Deepgram word diarization is zero-based in live results: 0 -> Speaker 1.
    // FluidAudio/Parakeet currently reports one-based dominant IDs in the local
    // helper, but keep a defensive 0 -> 1 mapping for older cached models.
    const oneBasedSpeakerId = provider === 'local' || provider === 'parakeet'
      ? Math.max(1, speakerId)
      : speakerId + 1;

    return `speaker_${oneBasedSpeakerId}` as CanonicalSpeakerRole;
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

      if (segment.final) {
        this.recentSystemFinals.push(segment);
        if (this.recentSystemFinals.length > MAX_LONG_SYSTEM_FINALS) {
          this.recentSystemFinals = this.recentSystemFinals.slice(-MAX_LONG_SYSTEM_FINALS);
        }
      }
    }

    if (segment.final && segment.role !== 'assistant') {
      this.recentCanonicalFinals.push(segment);
      if (this.recentCanonicalFinals.length > MAX_LONG_CANONICAL_FINALS) {
        this.recentCanonicalFinals = this.recentCanonicalFinals.slice(-MAX_LONG_CANONICAL_FINALS);
      }
    }
  }

  private prune(now: number): void {
    const cutoff = now - ECHO_WINDOW_MS;
    const longCutoff = now - LONG_SYSTEM_MEMORY_MS;
    this.recentSystem = this.recentSystem.filter((segment) => segment.timestamp >= cutoff);
    this.recentCanonical = this.recentCanonical.filter((segment) => segment.timestamp >= cutoff);
    this.recentSystemFinals = this.recentSystemFinals.filter((segment) => segment.timestamp >= longCutoff);
    this.recentCanonicalFinals = this.recentCanonicalFinals.filter((segment) => segment.timestamp >= longCutoff);
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

  private isLateSystemFlushDuplicate(text: string, timestamp: number): boolean {
    if (text.length < GIANT_FLUSH_CHARS || this.recentSystemFinals.length < 4) return false;

    const normalized = this.normalize(text);
    if (!normalized) return false;

    let matchedFinals = 0;
    for (const segment of this.recentSystemFinals) {
      if (timestamp - segment.timestamp > LONG_SYSTEM_MEMORY_MS) continue;
      const candidate = this.normalize(segment.text);
      if (candidate.length < 35) continue;
      if (normalized.includes(candidate) || this.textSimilarity(normalized, candidate) >= 0.5) {
        matchedFinals += 1;
      }
      if (matchedFinals >= 3) return true;
    }

    return false;
  }

  private resolveLateMicFlushDuplicate(text: string, timestamp: number): { text?: string; suppressed?: boolean; reason?: string } | null {
    if (text.length < GIANT_MIC_FLUSH_CHARS || this.recentCanonicalFinals.length < 3) return null;

    const units = this.splitIntoSpeechUnits(text);
    if (units.length < 3) return null;

    const matchedSegmentIds = new Set<string>();
    let lastDuplicateUnitIndex = -1;

    units.forEach((unit, index) => {
      const normalizedUnit = this.normalize(unit);
      if (normalizedUnit.length < 24) return;

      for (const prior of this.recentCanonicalFinals) {
        if (prior.timestamp >= timestamp) continue;
        if (timestamp - prior.timestamp > LONG_SYSTEM_MEMORY_MS) continue;

        const normalizedPrior = this.normalize(prior.text);
        if (normalizedPrior.length < 24) continue;
        if (!this.hasMeaningfulContainment(normalizedUnit, normalizedPrior)) continue;

        matchedSegmentIds.add(prior.id);
        lastDuplicateUnitIndex = Math.max(lastDuplicateUnitIndex, index);
      }
    });

    if (matchedSegmentIds.size < 3) return null;

    const novelTail = this.cleanSpeechUnit(units.slice(lastDuplicateUnitIndex + 1).join(' '));
    if (
      novelTail.length >= 24 &&
      (this.scoreLocalUserIntervention(novelTail) >= 0.25 ||
        this.looksLikeLocalComplaint(novelTail) ||
        this.isShortDirectLocalQuestion(novelTail))
    ) {
      return { text: novelTail };
    }

    return { suppressed: true, reason: 'mic_late_flush_duplicate' };
  }

  private hasMeaningfulContainment(left: string, right: string): boolean {
    if (!left || !right) return false;
    if (left.includes(right) || right.includes(left)) return true;

    const leftWords = new Set(left.split(' ').filter((word) => word.length >= 3));
    const rightWords = new Set(right.split(' ').filter((word) => word.length >= 3));
    if (leftWords.size < 4 || rightWords.size < 4) return false;

    let rightInLeft = 0;
    for (const word of rightWords) {
      if (leftWords.has(word)) rightInLeft++;
    }

    let leftInRight = 0;
    for (const word of leftWords) {
      if (rightWords.has(word)) leftInRight++;
    }

    return rightInLeft / rightWords.size >= 0.68 || leftInRight / leftWords.size >= 0.76;
  }

  private looksLikeLocalComplaint(text: string): boolean {
    const normalized = this.normalize(text);
    return /\b(n importe quoi|je ne comprends|je n ai pas compris|duplique|dupliquent|perdu|perdues|pas bien|decourageant|décourageant|ca ne marche|ça ne marche|rien ne marche|tu pourrais|faire mieux)\b/i.test(normalized);
  }

  private shouldRouteMicAsSpeakerFallback(
    raw: RawTranscriptSegment,
    text: string,
    localIntent: number,
    systemRecentlyActive: boolean,
  ): boolean {
    if (!this.isSystemAudioUnavailable(raw, systemRecentlyActive)) return false;
    if (this.hasStrongLocalInterventionPhrase(text) || this.looksLikeLocalComplaint(text)) return false;
    if (this.looksLikeAssistantCommand(text) || this.looksLikeQuotedAnswerRequest(text)) return false;
    if (localIntent >= 0.78) return false;

    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 5) return false;

    const hasRemoteAddress =
      /\b(tu|vous|ton|ta|tes|votre|vos|toi)\b/i.test(normalized) &&
      !/\b(peux tu|tu peux|pouvez vous|vous pouvez|explique moi|expliquez moi|dis moi|dites moi)\b/i.test(normalized);
    const hasMeetingExplanation =
      words.length >= 10 &&
      /\b(quand|normalement|actuellement|tu vois|vous voyez|donc|possible|possibilite|possibilité|informations|application|wachap|disque|memoire|mémoire)\b/i.test(normalized);
    const hasSpeakerStyleQuestion =
      /^(pourquoi|comment|quand|est ce que|est ce qu|quel|quelle|quels|quelles)\b/i.test(normalized) &&
      /\b(tu|vous|ton|ta|tes|votre|vos)\b/i.test(normalized) &&
      !this.hasLocalUserQuestionAnchor(normalized);

    return hasSpeakerStyleQuestion || hasRemoteAddress || hasMeetingExplanation;
  }

  private isSystemAudioUnavailable(raw: RawTranscriptSegment, systemRecentlyActive: boolean): boolean {
    if (systemRecentlyActive) return false;
    if (raw.systemAudioSilent) return true;
    const level = raw.systemAudioLevel;
    return Boolean(level && level.rms <= 1 && level.peak <= 1);
  }

  private looksLikeAssistantCommand(text: string): boolean {
    const normalized = this.normalize(text);
    return /\b(peux tu|tu peux|pouvez vous|vous pouvez|explique moi|expliquez moi|dis moi|dites moi|aide moi|aidez moi|réponds|reponds|que dois je dire|qu est ce que je dois dire|what should i say|tell me|explain to me)\b/i.test(normalized);
  }

  private looksLikeQuotedAnswerRequest(text: string): boolean {
    return this.hasLocalUserQuestionAnchor(this.normalize(text));
  }

  private hasLocalUserQuestionAnchor(normalized: string): boolean {
    return /\b(c est quoi répondre|c est quoi repondre|quoi répondre|quoi repondre|je veux savoir|je voudrais savoir|j aimerais savoir|je voulais demander|ma question|ce que je demandais|pour mieux comprendre|si je comprends|si j ai bien compris|je veux comprendre)\b/i.test(normalized);
  }

  private isLowValueSystemFragment(text: string, confidence?: number): boolean {
    if (confidence === undefined || confidence >= 0.65) return false;

    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 6) return false;

    if (/^(um|uh|hum|hmm|euh|heu|okay|ok|entering|thank you|thanks|what can be)$/i.test(normalized)) {
      return true;
    }

    const hasFrenchSignal = /\b(je|j|tu|vous|nous|on|oui|non|bon|donc|dans|pour|avec|est|cest|c|les|des|une|un|du|la|le|ce|ca|ça|fonctionnalite|fonctionnalité|publicite|publicité|role|rôle|compte|client|partenaire|marchand)\b/i.test(normalized);
    const hasFrenchCharacters = /[àâçéèêëîïôùûüÿœ]/i.test(text);
    const hasQuestion = /\?$/.test(text.trim());

    return !hasFrenchSignal && !hasFrenchCharacters && !hasQuestion;
  }

  private scoreLocalUserIntervention(text: string): number {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 3) return 0;

    const hasQuestionSignal = this.isShortDirectLocalQuestion(text) ||
      /\b(dis moi|dites moi|explique moi|expliquez moi|j aimerais savoir|je voudrais savoir|je voulais savoir|je veux savoir|je voulais demander|j ai une question|ma question)\b/i.test(normalized);

    const hasLearnerSignal = /\b(si je comprends|je comprends|si j ai bien compris|j ai bien compris|j ai compris|j avais compris|avoir compris|la maniere dont moi|je veux etre certain|je veux être certain|je ne comprends|je n ai pas compris|je veux comprendre|je voulais demander|je voulais savoir|je veux savoir|j aimerais savoir|ma question|j ai une question|ca veut dire|ça veut dire|donc si|pour mieux comprendre|que dire)\b/i.test(normalized);

    const hasPromptingSignal = /\b(explique|expliquez|precise|précise|clarifie|clarifiez|reprends|reprenez|dis nous|dites nous|dis moi|dites moi|peux tu|pouvez vous|tu peux|vous pouvez|tell me|explain|clarify)\b/i.test(normalized);

    const hasTurnSignal = /\b(ok|okay|d accord|daccord|attends|attendez|pardon|excuse moi|excusez moi|je te suis|je vous suis)\b/i.test(normalized) &&
      words.length >= 5;

    const hasFirstPersonSignal = /\b(je|j ai|j aimerais|je veux|je voudrais|moi|mon|ma|mes|nous|on peut|i|me|my|we)\b/i.test(normalized);
    const hasDirectAddressSignal = /\b(tu|vous|toi|votre|vos|could you|can you|pouvez vous|peux tu)\b/i.test(normalized);

    let score = 0;
    if (hasQuestionSignal) score += 0.3;
    if (hasLearnerSignal) score += 0.35;
    if (hasPromptingSignal) score += 0.25;
    if (hasTurnSignal) score += 0.22;
    if (hasFirstPersonSignal) score += 0.15;
    if (hasDirectAddressSignal) score += 0.12;
    if (words.length >= 7 && (hasQuestionSignal || hasLearnerSignal || hasPromptingSignal)) score += 0.08;

    return Math.min(1, score);
  }

  private hasStrongLocalInterventionPhrase(text: string): boolean {
    const normalized = this.normalize(text);
    return /\b(si je comprends|si j ai bien compris|j avais compris|j ai compris|je voulais demander|je voulais savoir|ce que je demandais|ma question|la maniere dont moi|pour mieux comprendre)\b/i.test(normalized);
  }

  private extractOverlapLocalInterventionText(text: string): { text: string; start: number } | null {
    const markers = [
      /((?:ok|okay|bon|oui|d'accord|d accord|alors)[\s,.;:-]*(?:donc[\s,.;:-]*)?si\s+je\s+comprends\b)/i,
      /((?:ok|okay|bon|oui|d'accord|d accord|alors)[\s,.;:-]*(?:bon[\s,.;:-]*)?(?:étant\s+donné|etant\s+donne)\b)/i,
      /((?:oui[\s,.;:-]*){1,3}je\s+comprends\b)/i,
      /((?:je\s+comprends|je\s+voulais\s+demander|ce\s+que\s+je\s+demandais|ma\s+question|je\s+voulais\s+savoir|j'aimerais\s+savoir|je\s+voudrais\s+savoir|désolé|desole|je\s+vous\s+ai\s+perdu|j'avais\s+eu\s+un\s+problème|j\s+avais\s+eu\s+un\s+probleme|pour\s+mieux\s+comprendre|moi\s+j(?:'|e)?\s*(?:aurais|avais)|on\s+n['’]?\s+a\s+pas\s+forcément\s+besoin|on\s+n\s+a\s+pas\s+forcement\s+besoin)\b)/i,
    ];

    let best: { start: number; text: string } | null = null;
    for (const marker of markers) {
      const match = marker.exec(text);
      if (!match) continue;
      const matchedText = match[1] || match[0];
      const matchOffset = match[0].indexOf(matchedText);
      const start = match.index + Math.max(0, matchOffset);
      if (start < 18) continue;
      const candidate = text.slice(start).trim();
      if (!candidate || candidate.length < 12) continue;
      if (!best || start < best.start) {
        best = { start, text: candidate };
      }
    }

    return best;
  }

  private splitIntoSpeechUnits(text: string): string[] {
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return [];

    return (clean.match(/[^.!?。！？]+[.!?。！？]?/g) || [clean])
      .map((unit) => this.cleanSpeechUnit(unit))
      .filter(Boolean);
  }

  private cleanSpeechUnit(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^[,;:\-\s]+/, '')
      .trim();
  }

  private isShortDirectLocalQuestion(text: string): boolean {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 70) return false;

    if (/\?$/.test(text.trim())) return true;

    const early = words.slice(0, 18).join(' ');
    const turnPrefix = '(?:oui|ok|okay|d accord|daccord|alors|attends|attendez|pardon|excuse moi|excusez moi)\\s+';
    const intentPrefix = '(?:ce que je demandais|ma question|je voulais demander|je voulais savoir|j aimerais savoir|je voudrais savoir|i wanted to ask|my question)\\s+';
    const questionStart = '(?:est ce que|est ce qu|pourquoi|comment|quand|quel|quelle|quels|quelles|combien|ou est|what|why|how|when|where|who|which|can you|could you|do you|does it)';

    if (new RegExp(`^(?:${turnPrefix})*(?:${intentPrefix})?${questionStart}\\b`, 'i').test(early)) {
      return true;
    }

    return new RegExp(`${intentPrefix}.*\\b${questionStart}\\b`, 'i').test(early);
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
