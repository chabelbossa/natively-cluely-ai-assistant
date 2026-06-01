import { MeetingBriefManager } from './MeetingBriefManager';
import type { MeetingAction } from './MeetingActionOrchestrator';
import type { ContextItem, SessionTracker } from '../SessionTracker';
import type { TranscriptQualityFlag } from '../transcript/types';

export interface MeetingContextPacket {
  action: MeetingAction;
  builtAt: number;
  languageHint: 'fr' | 'en' | 'mixed' | 'unknown';
  hasReliableInterlocutor: boolean;
  contextTrustScore: number;
  interlocutorFocus: InterlocutorFocus;
  localUserFocus: InterlocutorFocus;
  actionTarget: MeetingActionTarget;
  context: string;
  systemPrompt: string;
  diagnostics: string[];
  selectedSegments: Array<{
    role: string;
    speaker?: string;
    text: string;
    timestamp: number;
    canonicalRole?: string;
    qualityFlags?: string[];
  }>;
  rejectedSegments: Array<{
    role: string;
    speaker?: string;
    text: string;
    reason: string;
  }>;
}

export interface InterlocutorFocus {
  kind: 'direct_question' | 'implicit_request' | 'topic' | 'none';
  text: string;
  confidence: number;
  timestamp?: number;
  reason: string;
}

export interface MeetingActionTarget extends InterlocutorFocus {
  source: 'interlocutor' | 'local_user' | 'none';
}

interface BuildPacketInput {
  action: MeetingAction;
  lastSeconds: number;
  transcriptContext?: string;
  activeModeBlock?: string;
  liveStateBlock?: string;
  fallback?: string;
  additionalItems?: ContextItem[];
}

const MAX_PACKET_CONTEXT = 24_000;
const REPAIR_FRAGMENT_GAP_MS = 12_000;
const REPAIR_ROLE_DRIFT_GAP_MS = 10_000;

interface TranscriptRepairResult {
  items: ContextItem[];
  notes: string[];
  changed: boolean;
}

export class MeetingContextPacketBuilder {
  constructor(
    private readonly session: SessionTracker,
    private readonly getLiveStateBlock?: () => string,
  ) {}

  build(input: BuildPacketInput): MeetingContextPacket {
    const liveInterimItems = this.getLiveInterimItems();
    const mergedAdditionalItems = [
      ...(input.additionalItems || []),
      ...liveInterimItems,
    ];
    const selectedItems = this.mergeAdditionalItems(
      this.session.getActionContext(input.lastSeconds),
      mergedAdditionalItems,
    );
    const repairResult = this.repairActionContext(selectedItems);
    const actionItems = repairResult.items;
    const briefBlock = MeetingBriefManager.getInstance().buildContextBlock();
    const selectedSegments = actionItems.map((item) => ({
      role: item.role,
      speaker: item.speaker,
      text: item.text,
      timestamp: item.timestamp,
      canonicalRole: item.canonicalRole,
      qualityFlags: item.qualityFlags,
    }));
    const reliableInterlocutorItems = actionItems.filter((item) => this.isReliableInterlocutorItem(item));
    const hasReliableInterlocutor = reliableInterlocutorItems.length > 0;
    const contextTrustScore = this.computeContextTrustScore(actionItems, reliableInterlocutorItems);
    const interlocutorFocus = this.deriveInterlocutorFocus(reliableInterlocutorItems);
    const localUserFocus = this.deriveLocalUserFocus(actionItems);
    const actionTarget = this.pickActionTarget(hasReliableInterlocutor, interlocutorFocus, localUserFocus);
    const supportingInterlocutorItems = this.pickSupportingInterlocutorItems(reliableInterlocutorItems, interlocutorFocus);
    const languageHint = this.detectLanguage([
      actionTarget.text,
      interlocutorFocus.text,
      localUserFocus.text,
      ...actionItems.map((item) => item.text),
    ].join(' '));
    const rejectedSegments = this.buildRejectedSegments(input.lastSeconds, actionItems);
    const systemPrompt = this.buildSystemPrompt(
      input.action,
      languageHint,
      hasReliableInterlocutor,
      contextTrustScore,
      interlocutorFocus,
      actionTarget,
    );

    const parts = [
      systemPrompt,
      briefBlock,
      input.activeModeBlock?.trim(),
      (input.liveStateBlock ?? this.safeLiveStateBlock()).trim(),
      this.buildTranscriptRepairBlock(repairResult),
      this.buildInterlocutorFocusBlock(interlocutorFocus),
      this.buildLocalUserFocusBlock(localUserFocus),
      this.buildActionTargetBlock(input.action, actionTarget, supportingInterlocutorItems),
      this.buildQualityBlock(hasReliableInterlocutor, languageHint, actionItems, rejectedSegments, interlocutorFocus, actionTarget),
      this.buildSelectedTranscriptBlock(actionItems),
      input.transcriptContext?.trim()
        ? `[ACTION-SPECIFIC TRANSCRIPT INPUT]\n${input.transcriptContext.trim()}\n[/ACTION-SPECIFIC TRANSCRIPT INPUT]`
        : '',
      input.fallback?.trim(),
    ].filter(Boolean);

    const context = this.compact(parts.join('\n\n'), MAX_PACKET_CONTEXT);
    const diagnostics = [
      ...this.session.getActionContextDiagnostics(input.lastSeconds),
      `packet_action=${input.action}`,
      `packet_language_hint=${languageHint}`,
      `packet_has_reliable_interlocutor=${hasReliableInterlocutor}`,
      `packet_context_trust_score=${contextTrustScore.toFixed(2)}`,
      `packet_focus_kind=${interlocutorFocus.kind}`,
      `packet_focus_confidence=${interlocutorFocus.confidence.toFixed(2)}`,
      `packet_focus_text=${this.truncate(interlocutorFocus.text, 220) || 'none'}`,
      `packet_local_user_focus_kind=${localUserFocus.kind}`,
      `packet_local_user_focus_text=${this.truncate(localUserFocus.text, 220) || 'none'}`,
      `packet_target_source=${actionTarget.source}`,
      `packet_target_kind=${actionTarget.kind}`,
      `packet_target_confidence=${actionTarget.confidence.toFixed(2)}`,
      `packet_target_text=${this.truncate(actionTarget.text, 220) || 'none'}`,
      `packet_supporting_interlocutor_segments=${supportingInterlocutorItems.length}`,
      `packet_selected_segments=${selectedSegments.length}`,
      `packet_rejected_segments=${rejectedSegments.length}`,
      `packet_transcript_repair_changed=${repairResult.changed}`,
      `packet_transcript_repair_notes=${repairResult.notes.length}`,
      `packet_additional_items=${input.additionalItems?.length || 0}`,
      `packet_live_interim_items=${liveInterimItems.length}`,
    ];

    return {
      action: input.action,
      builtAt: Date.now(),
      languageHint,
      hasReliableInterlocutor,
      contextTrustScore,
      interlocutorFocus,
      localUserFocus,
      actionTarget,
      context,
      systemPrompt,
      diagnostics,
      selectedSegments,
      rejectedSegments,
    };
  }

