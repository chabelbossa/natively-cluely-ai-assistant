import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { LLMHelper } from '../LLMHelper';
import type { Meeting } from '../db/DatabaseManager';
import type { TranscriptSegment } from '../SessionTracker';

export interface MeetingSummaryQuality {
  score: number;
  checks: string[];
  sourcesUsed: string[];
  needsReview: boolean;
}

export interface MeetingDetailedSummary {
  overview?: string;
  actionItems: string[];
  keyPoints: string[];
  actionItemsTitle?: string;
  keyPointsTitle?: string;
  sections?: Array<{ title: string; bullets: string[] }>;
  quality?: MeetingSummaryQuality;
}

interface GenerateSummaryInput {
  meetingId: string;
  title?: string;
  transcript: TranscriptSegment[];
  usage?: any[];
  fallbackContext?: string;
  metadata?: Record<string, unknown> | null;
  existingSummary?: MeetingDetailedSummary;
  useAudioReplay?: boolean;
}

interface EvidenceBundle {
  digest: string;
  sourcesUsed: string[];
  debugPath?: string;
  audioManifestPath?: string;
  replayDigest?: string;
  diagnostics: string[];
}

const AGENT_SECTION_TITLES = [
  'Résumé exécutif',
  'Décisions',
  "Plan d'action",
  'Questions ouvertes',
  'Risques',
  'Points à vérifier',
];

const MAX_DIGEST_CHARS = 44_000;

export class MeetingSummaryAgent {
  constructor(private readonly llmHelper: LLMHelper) {}

  async generateFromMeeting(
    meeting: Meeting,
    options: { useAudioReplay?: boolean } = {},
  ): Promise<MeetingDetailedSummary> {
    const transcript = (meeting.transcript || []).map((segment) => ({
      speaker: segment.speaker,
      text: segment.text,
      timestamp: segment.timestamp,
      final: true,
    }));

    return this.generate({
      meetingId: meeting.id,
      title: meeting.title,
      transcript,
      usage: meeting.usage,
      existingSummary: meeting.detailedSummary as MeetingDetailedSummary | undefined,
      useAudioReplay: options.useAudioReplay,
    });
  }

  async generate(input: GenerateSummaryInput): Promise<MeetingDetailedSummary> {
    const evidence = await this.collectEvidence(input);
    const first = await this.generateSummaryJson(input, evidence, input.existingSummary);
    let summary = this.normalizeSummary(first, input.existingSummary);
    let quality = this.evaluateSummary(summary, evidence);

    if (quality.needsReview) {
      const repaired = await this.repairSummaryJson(input, evidence, summary, quality);
      summary = this.normalizeSummary(repaired, summary);
      quality = this.evaluateSummary(summary, evidence);
    }

    return {
      ...summary,
      quality,
    };
  }

  private async generateSummaryJson(
    input: GenerateSummaryInput,
    evidence: EvidenceBundle,
    existingSummary?: MeetingDetailedSummary,
  ): Promise<MeetingDetailedSummary | null> {
    const prompt = this.buildGenerationPrompt(input, evidence, existingSummary);
    const response = await this.safeGenerate(prompt, evidence.digest);
    return this.parseSummaryJson(response);
  }

  private async repairSummaryJson(
    input: GenerateSummaryInput,
    evidence: EvidenceBundle,
    summary: MeetingDetailedSummary,
    quality: MeetingSummaryQuality,
  ): Promise<MeetingDetailedSummary | null> {
    const missing = quality.checks.filter((check) => check.startsWith('missing_'));
    const prompt = `${this.buildGenerationPrompt(input, evidence, summary)}

REPAIR PASS:
- The previous note was not rich enough.
- Fix these specific gaps: ${missing.length > 0 ? missing.join(', ') : 'coverage, specificity, and actionability'}.
- Preserve all useful previous bullets, but add concrete decisions, questions, risks, numbers, and follow-up checks that are present in the evidence.
- Return the full JSON object again.`;

    const response = await this.safeGenerate(prompt, evidence.digest);
    return this.parseSummaryJson(response);
  }

