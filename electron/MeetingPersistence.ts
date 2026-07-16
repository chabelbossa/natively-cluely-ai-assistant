// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
import { GROQ_TITLE_PROMPT, GROQ_SUMMARY_JSON_PROMPT } from './llm';
import { MeetingBriefManager } from './meeting/MeetingBriefManager';
import { MeetingSummaryAgent, type MeetingDetailedSummary } from './meeting/MeetingSummaryAgent';
import { sanitizeMeetingTitle } from './meeting/MeetingSummaryQuality';
const crypto = require('crypto');

export class MeetingPersistence {
    private session: SessionTracker;
    private llmHelper: LLMHelper;

    constructor(session: SessionTracker, llmHelper: LLMHelper) {
        this.session = session;
        this.llmHelper = llmHelper;
    }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(): Promise<string | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        const durationMs = Date.now() - this.session.getSessionStartTime();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            this.session.reset();
            return null;
        }

        const snapshot = {
            transcript: [...this.session.getFullTranscript()],
            usage: [...this.session.getFullUsage()],
            startTime: this.session.getSessionStartTime(),
            durationMs: durationMs,
            context: this.session.getFullSessionContext()
        };

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        const meetingId = crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId, metadataSnapshot).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(durationMs / 60000);
        const seconds = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false
        };

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, durationMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }

        return meetingId;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, durationMs: number, context: string },
        meetingId: string,
        // BUG-04 fix: accept metadata snapshot so calendar info is not lost after session.reset()
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: MeetingDetailedSummary = { actionItems: [], keyPoints: [] };
        const meetingContextForLLM = this.buildMeetingSummaryContext(data.transcript, data.context);

        // Use passed-in metadata snapshot (NOT this.session.getMeetingMetadata() which is already cleared)
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (metadata) {
            if (metadata.title) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
        }

        try {
            // Generate Title (only if not set by calendar)
            if (!metadata || !metadata.title) {
                const titlePrompt = `Generate a specific concise 3-7 word title for this meeting.
Rules:
- Use the actual subject matter, not generic labels.
- Avoid generic titles like "Project Discussion Meeting", "Meeting Notes", "Team Meeting", or "Discussion".
- If there are two major topics, combine them briefly.
- Output ONLY the title text. No quotes.`;
                const groqTitlePrompt = GROQ_TITLE_PROMPT;
                const titleContext = this.compactContextForLLM(meetingContextForLLM, 12000);

                const generatedTitle = await this.llmHelper.generateMeetingSummary(titlePrompt, titleContext, groqTitlePrompt);
                const cleanedTitle = sanitizeMeetingTitle(generatedTitle || '');
                title = cleanedTitle && !this.isGenericTitle(cleanedTitle)
                    ? cleanedTitle
                    : this.buildLocalTitle(data.transcript);
            }

            // Load template note sections for the active mode's templateType
            let modeNoteSections: Array<{ title: string; description: string }> = [];
            try {
                const { ModesManager, TEMPLATE_NOTE_SECTIONS } = require('./services/ModesManager');
                const modesMgr = ModesManager.getInstance();
                const activeMode = modesMgr.getActiveMode();
                if (activeMode) {
                    // Prefer user's customized DB sections; fall back to canonical template
                    const dbSections: Array<{ title: string; description: string }> = modesMgr.getNoteSections(activeMode.id);
                    modeNoteSections = dbSections.length > 0
                        ? dbSections
                        : (TEMPLATE_NOTE_SECTIONS[activeMode.templateType] ?? []);
                    console.log(`[MeetingPersistence] Active mode: "${activeMode.name}" (${activeMode.templateType}), sections: ${modeNoteSections.length} (${dbSections.length > 0 ? 'custom DB' : 'canonical template'})`);
                } else {
                    console.log('[MeetingPersistence] No active mode — using generic summary.');
                }
            } catch (modeErr: any) {
                console.warn('[MeetingPersistence] Failed to load active mode sections:', modeErr?.message);
            }

            // Generate Structured Summary
            if (data.transcript.length > 0) {
                const baseRules = `RULES:
- Do NOT invent information not present in the context.
- Do NOT simply quote or paraphrase transcript fragments. Synthesize the actual meeting outcome.
- INTERLOCUTOR is the source of external facts, requirements, decisions, constraints, and answers.
- ME is the local user. Use ME mainly for questions asked, commitments made, or constraints stated by the local user.
- Ignore ASSISTANT_PREVIOUS/assistant suggestions as meeting facts.
- Ignore duplicate-looking, repeated, or low-quality fragments. Prefer stable meaning over noisy wording.
- Only infer action items when they are direct practical consequences of the discussion.
- Do NOT explain or define concepts mentioned.
- Do NOT use filler phrases like "The meeting covered..." or "Discussed various..."
- Do NOT mention transcripts, AI, or summaries.
- Do NOT sound like an AI assistant.
- If the conversation is mostly French, write the notes in French.
- Sound like a senior PM's internal notes.

STYLE: Calm, neutral, professional, skim-friendly. Short bullets, no sub-bullets.`;

                let summaryPrompt: string;
                let groqSummaryPrompt: string;

                if (modeNoteSections.length > 0) {
                    // Mode-specific structured notes — sections as object with title keys
                    const sectionList = modeNoteSections
                        .map(s => s.description?.trim()
                            ? `- "${s.title}": ${s.description}`
                            : `- "${s.title}"`)
                        .join('\n');
                    const sectionKeys = modeNoteSections
                        .map(s => `    "${s.title}": []`)
                        .join(',\n');

                    // Include the full mode context block (reference files + custom context)
                    const modeContext = (() => {
                        try {
                            const { ModesManager } = require('./services/ModesManager');
                            const block = ModesManager.getInstance().buildActiveModeContextBlock();
                            return block ? `\n${block}\n` : '';
                        } catch { return ''; }
                    })();

                    summaryPrompt = `You are a silent meeting note-taker. Extract useful structured notes from the conversation transcript below.
${modeContext}
${baseRules}

SECTIONS TO FILL (extract only what is present in the transcript):
${sectionList}

Return ONLY valid JSON — no markdown fences, no comments, no extra keys.
Each section value is an array of concise factual bullets. Do not copy raw transcript lines; write the clean operational meaning.
Use [] if a section has no relevant content.

{
  "overview": "1-2 sentence summary of what was discussed",
  "sections": {
${sectionKeys}
  }
}`;
                    console.log('[MeetingPersistence] Using mode-specific prompt with sections:', modeNoteSections.map(s => s.title));
                    groqSummaryPrompt = summaryPrompt;
                } else {
                    // Default generic notes
                    summaryPrompt = `You are a silent meeting summarizer. Convert this conversation into concise operational meeting notes.

${baseRules}

Return ONLY valid JSON (no markdown code blocks):
{
  "overview": "1-2 sentence summary of the actual outcome and scope",
  "keyPoints": ["3-6 specific bullets: decisions, constraints, architecture/product points, open questions"],
  "actionItems": ["specific next steps or assigned follow-ups. If none found, return []"]
}`;
                    groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;
                }

                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, meetingContextForLLM, groqSummaryPrompt);

                if (generatedSummary) {
                    // Strip markdown fences if present
                    const jsonMatch = generatedSummary.match(/```(?:json)?\n?([\s\S]*?)\n?```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();
                    console.log('[MeetingPersistence] Raw LLM summary response (first 500 chars):', jsonStr.substring(0, 500));
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (modeNoteSections.length > 0 && parsed.sections && typeof parsed.sections === 'object') {
                            // Convert sections object into typed array preserving template order
                            const sectionsArr: Array<{ title: string; bullets: string[] }> = modeNoteSections
                                .map(s => ({
                                    title: s.title,
                                    bullets: Array.isArray(parsed.sections[s.title]) ? parsed.sections[s.title] as string[] : [],
                                }));
                            console.log('[MeetingPersistence] Parsed mode sections:', sectionsArr.map(s => `${s.title}(${s.bullets.length})`));
                            summaryData = {
                                overview: parsed.overview,
                                actionItems: [],
                                keyPoints: [],
                                sections: sectionsArr,
                            };
                        } else {
                            if (modeNoteSections.length > 0) {
                                console.warn('[MeetingPersistence] Mode sections expected but LLM did not return "sections" key. Falling back to generic.');
                            }
                            summaryData = parsed;
                        }
                    } catch (e) {
                        console.error('[MeetingPersistence] Failed to parse summary JSON. Raw response:', jsonStr.substring(0, 800), e);
                    }
                }
            } else {
                console.log("Transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        if (data.transcript.length > 0 && !this.hasSummaryContent(summaryData)) {
            console.warn('[MeetingPersistence] Using local fallback summary because LLM summary was unavailable.');
            summaryData = this.buildLocalSummary(data.transcript);
        }

        if (data.transcript.length > 0) {
            try {
                const summaryAgent = new MeetingSummaryAgent(this.llmHelper);
                summaryData = await summaryAgent.generate({
                    meetingId,
                    title,
                    transcript: data.transcript,
                    usage: data.usage,
                    fallbackContext: data.context,
                    metadata: metadata || null,
                    existingSummary: summaryData,
                });
                console.log('[MeetingPersistence] Agentic summary quality:', summaryData.quality);
            } catch (agentError) {
                console.warn('[MeetingPersistence] Agentic summary pass failed; keeping structured summary:', agentError);
            }
        }

        title = sanitizeMeetingTitle(title);
        if ((!title || title === "Untitled Session") && data.transcript.length > 0) {
            title = this.buildLocalTitle(data.transcript);
        }

        try {
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: durationStr,
                summary: "See detailed summary",
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.durationMs);

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
        }
    }

    private hasSummaryContent(summary: MeetingDetailedSummary): boolean {
        if (summary.overview?.trim()) return true;
        if (summary.actionItems?.length > 0) return true;
        if (summary.keyPoints?.length > 0) return true;
        return Boolean(summary.sections?.some(section => section.bullets.length > 0));
    }

    private buildMeetingSummaryContext(transcript: TranscriptSegment[], fallbackContext: string): string {
        const cleanedTranscript = this.buildCleanSummaryTranscript(transcript);
        const turns = this.buildSummaryTurns(cleanedTranscript);
        const droppedFinals = transcript.filter(segment => segment.final !== false && segment.text?.trim()).length - cleanedTranscript.length;
        const lines = turns
            .map(turn => `[${turn.label}]: ${this.truncateAtWord(turn.text, 1800)}`)
            .filter(line => line.length > 0);

        const transcriptContext = lines.join('\n');
        const rawContext = transcriptContext || fallbackContext || '';
        const compacted = this.compactContextForLLM(rawContext, 28000);

        const briefBlock = MeetingBriefManager.getInstance().buildContextBlock();

        return `${briefBlock ? `${briefBlock}\n\n` : ''}[MEETING TRANSCRIPT DIGEST]
	Speaker contract:
	- ME = local microphone / the app user.
	- INTERLOCUTOR = the other participant(s), professor, client, manager, interviewer, or system audio.
	- INTERLOCUTOR_SPEAKER_N labels are diarized system-audio participants. Keep their turns separate when reconstructing exchanges.
	- Meeting brief is background only; transcript remains the source of truth for what was actually said.
	- Summaries must cover the whole digest, including the middle and final excerpts.
	- Ignore previous assistant suggestions as facts.
- If ME contains long repeated content that mirrors INTERLOCUTOR, treat it as microphone echo, not as a user statement.
- Dropped noisy final segments before this digest: ${Math.max(0, droppedFinals)}.

${compacted}`;
    }

    private compactContextForLLM(text: string, maxChars: number): string {
        const clean = text.replace(/\n{3,}/g, '\n\n').trim();
        if (clean.length <= maxChars) return clean;

        const firstBudget = Math.floor(maxChars * 0.34);
        const middleBudget = Math.floor(maxChars * 0.28);
        const lastBudget = Math.floor(maxChars * 0.34);

        const middleStart = Math.max(0, Math.floor(clean.length / 2) - Math.floor(middleBudget / 2));
        const lastStart = Math.max(0, clean.length - lastBudget);

        const first = this.sliceContext(clean, 0, firstBudget);
        const middle = this.sliceContext(clean, middleStart, middleBudget);
        const last = this.sliceContext(clean, lastStart, lastBudget);

        return [
            '[BEGINNING EXCERPT]',
            first,
            '[MIDDLE EXCERPT]',
            middle,
            '[FINAL EXCERPT]',
            last,
        ].join('\n\n');
    }

    private sliceContext(text: string, start: number, length: number): string {
        let sliceStart = Math.max(0, start);
        let sliceEnd = Math.min(text.length, sliceStart + length);

        if (sliceStart > 0) {
            const nextBreak = text.indexOf('\n', sliceStart);
            if (nextBreak >= 0 && nextBreak < sliceStart + 400) {
                sliceStart = nextBreak + 1;
            }
        }

        if (sliceEnd < text.length) {
            const prevBreak = text.lastIndexOf('\n', sliceEnd);
            if (prevBreak > sliceStart + Math.floor(length * 0.65)) {
                sliceEnd = prevBreak;
            }
        }

        return text.slice(sliceStart, sliceEnd).trim();
    }

    private buildLocalTitle(transcript: TranscriptSegment[]): string {
        const usableSegments = this.buildCleanSummaryTranscript(transcript);
        const preferredSegments = usableSegments.some(segment => this.isInterlocutorSummarySegment(segment))
            ? usableSegments.filter(segment => this.isInterlocutorSummarySegment(segment))
            : usableSegments;
        const combined = preferredSegments
            .slice(0, 80)
            .map(segment => this.cleanTranscriptText(segment.text))
            .join(' ');
        const normalized = this.normalizeForComparison(combined);

        const hasTenantPayment = /\b(locataire|locataires|loyer|paiement|payer|proprietaire|propriétaire|defaut|défaut|echeancier|échéancier)\b/.test(normalized);
        const hasGaussian = /\b(processus|gaussien|gaussian|hierarchique|hiérarchique|prediction|prédiction|priori|posteriori)\b/.test(normalized);
        const hasVoiceData = /\b(voix|vocal|vocale|speech|audio|transcription|text to speech|speech to text|donnees vocales|données vocales)\b/.test(normalized);
        const hasWhatsappCatalog = /\b(whatsapp|catalogue|produit|produits|afriyo|mot cle|mot clé|referencement|référencement)\b/.test(normalized);
        const hasWachap = /\b(wachap|wa chap|chatbot|flux|pierre)\b/.test(normalized);

        if (hasTenantPayment && hasVoiceData) return 'Scoring locataires et données vocales';
        if (hasTenantPayment && hasGaussian) return 'Prédiction des paiements locataires';
        if (hasVoiceData) return 'Données vocales et transcription';
        if (hasWhatsappCatalog) return 'Catalogue WhatsApp et référencement';
        if (hasWachap) return 'Diagnostic des flux WaChap';

        const firstText = preferredSegments.find(segment => segment.text?.trim())?.text || 'Meeting Notes';
        const words = firstText
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .filter(Boolean)
            .filter(word => !/^(bon|oui|ok|okay|donc|alors|euh|heu|en|fait|voila|voilà)$/i.test(word))
            .slice(0, 6);
        return words.length > 0 ? words.join(' ') : 'Meeting Notes';
    }

    private isGenericTitle(title: string): boolean {
        const normalized = this.normalizeForComparison(title);
        return /^(project|meeting|team|general|discussion|notes|session)(\s+(project|meeting|team|general|discussion|notes|session))*$/.test(normalized) ||
            /\b(project discussion meeting|meeting discussion|team meeting|general meeting|meeting notes|untitled session|discussion meeting)\b/.test(normalized);
    }

    private buildLocalSummary(transcript: TranscriptSegment[]): MeetingDetailedSummary {
        const usableSegments = this.buildCleanSummaryTranscript(transcript);

        const preferredSegments = usableSegments.some(segment => segment.speaker !== 'user')
            ? usableSegments.filter(segment => segment.speaker !== 'user')
            : usableSegments;

        const cleaned = preferredSegments
            .map(segment => this.cleanTranscriptText(segment.text))
            .filter(text => text.length > 0);

        const combined = cleaned.join(' ');
        const overview = combined
            ? this.truncateAtWord(combined, 420)
            : 'No reliable transcript content was captured.';

        const keyPoints = Array.from(new Set(cleaned
            .map(text => this.truncateAtWord(text, 180))
            .filter(text => text.length >= 12)))
            .slice(-6);

        return {
            overview,
            actionItems: [],
            keyPoints: keyPoints.length > 0 ? keyPoints : [overview],
        };
    }

    private buildCleanSummaryTranscript(transcript: TranscriptSegment[]): TranscriptSegment[] {
        const kept: TranscriptSegment[] = [];
        const hasInterlocutor = transcript.some(segment =>
            segment.final !== false &&
            Boolean(segment.text?.trim()) &&
            this.isInterlocutorSummarySegment(segment)
        );

        for (const segment of transcript) {
            if (segment.final === false || !segment.text?.trim()) continue;
            if (this.isSummarySegmentRejected(segment, kept, hasInterlocutor)) continue;
            kept.push(segment);
        }

        return kept;
    }

    private isSummarySegmentRejected(segment: TranscriptSegment, kept: TranscriptSegment[], hasInterlocutor: boolean): boolean {
        const speaker = String(segment.speaker || '').toLowerCase();
        if (['system', 'ai', 'assistant', 'model'].includes(speaker)) return true;

        const text = segment.text.trim();
        const normalized = this.normalizeForComparison(text);
        if (!normalized) return true;

        const flags = new Set(segment.qualityFlags || []);
        if (flags.has('late_flush_duplicate') || flags.has('mic_rejected') || flags.has('echo_suspect')) return true;

        const isMicLike = segment.canonicalRole === 'me' || ['user', 'me', 'mic', 'microphone'].includes(speaker);
        if (isMicLike) {
            const overlap = flags.has('possible_overlap') || flags.has('mic_gate_held');
            const looksLikeQuestion = this.looksLikeLocalQuestion(text);
            const looksLikeContribution = this.looksLikeLocalContribution(text);
            if (hasInterlocutor && !looksLikeQuestion && !looksLikeContribution) return true;
            if (hasInterlocutor && text.length > 700 && !looksLikeQuestion) return true;
            if (overlap && text.length > 180 && !looksLikeQuestion) return true;
            if (flags.has('stt_low_quality') && text.length > 180) return true;
            if (this.isSimilarToKeptInterlocutor(normalized, segment.timestamp, kept) && !looksLikeQuestion) return true;
        }

        if (text.length > 1800 && this.matchesMultiplePreviousSegments(normalized, kept)) return true;

        const duplicate = kept.some(existing => {
            const existingNorm = this.normalizeForComparison(existing.text);
            if (!existingNorm) return false;
            const elapsed = Math.abs(existing.timestamp - segment.timestamp);
            return elapsed < 120_000 && this.textSimilarity(normalized, existingNorm) >= 0.88;
        });

        return duplicate;
    }

    private buildSummaryTurns(segments: TranscriptSegment[]): Array<{ label: string; text: string; timestamp: number }> {
        const turns: Array<{ label: string; text: string; timestamp: number }> = [];

        for (const segment of segments) {
            const text = this.cleanTranscriptText(segment.text);
            if (!text) continue;

            const label = this.getSummarySpeakerLabel(segment);
            const last = turns[turns.length - 1];
            const normalizedText = this.normalizeForComparison(text);
            const lastNormalized = last ? this.normalizeForComparison(last.text) : '';

            if (
                last &&
                last.label === label &&
                segment.timestamp - last.timestamp <= 55_000 &&
                last.text.length + text.length <= 2200
            ) {
                if (!lastNormalized.includes(normalizedText) && !normalizedText.includes(lastNormalized)) {
                    last.text = `${last.text} ${text}`.trim();
                } else if (normalizedText.length > lastNormalized.length) {
                    last.text = text;
                }
                last.timestamp = segment.timestamp;
                continue;
            }

            turns.push({ label, text, timestamp: segment.timestamp });
        }

        return turns;
    }

    private getSummarySpeakerLabel(segment: TranscriptSegment): string {
        const speaker = String(segment.speaker || '').toLowerCase();
        if (segment.canonicalRole === 'me' || speaker === 'user' || speaker === 'me' || speaker === 'mic') {
            return 'ME';
        }
        if (segment.canonicalRole === 'uncertain') return 'INTERLOCUTOR_UNCERTAIN';
        const canonicalSpeaker = /^speaker_(\d+)$/i.exec(segment.canonicalRole || '');
        if (canonicalSpeaker) return `INTERLOCUTOR_SPEAKER_${Number(canonicalSpeaker[1])}`;
        const speakerMatch = /^speaker[_-]?(\d+)$/i.exec(speaker);
        if (speakerMatch) return `INTERLOCUTOR_SPEAKER_${Number(speakerMatch[1])}`;
        const locuteurMatch = /^locuteur[_-]?(\d+)$/i.exec(speaker);
        if (locuteurMatch) return `INTERLOCUTOR_SPEAKER_${Number(locuteurMatch[1]) + 1}`;
        return 'INTERLOCUTOR';
    }

    private isInterlocutorSummarySegment(segment: TranscriptSegment): boolean {
        const speaker = String(segment.speaker || '').toLowerCase();
        if (['system', 'ai', 'assistant', 'model', 'user', 'me', 'mic', 'microphone'].includes(speaker)) return false;
        return segment.canonicalRole !== 'me';
    }

    private isSimilarToKeptInterlocutor(normalizedText: string, timestamp: number, kept: TranscriptSegment[]): boolean {
        return kept.some(existing => {
            const speaker = String(existing.speaker || '').toLowerCase();
            const isInterlocutor = existing.canonicalRole !== 'me' && !['user', 'me', 'mic', 'assistant', 'ai', 'model'].includes(speaker);
            if (!isInterlocutor) return false;
            if (Math.abs(existing.timestamp - timestamp) > 120_000) return false;
            const existingNorm = this.normalizeForComparison(existing.text);
            return existingNorm.length > 25 && this.textSimilarity(normalizedText, existingNorm) >= 0.42;
        });
    }

    private matchesMultiplePreviousSegments(normalizedText: string, kept: TranscriptSegment[]): boolean {
        let matches = 0;
        for (const existing of kept) {
            const existingNorm = this.normalizeForComparison(existing.text);
            if (existingNorm.length < 35) continue;
            if (normalizedText.includes(existingNorm) || this.textSimilarity(normalizedText, existingNorm) >= 0.5) {
                matches += 1;
            }
            if (matches >= 3) return true;
        }
        return false;
    }

    private looksLikeLocalQuestion(text: string): boolean {
        const normalized = this.normalizeForComparison(text);
        const words = normalized.split(' ').filter(Boolean);
        if (words.length === 0 || words.length > 90) return false;
        if (/\?$/.test(text.trim())) return true;
        return /(^|\b)(est ce que|pourquoi|comment|quand|quel|quelle|quels|quelles|combien|où|ou est|pouvez vous|peux tu|tu peux|vous pouvez|je voulais demander|je voudrais savoir|j aimerais savoir)\b/i.test(normalized);
    }

    private looksLikeLocalContribution(text: string): boolean {
        const normalized = this.normalizeForComparison(text);
        const words = normalized.split(' ').filter(Boolean);
        if (words.length === 0 || words.length > 110) return false;
        return /(^|\b)(je pense|je crois|je vais|j envoie|j aurais besoin|j ai besoin|je dois|je fais|je propose|je peux|on va|on peut|d accord je|ok je|oui je|ma compréhension|ce que je propose)\b/i.test(normalized);
    }

    private normalizeForComparison(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private textSimilarity(a: string, b: string): number {
        const aWords = a.split(' ').filter(Boolean);
        const bWords = b.split(' ').filter(Boolean);
        if (aWords.length === 0 || bWords.length === 0) return 0;

        const aSet = new Set(aWords);
        const bSet = new Set(bWords);
        let intersection = 0;
        for (const word of aSet) {
            if (bSet.has(word)) intersection += 1;
        }
        const union = new Set([...aSet, ...bSet]).size;
        return union === 0 ? 0 : intersection / union;
    }

    private cleanTranscriptText(text: string): string {
        return text
            .replace(/\s+/g, ' ')
            .replace(/\s+([,.!?;:])/g, '$1')
            .trim();
    }

    private truncateAtWord(text: string, maxLength: number): string {
        const clean = this.cleanTranscriptText(text);
        if (clean.length <= maxLength) return clean;
        const truncated = clean.slice(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');
        return `${truncated.slice(0, lastSpace > 80 ? lastSpace : maxLength).trim()}...`;
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering...`);

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[MeetingPersistence] Recovering meeting ${m.id}...`);

                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'interviewer' ? 'INTERVIEWER' :
                        t.speaker === 'user' ? 'ME' :
                            /^locuteur[_-]\d+$/i.test(t.speaker || '') ? t.speaker.toUpperCase() :
                                /^speaker[_-]\d+$/i.test(t.speaker || '') ? t.speaker.toUpperCase() :
                                    'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const parts = (details.duration || '0:00').split(':');
                // EC-07 fix: guard against malformed duration strings (e.g. corrupted DB row)
                const mins = parseInt(parts[0]) || 0;
                const secs = parseInt(parts[1]) || 0;
                const durationMs = ((mins * 60) + secs) * 1000;
                const startTime = new Date(details.date).getTime();

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }
    }
}