  private safeLiveStateBlock(): string {
    try {
      return this.getLiveStateBlock?.() || '';
    } catch (error: any) {
      console.warn('[MeetingContextPacketBuilder] Failed to load live state:', error?.message || error);
      return '';
    }
  }

  private buildSystemPrompt(
    action: MeetingAction,
    languageHint: MeetingContextPacket['languageHint'],
    hasReliableInterlocutor: boolean,
    contextTrustScore: number,
    focus: InterlocutorFocus,
    actionTarget: MeetingActionTarget,
  ): string {
    const actionRule = (() => {
      if (actionTarget.source === 'local_user') {
        switch (action) {
          case 'WHAT_TO_SAY':
          case 'VIBE_INTERVIEW_SAY_THIS':
          case 'ANSWER':
            return 'Answer the LOCAL USER QUESTION directly as an assistant. Do not pretend it came from the other participant.';
          case 'CLARIFY':
            return 'Ask exactly one precise clarifying question about the LOCAL USER QUESTION.';
          case 'FOLLOW_UP_QUESTION':
            return 'Suggest exactly one useful follow-up question the local user can ask next about their own topic.';
          case 'RECAP':
          default:
            return 'Summarize what is reliably available, clearly separating local mic content from missing speaker content.';
        }
      }
      switch (action) {
        case 'WHAT_TO_SAY':
        case 'VIBE_INTERVIEW_SAY_THIS':
          return 'Output exactly one short phrase the user can say aloud now. If CURRENT INTERLOCUTOR FOCUS is a direct_question, answer that exact question. If it is an implicit_request, acknowledge it and propose the next concrete step. No preamble.';
        case 'CLARIFY':
          return 'Output exactly one precise clarifying question about the CURRENT INTERLOCUTOR FOCUS. It must clarify a concrete ambiguity, not ask a generic context question.';
        case 'FOLLOW_UP_QUESTION':
          return 'Output exactly one useful follow-up question that extends the CURRENT INTERLOCUTOR FOCUS and has not already been answered.';
        case 'RECAP':
          return 'Summarize decisions, risks, open questions, owners, constraints, and next steps.';
        case 'ANSWER':
        default:
          return 'Answer the user request from reliable interlocutor context first, then meeting background.';
      }
    })();

    const languageRule = languageHint === 'fr' || languageHint === 'mixed'
      ? 'Respond in French. If the transcript mixes French and English, still answer in French unless the user explicitly requests English.'
      : 'Use the dominant meeting language.';

    return `[PREMIUM MEETING CONTEXT PACKET]
Action: ${action}
Reliable interlocutor context available: ${hasReliableInterlocutor ? 'YES' : 'NO'}
Context trust score: ${contextTrustScore.toFixed(2)}
Current interlocutor focus: ${focus.kind} (${focus.confidence.toFixed(2)}) ${focus.text ? `- ${focus.text}` : ''}
Action target source: ${actionTarget.source}
Action target: ${actionTarget.kind} (${actionTarget.confidence.toFixed(2)}) ${actionTarget.text ? `- ${actionTarget.text}` : ''}
- ${actionRule}
- ${languageRule}
- The ACTION TARGET is the target for this action. Do not answer a random older topic if a target is present.
- If focus=direct_question, answer the interlocutor's latest question directly, in first person when appropriate.
- If focus=implicit_request, respond with confirmation plus the next practical step.
- If focus=topic, produce a useful bridge or question about that topic, not a broad generic fallback.
- INTERLOCUTOR/SPEAKER is the other person, professor, client, manager, or system audio.
- ME/Mic is the local user. Use ME only to understand the user request, never as proof of what the other person said.
- If Action target source=local_user, answer the local user's mic question directly and explicitly avoid relabeling it as Speaker.
- Meeting brief is background only; never claim it was said in the meeting unless it appears in transcript.
- Before answering, first use the repaired transcript and reconstructed sentence boundaries. Do not answer from raw cut fragments when a repaired version is available.
- If ASR visibly split a sentence, infer only missing connective grammar from nearby words; never invent new facts that are absent from the repaired transcript.
- If reliable interlocutor context is missing, say that briefly and do not invent facts.
- If reliable context exists but is noisy, use the strongest concrete interlocutor facts and ask/answer around the next practical step.
- Never output a generic "not enough context" fallback when the selected transcript contains concrete interlocutor facts.
- Keep live answers concise, natural, and directly usable.
[/PREMIUM MEETING CONTEXT PACKET]`;
  }