  private buildGenerationPrompt(
    input: GenerateSummaryInput,
    evidence: EvidenceBundle,
    existingSummary?: MeetingDetailedSummary,
  ): string {
    const sectionShape = AGENT_SECTION_TITLES
      .map((title) => `    { "title": "${title}", "bullets": [] }`)
      .join(',\n');
    const briefBlock = this.buildBriefBlock(input.metadata);
    const previous = existingSummary ? JSON.stringify(existingSummary).slice(0, 9000) : '';

    return `You are an agentic post-meeting assistant. Your job is to produce useful working notes, not a tiny recap.

LANGUAGE:
- Use the dominant language of the meeting. If the meeting is mostly French, write in French.

SOURCE CONTRACT:
- Use only the evidence in the context.
- ME is the local user / microphone.
- INTERLOCUTOR and SPEAKER_N are the other participant(s) from system audio.
- Treat long ME content that repeats INTERLOCUTOR content as possible microphone echo.
- Assistant suggestions are usage history, not meeting facts.
- Prefer reconstructed meaning over noisy ASR fragments.

QUALITY BAR:
- Be specific, operational, and useful for implementation work after the meeting.
- Capture decisions, concrete actions, ambiguous business rules, risks, numbers, provider names, and follow-up checks.
- Do not flatten important ambiguities. If the meeting leaves a tradeoff unresolved, put it in "Questions ouvertes" or "Points à vérifier".
- Do not copy raw transcript lines. Synthesize clean meaning.
- Avoid filler such as "the meeting covered".

SECTION RULES:
- "Décisions": each bullet must state an explicit decision, orientation retenue, or arbitrage.
- "Plan d'action": each bullet must describe a concrete next step, owner-free if necessary, but operational.
- "Questions ouvertes": each bullet must preserve a real ambiguity, pending confirmation, or unresolved tradeoff.
- "Risques": each bullet must state a concrete failure mode, stability concern, or business risk.
- "Points à vérifier": each bullet must name a validation, measurement, or follow-up check.
- Use explicit wording such as "Décision retenue :", "Action :", "Question ouverte :", "Risque :", and "À vérifier :" when it fits naturally.
- Mention priorities or sequencing when the evidence implies them ("priorité immédiate", "avant", "ensuite", "d'abord").

${briefBlock ? `MEETING BRIEF:\n${briefBlock}\n` : ''}
${previous ? `PREVIOUS SUMMARY TO IMPROVE:\n${previous}\n` : ''}

Return ONLY valid JSON, no markdown fences:
{
  "overview": "2-4 sentence executive summary with the actual scope and outcome.",
  "sections": [
${sectionShape}
  ],
  "actionItems": ["High-signal next steps only."],
  "keyPoints": ["High-signal decisions, constraints, numbers, or risks."]
}`;
  }

  private async safeGenerate(systemPrompt: string, context: string): Promise<string> {
    try {
      const response = await this.llmHelper.generateMeetingSummary(systemPrompt, context, systemPrompt);
      return response || '';
    } catch (error) {
      console.warn('[MeetingSummaryAgent] LLM summary generation failed:', error);
      return '';
    }
  }

  private parseSummaryJson(text: string): MeetingDetailedSummary | null {
    if (!text?.trim()) return null;
    const jsonStr = this.extractJson(text);
    if (!jsonStr) return null;

    try {
      const parsed = JSON.parse(jsonStr);
      return this.normalizeParsedSummary(parsed);
    } catch (error) {
      console.warn('[MeetingSummaryAgent] Failed to parse summary JSON:', error);
      return null;
    }
  }

  private normalizeParsedSummary(parsed: any): MeetingDetailedSummary {
    const sections = Array.isArray(parsed?.sections)
      ? parsed.sections.map((section: any) => ({
          title: String(section?.title || '').trim(),
          bullets: Array.isArray(section?.bullets)
            ? section.bullets.map((bullet: any) => String(bullet).trim()).filter(Boolean)
            : [],
        })).filter((section: any) => section.title)
      : parsed?.sections && typeof parsed.sections === 'object'
        ? Object.entries(parsed.sections).map(([title, bullets]) => ({
            title,
            bullets: Array.isArray(bullets)
              ? bullets.map((bullet: any) => String(bullet).trim()).filter(Boolean)
              : [],
          }))
        : [];

    return {
      overview: typeof parsed?.overview === 'string' ? parsed.overview.trim() : '',
      actionItems: Array.isArray(parsed?.actionItems)
        ? parsed.actionItems.map((item: any) => String(item).trim()).filter(Boolean)
        : [],
      keyPoints: Array.isArray(parsed?.keyPoints)
        ? parsed.keyPoints.map((item: any) => String(item).trim()).filter(Boolean)
        : [],
      sections: this.ensureAgentSections(sections),
    };
  }