  private buildQualityBlock(
    hasReliableInterlocutor: boolean,
    languageHint: MeetingContextPacket['languageHint'],
    selectedItems: ContextItem[],
    rejectedSegments: MeetingContextPacket['rejectedSegments'],
    focus: InterlocutorFocus,
    actionTarget: MeetingActionTarget,
  ): string {
    const counts = selectedItems.reduce((acc, item) => {
      const key = item.role === 'interviewer' ? 'interlocutor' : item.role;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return `[CONTEXT QUALITY]
hasReliableInterlocutor=${hasReliableInterlocutor}
languageHint=${languageHint}
contextTrustScore=${this.computeContextTrustScore(selectedItems, selectedItems.filter((item) => this.isReliableInterlocutorItem(item))).toFixed(2)}
focusKind=${focus.kind}
focusConfidence=${focus.confidence.toFixed(2)}
actionTargetSource=${actionTarget.source}
actionTargetKind=${actionTarget.kind}
actionTargetConfidence=${actionTarget.confidence.toFixed(2)}
selectedCounts=${JSON.stringify(counts)}
rejectedRecentSegments=${rejectedSegments.length}
[/CONTEXT QUALITY]`;
  }

  private buildTranscriptRepairBlock(result: TranscriptRepairResult): string {
    const lines = [
      '[TRANSCRIPT REPAIR]',
      `status=${result.changed ? 'active' : 'clean'}`,
      'policy=Use the repaired transcript as the action source of truth. Raw STT cuts, dangling fragments, and repaired mic/system drift are diagnostic only.',
      'instruction=Silently reconstruct sentence boundaries before answering; fill only obvious connective gaps from adjacent words, not missing facts.',
      ...result.notes.slice(-8).map((note, index) => `repair_${index + 1}=${note}`),
      '[/TRANSCRIPT REPAIR]',
    ];
    return lines.join('\n');
  }

  private repairActionContext(items: ContextItem[]): TranscriptRepairResult {
    const notes: string[] = [];
    const repaired: ContextItem[] = [];
    const sorted = items
      .map((item) => this.normalizeRepairItem(item))
      .filter((item): item is ContextItem => Boolean(item))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const item of sorted) {
      const last = repaired[repaired.length - 1];
      if (last && this.shouldRepairRoleDriftIntoPrevious(last, item)) {
        repaired[repaired.length - 1] = this.mergeRepairItems(last, item, ['repaired_context', 'role_repaired', 'stitched_fragment']);
        notes.push(`role_repaired:${this.truncate(item.text, 120)} -> ${this.formatLabel(last)}`);
        continue;
      }

      if (last && this.shouldStitchRepairItems(last, item)) {
        repaired[repaired.length - 1] = this.mergeRepairItems(last, item, ['repaired_context', 'stitched_fragment']);
        notes.push(`stitched_fragment:${this.truncate(last.text, 70)} + ${this.truncate(item.text, 70)}`);
        continue;
      }

      if (this.isUnstableOrphanFragment(item, last)) {
        repaired.push(this.withRepairFlags(item, ['unstable_fragment']));
        notes.push(`unstable_fragment:${this.truncate(item.text, 140)}`);
        continue;
      }

      repaired.push(item);
    }

    return {
      items: repaired,
      notes,
      changed: notes.length > 0,
    };
  }

  private normalizeRepairItem(item: ContextItem): ContextItem | null {
    const text = this.cleanSpeechUnit(item.text);
    if (!text) return null;
    return { ...item, text };
  }

  private shouldRepairRoleDriftIntoPrevious(previous: ContextItem, current: ContextItem): boolean {
    if (previous.role !== 'interviewer' || current.role !== 'user') return false;
    if (this.timeGap(previous, current) > REPAIR_ROLE_DRIFT_GAP_MS) return false;
    if (this.looksLikeDirectLocalQuestion(current.text) || this.hasStrongLocalUserAnchor(current.text)) return false;

    const flags = new Set(current.qualityFlags || []);
    const hasOverlapEvidence =
      flags.has('possible_overlap') ||
      flags.has('echo_suspect') ||
      flags.has('mic_gate_held') ||
      flags.has('stt_low_quality') ||
      flags.has('late_flush_trimmed') ||
      current.confidence !== undefined && current.confidence < 0.78;

    if (!hasOverlapEvidence && !this.startsLikeContinuation(current.text)) return false;
    return this.isIncompleteSpeechBoundary(previous.text) ||
      this.startsLikeContinuation(current.text) ||
      this.normalize(current.text).split(' ').filter(Boolean).length <= 8;
  }

  private shouldStitchRepairItems(previous: ContextItem, current: ContextItem): boolean {
    if (this.timeGap(previous, current) > REPAIR_FRAGMENT_GAP_MS) return false;
    if (previous.role === 'assistant' || current.role === 'assistant') return false;
    if (this.looksLikeInterlocutorQuestion(current.text) || this.looksLikeDirectLocalQuestion(current.text)) return false;

    const sameRole = previous.role === current.role;
    const sameSpeaker = this.sameSpeakerIdentity(previous, current);
    const bothInterlocutors = previous.role === 'interviewer' && current.role === 'interviewer';
    const continuation = this.startsLikeContinuation(current.text) || this.isIncompleteSpeechBoundary(previous.text);
    const shortCurrent = this.normalize(current.text).split(' ').filter(Boolean).length <= 10;

    if (sameRole && sameSpeaker && (continuation || shortCurrent)) return true;
    if (bothInterlocutors && continuation && shortCurrent) return true;
    return false;
  }

  private isUnstableOrphanFragment(item: ContextItem, previous?: ContextItem): boolean {
    const words = this.normalize(item.text).split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 7) return false;
    if (this.looksLikeInterlocutorQuestion(item.text) || this.looksLikeDirectLocalQuestion(item.text)) return false;
    if (!this.looksLikeDanglingFragment(item.text) && !this.startsLikeContinuation(item.text)) return false;
    if (previous && this.timeGap(previous, item) <= REPAIR_FRAGMENT_GAP_MS) return false;
    return true;
  }

  private mergeRepairItems(previous: ContextItem, current: ContextItem, flags: TranscriptQualityFlag[]): ContextItem {
    return {
      ...previous,
      text: this.cleanSpeechUnit(`${previous.text} ${current.text}`),
      timestamp: current.timestamp,
      confidence: this.mergeConfidence(previous.confidence, current.confidence),
      qualityFlags: this.mergeQualityFlags(previous.qualityFlags, current.qualityFlags, flags),
    };
  }

  private withRepairFlags(item: ContextItem, flags: TranscriptQualityFlag[]): ContextItem {
    return {
      ...item,
      qualityFlags: this.mergeQualityFlags(item.qualityFlags, undefined, flags),
    };
  }

  private mergeQualityFlags(
    left?: TranscriptQualityFlag[],
    right?: TranscriptQualityFlag[],
    extra: TranscriptQualityFlag[] = [],
  ): TranscriptQualityFlag[] {
    return [...new Set([...(left || []), ...(right || []), ...extra])];
  }