  private normalizeSummary(
    generated: MeetingDetailedSummary | null,
    fallback?: MeetingDetailedSummary,
  ): MeetingDetailedSummary {
    const base = generated || fallback || this.buildFallbackSummary();
    return {
      overview: base.overview || fallback?.overview || '',
      actionItems: base.actionItems || [],
      keyPoints: base.keyPoints || [],
      sections: this.ensureAgentSections(base.sections || fallback?.sections || []),
    };
  }

  private ensureAgentSections(
    sections: Array<{ title: string; bullets: string[] }>,
  ): Array<{ title: string; bullets: string[] }> {
    const byTitle = new Map<string, string[]>();
    for (const section of sections || []) {
      const title = String(section.title || '').trim();
      if (!title) continue;
      byTitle.set(
        this.normalize(title),
        this.formatSectionBullets(title, Array.isArray(section.bullets) ? section.bullets.filter(Boolean) : []),
      );
    }

    return AGENT_SECTION_TITLES.map((title) => {
      const exact = byTitle.get(this.normalize(title));
      return { title, bullets: exact || [] };
    });
  }

  private buildFallbackSummary(): MeetingDetailedSummary {
    return {
      overview: 'No reliable meeting summary could be generated from the available evidence.',
      actionItems: [],
      keyPoints: [],
      sections: this.ensureAgentSections([]),
    };
  }

  private async collectEvidence(input: GenerateSummaryInput): Promise<EvidenceBundle> {
    const diagnostics: string[] = [];
    const sourcesUsed = new Set<string>();
    const parts: string[] = [];

    const transcriptDigest = this.buildTranscriptDigest(input.transcript);
    if (transcriptDigest) {
      parts.push(`[PERSISTED TRANSCRIPT]\n${transcriptDigest}`);
      sourcesUsed.add('persisted_transcript');
    }

    if (input.fallbackContext?.trim()) {
      parts.push(`[SESSION CONTEXT]\n${this.compact(input.fallbackContext, 8000)}`);
      sourcesUsed.add('session_context');
    }

    const usageDigest = this.buildUsageDigest(input.usage || []);
    if (usageDigest) {
      parts.push(`[AI USAGE HISTORY]\n${usageDigest}`);
      sourcesUsed.add('ai_usage_history');
    }

    const debugPath = this.findMeetingDebugPath(input.meetingId);
    if (debugPath) {
      const debugDigest = this.readDebugDigest(debugPath);
      if (debugDigest) {
        parts.push(`[MEETING DEBUG TRACE]\n${debugDigest}`);
        sourcesUsed.add('meeting_debug_trace');
      }
    }

    const audioManifestPath = this.findAudioManifestPath(input.meetingId);
    if (audioManifestPath) {
      const audioDigest = this.readAudioManifestDigest(audioManifestPath);
      if (audioDigest) {
        parts.push(`[AUDIO DEBUG MANIFEST]\n${audioDigest}`);
        sourcesUsed.add('audio_debug_manifest');
      }
    }

    let replayDigest = '';
    if (input.useAudioReplay && audioManifestPath) {
      replayDigest = await this.tryAudioReplayDigest(audioManifestPath);
      if (replayDigest) {
        parts.push(`[AUDIO REPLAY DIGEST]\n${replayDigest}`);
        sourcesUsed.add('audio_replay');
      } else {
        diagnostics.push('audio_replay_unavailable');
      }
    }

    return {
      digest: this.compact(parts.join('\n\n'), MAX_DIGEST_CHARS),
      sourcesUsed: Array.from(sourcesUsed),
      debugPath,
      audioManifestPath,
      replayDigest,
      diagnostics,
    };
  }

  private buildTranscriptDigest(transcript: TranscriptSegment[]): string {
    const turns: Array<{ label: string; text: string; timestamp: number }> = [];
    for (const segment of transcript || []) {
      if (segment.final === false || !segment.text?.trim()) continue;
      const speaker = String(segment.speaker || '').toLowerCase();
      if (['assistant', 'ai', 'model', 'system'].includes(speaker)) continue;
      const label = this.labelSegment(segment);
      const text = this.cleanText(segment.text);
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && last.label === label && segment.timestamp - last.timestamp < 75_000 && last.text.length < 2200) {
        last.text = `${last.text} ${text}`.trim();
        last.timestamp = segment.timestamp;
      } else {
        turns.push({ label, text, timestamp: segment.timestamp });
      }
    }