  private mergeConfidence(left?: number, right?: number): number | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.min(left, right);
  }

  private timeGap(previous: ContextItem, current: ContextItem): number {
    return Math.abs((current.timestamp || 0) - (previous.timestamp || 0));
  }

  private sameSpeakerIdentity(left: ContextItem, right: ContextItem): boolean {
    const leftId = this.normalizeSpeakerIdentity(left);
    const rightId = this.normalizeSpeakerIdentity(right);
    return Boolean(leftId && rightId && leftId === rightId);
  }

  private normalizeSpeakerIdentity(item: ContextItem): string {
    return String(item.canonicalRole || item.speaker || item.role || '')
      .toLowerCase()
      .replace(/[^a-z0-9_:-]/g, '');
  }

  private isIncompleteSpeechBoundary(text: string): boolean {
    const clean = this.cleanSpeechUnit(text);
    if (!clean) return false;
    if (/[.!?。！？]\s*$/.test(clean)) return false;
    const words = this.normalize(clean).split(' ').filter(Boolean);
    const last = words[words.length - 1] || '';
    return words.length <= 18 ||
      /^(le|la|les|un|une|des|du|de|d|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|leurs|pour|avec|dans|sur|sans|a|à|au|aux|qui|que|dont|où|ou|et|mais|donc|parce|comme|si|to|of|for|with|in|on|and|or|but|because|so|the|a|an)$/.test(last);
  }

  private startsLikeContinuation(text: string): boolean {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    const first = words[0] || '';
    if (!first) return false;
    if (/^(et|mais|donc|alors|de|du|des|d|l|le|la|les|un|une|sans|avec|pour|dans|sur|qui|que|dont|où|ou|a|à|au|aux|to|of|for|with|in|on|and|or|but|because|so|the|a|an|it|this|that)$/.test(first)) {
      return true;
    }
    return /^(ce|cette|ces|ça|ca|cela|il|elle|ils|elles|on|nous|vous|je|j|tu)\b/.test(normalized) &&
      words.length <= 8;
  }

  private hasStrongLocalUserAnchor(text: string): boolean {
    const normalized = this.normalize(text);
    return /\b(si je comprends|j ai bien compris|je veux comprendre|je voulais demander|je voudrais savoir|j aimerais savoir|ce que je demandais|ma question|pour mieux comprendre|je veux etre certain|je veux être certain|je ne comprends|je n ai pas compris|n importe quoi|rien ne marche)\b/i.test(normalized);
  }

  private looksLikeDirectLocalQuestion(text: string): boolean {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 90) return false;
    if (/[?？]\s*$/.test(text.trim())) return true;
    return /\b(est ce que|pourquoi|comment|quand|quel|quelle|quels|quelles|combien|où|ou est|pouvez vous|peux tu|tu peux|vous pouvez|can you|could you|what|why|how|when|where|which)\b/i.test(normalized);
  }

  private buildInterlocutorFocusBlock(focus: InterlocutorFocus): string {
    if (focus.kind === 'none' || !focus.text.trim()) {
      return `[CURRENT INTERLOCUTOR FOCUS]
kind=none
confidence=0.00
text=
instruction=No reliable interlocutor target is available. Do not invent what the other person asked.
[/CURRENT INTERLOCUTOR FOCUS]`;
    }

    const instruction = (() => {
      switch (focus.kind) {
        case 'direct_question':
          return 'Answer this exact question first. If the action is CLARIFY, ask one precision question about this question.';
        case 'implicit_request':
          return 'Treat this as the current request/expectation from the interlocutor. Confirm and propose the next practical step.';
        case 'topic':
        default:
          return 'Treat this as the current concrete topic. Stay on this topic and avoid generic meeting advice.';
      }
    })();

    return `[CURRENT INTERLOCUTOR FOCUS]
kind=${focus.kind}
confidence=${focus.confidence.toFixed(2)}
reason=${focus.reason}
text=${focus.text}
instruction=${instruction}
[/CURRENT INTERLOCUTOR FOCUS]`;
  }

  private buildLocalUserFocusBlock(focus: InterlocutorFocus): string {
    if (focus.kind === 'none' || !focus.text.trim()) {
      return `[LOCAL USER QUESTION]
kind=none
confidence=0.00
text=
instruction=No direct local mic question is available.
[/LOCAL USER QUESTION]`;
    }

    return `[LOCAL USER QUESTION]
kind=${focus.kind}
confidence=${focus.confidence.toFixed(2)}
reason=${focus.reason}
text=${focus.text}
instruction=This came from ME/LOCAL MIC. It is allowed as a direct user request, but it must never be used as proof of what the other participant said.
[/LOCAL USER QUESTION]`;
  }

  private buildActionTargetBlock(action: MeetingAction, focus: MeetingActionTarget, supportingItems: ContextItem[]): string {
    const actionContract = (() => {
      switch (action) {
        case 'WHAT_TO_SAY':
        case 'VIBE_INTERVIEW_SAY_THIS':
        case 'ANSWER':
          return 'Say the answer the local user should give now. If target_kind=direct_question, answer it directly instead of asking another question.';
        case 'CLARIFY':
          return 'Ask one precise clarifying question about the target. Do not answer the target question.';
        case 'FOLLOW_UP_QUESTION':
          return 'Ask one follow-up question that advances the target topic. Do not output a list.';
        case 'RECAP':
        default:
          return 'Use the target plus supporting context as the current meeting center.';
      }
    })();

    const supportingLines = supportingItems
      .slice(-6)
      .map((item, index) => `support_${index + 1}=${this.truncate(item.text, 360)}`);
    const isComprehensionCheck = this.isComprehensionCheckQuestion(focus.text);
    const comprehensionInstruction = isComprehensionCheck
      ? 'target_is_comprehension_check=true\ninstruction=Summarize what the interlocutor just explained, using support_* facts. Do not say there is not enough context when support_* facts exist.'
      : '';

    return [
      '[ACTION TARGET]',
      `action=${action}`,
      `target_source=${focus.source}`,
      `target_kind=${focus.kind}`,
      `target_confidence=${focus.confidence.toFixed(2)}`,
      `target_text=${focus.text || ''}`,
      `contract=${actionContract}`,
      comprehensionInstruction,
      supportingLines.length > 0 ? '[TARGET SUPPORTING INTERLOCUTOR CONTEXT]' : '',
      ...supportingLines,
      supportingLines.length > 0 ? '[/TARGET SUPPORTING INTERLOCUTOR CONTEXT]' : '',
      '[/ACTION TARGET]',
    ].filter(Boolean).join('\n');
  }

  private buildSelectedTranscriptBlock(items: ContextItem[]): string {
    if (items.length === 0) return '';
    return [
      '[SELECTED CANONICAL TRANSCRIPT]',
      ...items.map((item) => `${this.formatLabel(item)}: ${item.text}`),
      '[/SELECTED CANONICAL TRANSCRIPT]',
    ].join('\n');
  }

  private formatLabel(item: ContextItem): string {
    if (item.role === 'assistant') return '[ASSISTANT_PREVIOUS]';
    if (item.role === 'user') return '[ME_LOCAL_MIC]';
    if (item.canonicalRole === 'uncertain') return '[INTERLOCUTOR_UNCERTAIN]';
    const speakerLabel = this.resolveInterlocutorSpeakerLabel(item.canonicalRole, item.speaker);
    if (speakerLabel) return `[INTERLOCUTOR_${speakerLabel}]`;
    return '[INTERLOCUTOR]';
  }

  private resolveInterlocutorSpeakerLabel(canonicalRole?: string, speaker?: string): string | null {
    const canonical = /^speaker_(\d+)$/i.exec(canonicalRole || '');
    if (canonical) return `SPEAKER_${Number(canonical[1])}`;

    const rawSpeaker = String(speaker || '');
    const speakerMatch = /^speaker[_-]?(\d+)$/i.exec(rawSpeaker);
    if (speakerMatch) return `SPEAKER_${Number(speakerMatch[1])}`;

    const locuteurMatch = /^locuteur[_-]?(\d+)$/i.exec(rawSpeaker);
    if (locuteurMatch) return `SPEAKER_${Number(locuteurMatch[1]) + 1}`;

    return null;
  }

  private buildRejectedSegments(lastSeconds: number, selectedItems: ContextItem[]): MeetingContextPacket['rejectedSegments'] {
    const cutoff = Date.now() - lastSeconds * 1000;
    const selectedKeys = new Set(selectedItems.map((item) => this.key(item.role, item.text, item.timestamp)));
    return this.session.getFullTranscript()
      .filter((segment) => segment.final && segment.timestamp >= cutoff)
      .map((segment) => {
        const role = this.mapRole(segment.canonicalRole, segment.speaker);
        return {
          role,
          speaker: segment.speaker,
          text: segment.text.trim(),
          timestamp: segment.timestamp,
          canonicalRole: segment.canonicalRole,
          qualityFlags: segment.qualityFlags,
        };
      })
      .filter((item) => item.text && !selectedKeys.has(this.key(item.role, item.text, item.timestamp)))
      .slice(-8)
      .map((item) => ({
        role: item.role,
        speaker: item.speaker,
        text: this.truncate(item.text, 240),
        reason: this.rejectedReason(item),
      }));
  }

  private mergeAdditionalItems(baseItems: ContextItem[], additionalItems: ContextItem[]): ContextItem[] {
    if (additionalItems.length === 0) return baseItems;

    const byKey = new Map<string, ContextItem>();
    for (const item of [...baseItems, ...additionalItems]) {
      const cleaned = this.cleanSpeechUnit(item.text);
      if (!cleaned) continue;
      const normalizedItem: ContextItem = {
        ...item,
        text: cleaned,
      };
      byKey.set(this.key(normalizedItem.role, normalizedItem.text, normalizedItem.timestamp), normalizedItem);
    }

    return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  private getLiveInterimItems(): ContextItem[] {
    const getLastInterim = (this.session as any).getLastInterimInterviewer;
    if (typeof getLastInterim !== 'function') return [];

    const interim = getLastInterim.call(this.session);
    const text = this.cleanSpeechUnit(interim?.text || '');
    if (!interim || interim.final || !text) return [];

    const canonicalRole = interim.canonicalRole ||
      (interim.source === 'system' ? 'interlocutor' : undefined);

    return [{
      role: 'interviewer',
      speaker: interim.speaker,
      text,
      timestamp: interim.timestamp || Date.now(),
      confidence: interim.confidence,
      source: 'live',
      canonicalRole,
      qualityFlags: interim.qualityFlags || [],
    }];
  }

  private deriveInterlocutorFocus(reliableItems: ContextItem[]): InterlocutorFocus {
    if (reliableItems.length === 0) {
      return {
        kind: 'none',
        text: '',
        confidence: 0,
        reason: 'no_reliable_interlocutor_segment',
      };
    }

    const recent = reliableItems.slice(-16);

    for (let i = recent.length - 1; i >= 0; i--) {
      const item = recent[i];
      const question = this.extractBestQuestion(item.text);
      if (question) {
        const enrichedQuestion = this.enrichQuestionWithNeighborContext(
          question,
          recent.slice(Math.max(0, i - 3), i),
        );
        return {
          kind: 'direct_question',
          text: this.truncate(enrichedQuestion, 420),
          confidence: /\?\s*$/.test(question) ? 0.92 : 0.82,
          timestamp: item.timestamp,
          reason: 'latest_interlocutor_question',
        };
      }
    }

    for (let i = recent.length - 1; i >= 0; i--) {
      const item = recent[i];
      const request = this.extractImplicitRequest(item.text);
      if (request) {
        return {
          kind: 'implicit_request',
          text: this.truncate(request, 420),
          confidence: 0.72,
          timestamp: item.timestamp,
          reason: 'latest_interlocutor_request_or_assignment',
        };
      }
    }

    const topic = this.extractTopic(recent);
    return {
      kind: topic ? 'topic' : 'none',
      text: topic,
      confidence: topic ? 0.56 : 0,
      timestamp: recent[recent.length - 1]?.timestamp,
      reason: topic ? 'latest_interlocutor_topic' : 'no_focus_candidate',
    };
  }

  private deriveLocalUserFocus(selectedItems: ContextItem[]): InterlocutorFocus {
    const localItems = selectedItems
      .filter((item) => item.role === 'user' && item.text.trim().length > 0)
      .slice(-12);

    for (let i = localItems.length - 1; i >= 0; i--) {
      const item = localItems[i];
      const question = this.extractBestQuestion(item.text);
      if (question) {
        return {
          kind: 'direct_question',
          text: this.truncate(question, 420),
          confidence: /[?？]\s*$/.test(question) ? 0.9 : 0.78,
          timestamp: item.timestamp,
          reason: 'latest_local_user_question',
        };
      }
    }

    const topic = this.extractTopic(localItems);
    return {
      kind: topic ? 'topic' : 'none',
      text: topic,
      confidence: topic ? 0.5 : 0,
      timestamp: localItems[localItems.length - 1]?.timestamp,
      reason: topic ? 'latest_local_user_topic' : 'no_local_user_focus_candidate',
    };
  }

  private pickActionTarget(
    hasReliableInterlocutor: boolean,
    interlocutorFocus: InterlocutorFocus,
    localUserFocus: InterlocutorFocus,
  ): MeetingActionTarget {
    if (hasReliableInterlocutor && interlocutorFocus.kind !== 'none') {
      return { ...interlocutorFocus, source: 'interlocutor' };
    }

    if (localUserFocus.kind !== 'none' && localUserFocus.text.trim().length > 0) {
      return { ...localUserFocus, source: 'local_user' };
    }

    return { ...interlocutorFocus, source: 'none' };
  }

  private pickSupportingInterlocutorItems(reliableItems: ContextItem[], focus: InterlocutorFocus): ContextItem[] {
    if (reliableItems.length === 0) return [];
    if (!focus.timestamp) return reliableItems.slice(-5);

    const focusIndex = reliableItems.findIndex((item) => Math.abs(item.timestamp - focus.timestamp!) < 2000);
    if (focusIndex < 0) return reliableItems.slice(-5);

    const start = Math.max(0, focusIndex - 4);
    const end = Math.min(reliableItems.length, focusIndex + 2);
    return reliableItems.slice(start, end);
  }

  private extractBestQuestion(text: string): string | null {
    const candidates = this.splitIntoSpeechUnits(text);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (this.looksLikeInterlocutorQuestion(candidate)) {
        return this.enrichQuestionWithLocalContext(candidates, i);
      }
    }
    return null;
  }

  private extractImplicitRequest(text: string): string | null {
    const candidates = this.splitIntoSpeechUnits(text);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (this.looksLikeImplicitRequest(candidate)) {
        return this.cleanSpeechUnit(candidate);
      }
    }
    return null;
  }

  private extractTopic(items: ContextItem[]): string {
    const recentText = items
      .slice(-5)
      .map((item) => this.cleanSpeechUnit(item.text))
      .filter(Boolean)
      .join(' ');
    if (!recentText) return '';
    const sentences = this.splitIntoSpeechUnits(recentText)
      .filter((unit) => this.normalize(unit).split(' ').length >= 5)
      .filter((unit) => !this.looksLikeDanglingFragment(unit))
      .filter((unit) => !this.isMisrecognizedQuestionStatement(this.normalize(unit)));
    const ranked = sentences
      .map((unit, index) => ({
        unit,
        score: this.scoreTopicCandidate(unit, index, sentences.length),
      }))
      .filter((candidate) => candidate.score > -2)
      .sort((a, b) => b.score - a.score);
    const candidate = ranked[0]?.unit || sentences[sentences.length - 1] || recentText;
    return this.truncate(this.distillTopicCandidate(candidate, recentText), 420);
  }

  private distillTopicCandidate(candidate: string, fallbackText: string): string {
    const source = `${candidate} ${fallbackText}`.trim();
    const clauses = this.splitIntoTopicClauses(source);
    if (clauses.length === 0) {
      return this.trimDanglingTail(this.cleanSpeechUnit(candidate));
    }

    const ranked = clauses
      .map((unit, index) => ({
        unit,
        index,
        score: this.scoreTopicCandidate(unit, index, clauses.length),
      }))
      .filter((entry) => entry.score > -2 && !this.looksLikeDanglingFragment(entry.unit))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0] || { unit: clauses[clauses.length - 1], index: clauses.length - 1, score: 0 };
    const bestWords = this.normalize(best.unit).split(' ').filter(Boolean);
    const next = clauses[best.index + 1];
    const previous = clauses[best.index - 1];
    const neighbor = next && this.scoreTopicCandidate(next, best.index + 1, clauses.length) >= 0
      ? next
      : previous && this.scoreTopicCandidate(previous, best.index - 1, clauses.length) >= 0
        ? previous
        : '';
    const joined = bestWords.length < 8 && neighbor
      ? `${best.unit}. ${neighbor}`
      : best.unit;

    return this.trimDanglingTail(this.cleanTopicLead(joined));
  }

  private splitIntoTopicClauses(text: string): string[] {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .split(/(?:[.!?。！？;]+|\s+-\s+|,\s+|\s+(?:mais|donc|alors|par contre|en revanche)\s+)/i)
      .map((unit) => this.cleanTopicLead(unit))
      .filter((unit) => this.normalize(unit).split(' ').filter(Boolean).length >= 4)
      .slice(-18);
  }

  private cleanTopicLead(text: string): string {
    return this.cleanSpeechUnit(text)
      .replace(/^(et\s+donc|et|mais|donc|alors|ok|okay|d accord|d'accord|bon|bref)\s+/i, '')
      .replace(/^(moi\s+)?(je\s+vois|j ai j ai|j'ai j'ai|wait wait)\s+/i, '')
      .trim();
  }

  private trimDanglingTail(text: string): string {
    let result = this.cleanSpeechUnit(text);
    for (let i = 0; i < 4; i++) {
      const words = this.normalize(result).split(' ').filter(Boolean);
      const last = words[words.length - 1];
      if (!last || !/^(le|la|les|un|une|des|du|de|d|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|leurs|pour|avec|dans|sur|a|à|au|aux|qui|que|dont|où|ou|et|mais|donc|parce|comme|si|cest|c|est|l|j|je|tu|on|nous|vous)$/.test(last)) {
        break;
      }
      result = result.replace(/\s+\S+[\s.?!,;:]*$/, '').trim();
    }
    return result;
  }

  private splitIntoSpeechUnits(text: string): string[] {
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return [];

    const units = clean.match(/[^.!?。！？]+[.!?。！？]?/g) || [clean];
    return units
      .map((unit) => this.cleanSpeechUnit(unit))
      .filter((unit) => unit.length > 0);
  }

  private cleanSpeechUnit(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^[,;:\-\s]+/, '')
      .trim();
  }

  private looksLikeInterlocutorQuestion(text: string): boolean {
    const clean = this.cleanSpeechUnit(text);
    const normalized = this.normalize(clean);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 3 || words.length > 80) return false;
    if (this.isMisrecognizedQuestionStatement(normalized)) return false;
    if (this.isIncompleteQuestionFragment(normalized)) return false;
    if (/[?？]\s*$/.test(clean)) return true;

    const startsLikeQuestion = /^(est ce que|qu est ce|pourquoi|comment|quand|a quel moment|à quel moment|quel|quelle|quels|quelles|combien|où|ou est|what|why|how|when|where|which)\b/i.test(normalized);
    const hasQuestionPhrase =
      /\b(pouvez vous|vous pouvez|peux tu|tu peux)\s+(me|nous|dire|expliquer|confirmer|preciser|préciser|donner|partager|montrer|clarifier|indiquer)\b/i.test(normalized) ||
      /\b(tu comprends|vous comprenez|tu penses|vous pensez|dis moi|dites moi|est ce clair|can you|could you|do you|did you|would you|should we|tell me|does that make sense)\b/i.test(normalized);
    return startsLikeQuestion || hasQuestionPhrase;
  }

  private enrichQuestionWithLocalContext(units: string[], questionIndex: number): string {
    const question = this.cleanSpeechUnit(units[questionIndex]);
    const normalized = this.normalize(question);
    const words = normalized.split(' ').filter(Boolean);
    const needsContext =
      words.length <= 10 ||
      /^(tu comprends|vous comprenez|et quand|quand on|a quel moment|à quel moment|sur quoi)\b/i.test(normalized) ||
      /\b(comment\s+(je|on|tu|vous|nous)?\s*(peux|peut|pouvez|pouvons)?\s*(y\s+)?arriver|comment\s+faire|ce point|cette partie|ça|ca|cela)\b/i.test(normalized);

    if (!needsContext) return question;

    const previousContext = units
      .slice(Math.max(0, questionIndex - 2), questionIndex)
      .map((unit) => this.cleanSpeechUnit(unit))
      .filter((unit) => {
        const normalizedUnit = this.normalize(unit);
        return normalizedUnit.split(' ').length >= 5 &&
          !this.looksLikeInterlocutorQuestion(unit) &&
          !this.isMisrecognizedQuestionStatement(normalizedUnit);
      })
      .slice(-1)[0];

    if (!previousContext) return question;
    return `${previousContext} ${question}`;
  }

  private enrichQuestionWithNeighborContext(question: string, previousItems: ContextItem[]): string {
    const normalized = this.normalize(question);
    const words = normalized.split(' ').filter(Boolean);
    if (this.isStandaloneQuestion(question)) return question;

    const needsContext =
      words.length <= 10 ||
      /\b(tu comprends|vous comprenez|tu as compris|vous avez compris|does that make sense|comment\s+(je|on|tu|vous|nous)?\s*(peux|peut|pouvez|pouvons)?\s*(y\s+)?arriver|comment\s+faire|ce point|cette partie|ça|ca|cela)\b/i.test(normalized);

    if (!needsContext || previousItems.length === 0) return question;

    const contextUnits = previousItems
      .flatMap((item) => this.splitIntoSpeechUnits(item.text))
      .map((unit) => this.cleanSpeechUnit(unit))
      .filter((unit) => {
        const normalizedUnit = this.normalize(unit);
        return normalizedUnit.split(' ').length >= 6 &&
          !this.looksLikeInterlocutorQuestion(unit) &&
          !this.isMisrecognizedQuestionStatement(normalizedUnit);
      })
      .slice(-2);

    if (contextUnits.length === 0) return question;
    return `${contextUnits.join(' ')} ${question}`;
  }

  private isStandaloneQuestion(question: string): boolean {
    const normalized = this.normalize(question);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 4) return false;
    if (/\b(tu comprends|vous comprenez|tu as compris|vous avez compris|does that make sense|ça|ca|cela|ce point|cette partie|y arriver|comment faire)\b/i.test(normalized)) {
      return false;
    }

    const startsWithQuestionWord = /^(pourquoi|comment|quand|quel|quelle|quels|quelles|combien|où|ou|what|why|how|when|where|which)\b/i.test(normalized);
    if (startsWithQuestionWord && words.length >= 4) return true;

    const hasConcreteSubject = /\b(wachap|android|donnee|donnée|donnees|données|application|telephone|téléphone|react|next|javascript|client|budget|produit|alerte|campagne)\b/i.test(normalized);
    const startsWithExplicitQuestion = /^(est ce que|est ce qu|qu est ce que|peux tu|pouvez vous|tu peux|vous pouvez|can you|could you)\b/i.test(normalized);
    return startsWithExplicitQuestion && hasConcreteSubject && words.length >= 6;
  }

  private isMisrecognizedQuestionStatement(normalized: string): boolean {
    return /\b(comment\s+)?ca me pose une question\b/i.test(normalized) ||
      /\b(comment\s+)?ça me pose une question\b/i.test(normalized) ||
      /\bca me pose question\b/i.test(normalized);
  }

  private isIncompleteQuestionFragment(normalized: string): boolean {
    const words = normalized.split(' ').filter(Boolean);
    if (words.length > 7) return false;
    if (/^(a quel moment|à quel moment|quand|comment|pourquoi|quel|quelle|tu comprends|vous comprenez)\b/i.test(normalized)) {
      return false;
    }
    return /^(et\s+)?(sur|de|du|des|a|à|au|aux|dans|pour|avec)\b/i.test(normalized);
  }

  private isComprehensionCheckQuestion(text?: string): boolean {
    const normalized = this.normalize(text || '');
    return /\b(tu comprends|vous comprenez|tu as compris|vous avez compris|what do you understand|does that make sense)\b/i.test(normalized);
  }

  private looksLikeDanglingFragment(text: string): boolean {
    const normalized = this.normalize(text);
    if (!normalized) return true;
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 4) return true;
    const last = words[words.length - 1];
    if (/^(le|la|les|un|une|des|du|de|d|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|leurs|pour|avec|dans|sur|a|à|au|aux|qui|que|dont|où|ou|et|mais|donc|parce|comme|si|cest|c|est|l|j|je|tu|on|nous|vous)$/.test(last)) {
      return true;
    }
    if (/\b(en attendant|attends|wait wait)\b/i.test(normalized) && words.length <= 8) {
      return true;
    }
    return false;
  }

  private scoreTopicCandidate(text: string, index: number, total: number): number {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    let score = 0;

    score += Math.min(2, words.length / 10);
    score += index / Math.max(1, total) * 0.8;
    if (/\b(ia|ai|react|next|javascript|youtube|video|vidéos|chaine|chaîne|vues|outil|outils|changement|alerte|vitesse|ecoulement|écoulement|produit|expiration|publicite|publicité|campagne|backend|frontend|client|manager|mvp)\b/i.test(normalized)) {
      score += 2.4;
    }
    if (/\d/.test(normalized)) score += 0.4;
    if (/\b(remplace|effondrent|changer|rester|refuser|prepare|prépare|explique|valider|confirmer|gérer|gerer)\b/i.test(normalized)) {
      score += 0.8;
    }
    if (/\b(tabasser|violent|rue|nerfs|enerve|énervé|enervement|énervement|quand meme|quand même|désolé|desole)\b/i.test(normalized)) {
      score -= 2.8;
    }
    if (/^(moi au debut|moi au début|je vois|j ai j ai|d accord|ok|mm hmm|wait wait)\b/i.test(normalized)) {
      score -= 1.4;
    }
    if (this.looksLikeDanglingFragment(text)) score -= 4;

    return score;
  }

  private looksLikeImplicitRequest(text: string): boolean {
    const normalized = this.normalize(text);
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 4 || words.length > 110) return false;
    return /\b(il faut|tu dois|vous devez|on doit|on va|tu vas|vous allez|j aimerais que|je veux que|prochaine etape|prochaine étape|priorite|priorité|deadline|a faire|à faire|we need|you need|please|next step|priority)\b/i.test(normalized) ||
      /\b(tu|vous)\s+(commence|commencer|regarde|regarder|verifie|vérifie|prepare|prépare|envoie|envoyer|confirme|confirmer)\b/i.test(normalized);
  }

  private detectLanguage(text: string): MeetingContextPacket['languageHint'] {
    const normalized = text.toLowerCase();
    if (!normalized.trim()) return 'unknown';
    const frenchHits = (normalized.match(/\b(le|la|les|des|que|qui|quoi|pour|avec|dans|donc|est ce|d accord|d'accord|ça|ca|nous|vous|tu|je|j|on|oui|non|comment|pourquoi|quand|quel|quelle|pouvez|peux|devrait|devons)\b/g) || []).length;
    const englishHits = (normalized.match(/\b(the|and|that|with|for|what|why|how|can|could|should|meeting)\b/g) || []).length;
    if (frenchHits >= 3 && englishHits >= 3) return 'mixed';
    if (frenchHits >= 2 && frenchHits >= Math.max(englishHits, 1)) return 'fr';
    if (frenchHits >= englishHits + 2) return 'fr';
    if (englishHits >= frenchHits + 2) return 'en';
    return frenchHits > 0 ? 'fr' : 'unknown';
  }

  private mapRole(canonicalRole?: string, speaker?: string): string {
    if (canonicalRole === 'me') return 'user';
    if (canonicalRole === 'assistant') return 'assistant';
    if (canonicalRole) return 'interviewer';
    const normalized = String(speaker || '').toLowerCase();
    if (['user', 'me', 'mic', 'microphone'].includes(normalized)) return 'user';
    if (['assistant', 'ai', 'model'].includes(normalized)) return 'assistant';
    return 'interviewer';
  }

  private isReliableInterlocutorItem(item: ContextItem): boolean {
    if (item.role !== 'interviewer') return false;
    if (!(item.canonicalRole === 'interlocutor' || /^speaker_\d+$/i.test(item.canonicalRole || ''))) return false;
    const flags = new Set(item.qualityFlags || []);
    if (flags.has('late_flush_duplicate') || flags.has('speaker_uncertain')) return false;
    if (flags.has('unstable_fragment')) return false;
    if (flags.has('low_confidence') && item.text.length < 80) return false;
    return this.normalize(item.text).split(' ').filter(Boolean).length >= 3;
  }

  private computeContextTrustScore(selectedItems: ContextItem[], reliableInterlocutorItems: ContextItem[]): number {
    if (selectedItems.length === 0) return 0;
    const flags = selectedItems.flatMap((item) => item.qualityFlags || []);
    const localCount = selectedItems.filter((item) => item.role === 'user').length;
    const interlocutorCount = selectedItems.filter((item) => item.role === 'interviewer').length;

    let score = reliableInterlocutorItems.length > 0 ? 0.45 : 0;
    score += Math.min(0.28, reliableInterlocutorItems.length * 0.035);
    score += Math.min(0.14, interlocutorCount * 0.01);
    if (localCount > interlocutorCount / 2) score -= 0.16;
    if (flags.includes('low_confidence')) score -= 0.08;
    if (flags.includes('stt_low_quality')) score -= 0.08;
    if (flags.includes('possible_overlap')) score -= 0.05;
    if (flags.includes('late_flush_duplicate')) score -= 0.2;
    if (flags.includes('unstable_fragment')) score -= 0.08;

    return Math.max(0, Math.min(1, score));
  }

  private rejectedReason(item: { role: string; qualityFlags?: string[] }): string {
    const flags = new Set(item.qualityFlags || []);
    if (flags.has('late_flush_duplicate')) return 'late_flush_duplicate';
    if (flags.has('unstable_fragment')) return 'unstable_fragment';
    if (flags.has('echo_suspect') || flags.has('mic_gate_held')) return 'mic_echo_or_overlap_suspect';
    if (item.role === 'user') return 'local_user_not_primary_source';
    return 'not_selected_or_duplicate';
  }

  private key(role: string, text: string, timestamp: number): string {
    return `${role}:${Math.round(timestamp / 1000)}:${this.normalize(text)}`;
  }

  private normalize(text: string): string {
    return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  private compact(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.45);
    const tail = Math.floor(maxChars * 0.45);
    return `${text.slice(0, head)}\n[...context packet truncated...]\n${text.slice(-tail)}`;
  }

  private truncate(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
  }
}