    return turns
      .map((turn) => `[${new Date(turn.timestamp).toISOString()}] ${turn.label}: ${this.truncateAtWord(turn.text, 2200)}`)
      .join('\n');
  }

  private buildUsageDigest(usage: any[]): string {
    return (usage || [])
      .slice(-20)
      .map((item) => {
        const action = item?.metadata?.action || item?.type || 'interaction';
        const question = item?.question || item?.user_query || '';
        const answer = item?.answer || item?.ai_response || '';
        return `[${action}] Q: ${this.truncateAtWord(String(question), 500)}\nA: ${this.truncateAtWord(String(answer), 900)}`;
      })
      .filter((line) => line.trim().length > 8)
      .join('\n\n');
  }

  private buildBriefBlock(metadata?: Record<string, unknown> | null): string {
    const brief = metadata && typeof metadata === 'object' ? (metadata as any).meetingBrief : null;
    if (!brief || typeof brief !== 'object') return '';
    const fields = [
      ['Objective', brief.objective],
      ['My role', brief.myRole],
      ['Participants', brief.participants],
      ['Project context', brief.projectContext],
      ['Expected decisions', brief.expectedDecisions],
      ['Must ask', brief.mustAsk],
      ['Sensitive topics', brief.sensitiveTopics],
      ['Success criteria', brief.successCriteria],
    ];
    return fields
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([label, value]) => `${label}: ${String(value).trim()}`)
      .join('\n');
  }

  private readDebugDigest(filePath: string): string {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
      const finalTranscripts: string[] = [];
      const actionResults: string[] = [];
      let rawCount = 0;
      let canonicalCount = 0;

      for (const line of lines) {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'raw_transcript') rawCount += 1;
        if (event.type === 'canonical_transcript') {
          canonicalCount += 1;
          const payload = event.payload || {};
          if (payload.final !== false && payload.text) {
            finalTranscripts.push(`${payload.role || payload.speaker}: ${payload.text}`);
          }
        }
        if (event.type === 'action_result') {
          const payload = event.payload || {};
          actionResults.push(`${payload.action || 'ACTION'}: ${payload.answer || ''}`);
        }
      }

      return this.compact([
        `debugPath=${filePath}`,
        `raw_transcripts=${rawCount}`,
        `canonical_transcripts=${canonicalCount}`,
        finalTranscripts.length ? `[FINAL CANONICAL SAMPLE]\n${finalTranscripts.slice(-80).join('\n')}` : '',
        actionResults.length ? `[ACTION RESULTS]\n${actionResults.slice(-10).join('\n')}` : '',
      ].filter(Boolean).join('\n\n'), 16_000);
    } catch (error) {
      console.warn('[MeetingSummaryAgent] Failed to read debug trace:', error);
      return '';
    }
  }

  private readAudioManifestDigest(filePath: string): string {
    try {
      const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const tracks = Object.entries(manifest.tracks || {})
        .map(([name, track]: [string, any]) =>
          `${name}: durationMs=${track.durationMs || 0}, chunks=${track.chunks || 0}, bytes=${track.bytes || 0}, silent=${track.silent === true}`,
        )
        .join('\n');
      return [
        `manifest=${filePath}`,
        `meetingId=${manifest.meetingId || ''}`,
        `debugTracePath=${manifest.debugTracePath || ''}`,
        tracks,
      ].filter(Boolean).join('\n');
    } catch (error) {
      console.warn('[MeetingSummaryAgent] Failed to read audio manifest:', error);
      return '';
    }
  }

  private async tryAudioReplayDigest(manifestPath: string): Promise<string> {
    const scriptPath = path.join(process.cwd(), 'scripts', 'replay-audio.js');
    if (!fs.existsSync(scriptPath)) return '';

    return new Promise((resolve) => {
      const child = spawn('node', [
        scriptPath,
        manifestPath,
        '--max-seconds',
        '240',
        '--track',
        'system',
        '--no-fixture',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve('');
      }, 120_000);

      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('close', () => {
        clearTimeout(timer);
        const canonicalPath = /"canonicalTranscriptMd":\s*"([^"]+)"/.exec(output)?.[1];
        if (canonicalPath && fs.existsSync(canonicalPath)) {
          resolve(this.compact(fs.readFileSync(canonicalPath, 'utf8'), 12_000));
        } else {
          resolve('');
        }
      });
    });
  }

  private evaluateSummary(summary: MeetingDetailedSummary, evidence: EvidenceBundle): MeetingSummaryQuality {
    const summaryText = this.normalize([
      summary.overview,
      ...(summary.actionItems || []),
      ...(summary.keyPoints || []),
      ...(summary.sections || []).flatMap((section) => section.bullets || []),
    ].join(' '));
    const evidenceText = this.normalize(evidence.digest);
    const checks: string[] = [];

    const bullets = (summary.sections || []).reduce((count, section) => count + (section.bullets?.length || 0), 0);
    const populatedSections = (summary.sections || []).filter((section) => section.bullets?.length > 0).length;
    const planActionBullets = (summary.sections || [])
      .filter((section) => this.normalize(section.title).includes('plan d action'))
      .reduce((count, section) => count + (section.bullets?.length || 0), 0);
    const actionLikeCount = (summary.actionItems || []).length + planActionBullets;
    const numbersInSummary = new Set(summaryText.match(/\b\d{1,4}\b/g) || []);
    const numbersInEvidence = new Set(evidenceText.match(/\b\d{1,4}\b/g) || []);

    if ((summary.overview || '').length < 140) checks.push('overview_too_short');
    if (bullets < 12) checks.push('too_few_bullets');
    if (populatedSections < 4) checks.push('too_few_populated_sections');
    if (actionLikeCount < 3) checks.push('too_few_action_items');
    if (numbersInEvidence.size >= 2 && numbersInSummary.size === 0) checks.push('missing_numeric_facts');

    const signalChecks: Array<[RegExp, RegExp, string]> = [
      [/\b(typing|en train d ecrire|en train d enregistrer|recording)\b/, /\b(typing|ecrire|enregistrer|recording|audio)\b/, 'missing_typing_recording'],
      [/\b(abonnement|expiration|expire|renouvel)\b/, /\b(abonnement|expiration|renouvel|notification)\b/, 'missing_subscription_expiry'],
    ];
    const proxyMeetingEvidence = /\b(wachap|proxy|proxies|adresse ip|adresses ip|webshare|qr|pin|compte connecte|comptes connectes)\b/.test(evidenceText);
    if (proxyMeetingEvidence) {
      signalChecks.push(
        [/\b(proxy|proxies|adresse ip|adresses ip|webshare)\b/, /\b(proxy|proxies|ip|webshare|adresse)\b/, 'missing_proxy_ip'],
        [/\b(webshare|gratuit|gratuits|statique|statiques)\b/, /\b(webshare|gratuit|statique|test)\b/, 'missing_provider_test_strategy'],
        [/\b(25|50)\b.*\b(ip|proxy|proxies|adresse|adresses|webshare|compte|comptes)\b|\b(ip|proxy|proxies|adresse|adresses|webshare|compte|comptes)\b.*\b(25|50)\b/, /\b(25|50)\b/, 'missing_25_50_tradeoff'],
        [/\b(196|200|qr|pin)\b/, /\b(196|200|qr|pin|connect)\b/, 'missing_account_audit_numbers'],
      );
    }
    const categoryChecks: Array<[RegExp, string]> = [
      [/\b(decision|decide|retenu|orientation|trancher|arbitrage)\b/, 'missing_decision_language'],
      [/\b(action|faire|tester|verifier|audit|implementer|developper|envoyer|analyser)\b/, 'missing_action_language'],
      [/\b(question|ambigu|clarifier|a verifier|a definir)\b/, 'missing_open_question_language'],
      [/\b(risque|stabilite|bloquant|fragile|compte)\b/, 'missing_risk_language'],
      [/\b(priorite|prioritaire|prioritaires|avant|ensuite|d abord)\b/, 'missing_priority_language'],
    ];

    for (const [sourcePattern, summaryPattern, check] of signalChecks) {
      if (sourcePattern.test(evidenceText) && !summaryPattern.test(summaryText)) {
        checks.push(check);
      }
    }
    for (const [pattern, check] of categoryChecks) {
      if (!pattern.test(summaryText)) checks.push(check);
    }

    let score = 100;
    for (const check of checks) {
      if (check.startsWith('missing_')) score -= 14;
      else score -= 8;
    }
    if (bullets >= 16) score += 5;
    if (populatedSections >= 5) score += 5;
    score = Math.max(0, Math.min(100, score));

    return {
      score,
      checks,
      sourcesUsed: evidence.sourcesUsed,
      needsReview: score < 72 || checks.some((check) => check.startsWith('missing_')),
    };
  }

  private findMeetingDebugPath(meetingId: string): string | undefined {
    const dir = path.join(this.getUserDataDir(), 'meeting-debug');
    if (!fs.existsSync(dir)) return undefined;
    const files = fs.readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => path.join(dir, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    for (const file of files) {
      try {
        if (fs.readFileSync(file, 'utf8').includes(meetingId)) return file;
      } catch {
        // Ignore unreadable debug files.
      }
    }
    return undefined;
  }

  private findAudioManifestPath(meetingId: string): string | undefined {
    const dir = path.join(this.getUserDataDir(), 'audio-debug');
    if (!fs.existsSync(dir)) return undefined;
    const manifests = fs.readdirSync(dir)
      .map((entry) => path.join(dir, entry, 'manifest.json'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    for (const manifestPath of manifests) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.meetingId === meetingId) return manifestPath;
      } catch {
        // Ignore malformed manifests.
      }
    }
    return undefined;
  }

  private getUserDataDir(): string {
    try {
      return app.getPath('userData');
    } catch {
      return path.join(process.env.HOME || process.cwd(), 'Library/Application Support/natively');
    }
  }

  private labelSegment(segment: TranscriptSegment): string {
    const speaker = String(segment.speaker || '').toLowerCase();
    if (segment.canonicalRole === 'me' || ['user', 'me', 'mic', 'microphone'].includes(speaker)) return 'ME';
    const canonicalMatch = /^speaker_(\d+)$/i.exec(segment.canonicalRole || '');
    if (canonicalMatch) return `INTERLOCUTOR_SPEAKER_${canonicalMatch[1]}`;
    const speakerMatch = /^speaker[_-]?(\d+)$/i.exec(speaker);
    if (speakerMatch) return `INTERLOCUTOR_SPEAKER_${speakerMatch[1]}`;
    const locuteurMatch = /^locuteur[_-]?(\d+)$/i.exec(speaker);
    if (locuteurMatch) return `INTERLOCUTOR_SPEAKER_${Number(locuteurMatch[1]) + 1}`;
    return 'INTERLOCUTOR';
  }

  private extractJson(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced?.[1]) return fenced[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    return text.slice(first, last + 1).trim();
  }

  private cleanText(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  private formatSectionBullets(title: string, bullets: string[]): string[] {
    const normalizedTitle = this.normalize(title);
    return (bullets || [])
      .map((bullet) => this.cleanText(bullet))
      .filter(Boolean)
      .map((bullet) => {
        if (normalizedTitle.includes('decisions')) {
          return this.prefixBullet(bullet, 'Décision retenue');
        }
        if (normalizedTitle.includes('plan d action')) {
          return this.prefixBullet(bullet, 'Action');
        }
        if (normalizedTitle.includes('questions ouvertes')) {
          return this.prefixBullet(bullet, 'Question ouverte');
        }
        if (normalizedTitle.includes('risques')) {
          return this.prefixBullet(bullet, 'Risque');
        }
        if (normalizedTitle.includes('points a verifier')) {
          return this.prefixBullet(bullet, 'À vérifier');
        }
        return bullet;
      });
  }

  private prefixBullet(bullet: string, label: string): string {
    const clean = this.cleanText(bullet);
    if (!clean) return '';
    const normalizedBullet = this.normalize(clean);
    const normalizedLabel = this.normalize(label);
    if (normalizedBullet.startsWith(`${normalizedLabel} `) || normalizedBullet.startsWith(`${normalizedLabel} :`)) {
      return clean;
    }
    return `${label} : ${clean}`;
  }

  private normalize(text: string): string {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private compact(text: string, maxChars: number): string {
    const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length <= maxChars) return clean;
    const first = Math.floor(maxChars * 0.36);
    const middle = Math.floor(maxChars * 0.28);
    const last = Math.floor(maxChars * 0.36);
    const middleStart = Math.max(0, Math.floor(clean.length / 2) - Math.floor(middle / 2));
    return [
      '[BEGINNING]',
      clean.slice(0, first).trim(),
      '[MIDDLE]',
      clean.slice(middleStart, middleStart + middle).trim(),
      '[END]',
      clean.slice(Math.max(0, clean.length - last)).trim(),
    ].join('\n\n');
  }

  private truncateAtWord(text: string, maxChars: number): string {
    const clean = this.cleanText(text);
    if (clean.length <= maxChars) return clean;
    const slice = clean.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(' ');
    return `${slice.slice(0, lastSpace > maxChars * 0.7 ? lastSpace : maxChars).trim()}...`;
  }
}
