import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface MeetingBrief {
  id?: string;
  title?: string;
  objective?: string;
  myRole?: string;
  participants?: string;
  projectContext?: string;
  expectedDecisions?: string;
  mustAsk?: string;
  sensitiveTopics?: string;
  successCriteria?: string;
  updatedAt?: number;
}

const MAX_FIELD_LENGTH = 4_000;
const MAX_CONTEXT_LENGTH = 14_000;

export class MeetingBriefManager {
  private static instance: MeetingBriefManager | null = null;
  private activeBrief: MeetingBrief | null = null;
  private loaded = false;

  static getInstance(): MeetingBriefManager {
    if (!MeetingBriefManager.instance) {
      MeetingBriefManager.instance = new MeetingBriefManager();
    }
    return MeetingBriefManager.instance;
  }

  getActiveBrief(): MeetingBrief | null {
    this.ensureLoaded();
    return this.hasUsefulContent(this.activeBrief) ? { ...this.activeBrief } : null;
  }

  saveActiveBrief(input: MeetingBrief | null | undefined): MeetingBrief | null {
    this.ensureLoaded();
    const next = this.sanitizeBrief(input || {});
    this.activeBrief = this.hasUsefulContent(next) ? next : null;
    this.persist();
    return this.getActiveBrief();
  }

  clearActiveBrief(): void {
    this.activeBrief = null;
    this.persist();
  }

  activateForMeeting(input?: MeetingBrief | null, defaults?: { title?: string }): MeetingBrief | null {
    this.ensureLoaded();
    const source = this.hasUsefulContent(input) ? input : this.activeBrief;
    if (!this.hasUsefulContent(source)) return null;

    const next = this.sanitizeBrief({
      ...source,
      title: source?.title || defaults?.title,
      updatedAt: Date.now(),
    });
    this.activeBrief = next;
    this.persist();
    return { ...next };
  }

  buildContextBlock(): string {
    const brief = this.getActiveBrief();
    if (!brief) return '';

    const lines = [
      this.formatField('Meeting title', brief.title),
      this.formatField('Objective', brief.objective),
      this.formatField('My role', brief.myRole),
      this.formatField('Expected participants', brief.participants),
      this.formatField('Project context', brief.projectContext),
      this.formatField('Expected decisions', brief.expectedDecisions),
      this.formatField('Important questions to ask', brief.mustAsk),
      this.formatField('Sensitive topics / pitfalls', brief.sensitiveTopics),
      this.formatField('Success criteria', brief.successCriteria),
    ].filter(Boolean);

    if (lines.length === 0) return '';
    const block = [
      '[MEETING BRIEF]',
      ...lines,
      '[/MEETING BRIEF]',
      'Use this brief as background context only. Do not claim the interlocutor said something unless it appears in the live transcript.',
    ].join('\n');

    return block.length <= MAX_CONTEXT_LENGTH
      ? block
      : `${block.slice(0, MAX_CONTEXT_LENGTH)}\n[...meeting brief truncated]`;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const filePath = this.getFilePath();
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.activeBrief = this.sanitizeBrief(parsed);
    } catch (error: any) {
      console.warn('[MeetingBriefManager] Failed to load active brief:', error?.message || error);
      this.activeBrief = null;
    }
  }

  private persist(): void {
    try {
      const filePath = this.getFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.activeBrief || {}, null, 2), 'utf8');
    } catch (error: any) {
      console.warn('[MeetingBriefManager] Failed to persist active brief:', error?.message || error);
    }
  }

  private getFilePath(): string {
    return path.join(app.getPath('userData'), 'meeting-brief.json');
  }

  private sanitizeBrief(input: MeetingBrief): MeetingBrief {
    const clean = (value: unknown) =>
      String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim()
        .slice(0, MAX_FIELD_LENGTH);

    return {
      id: input.id || `brief_${Date.now()}`,
      title: clean(input.title),
      objective: clean(input.objective),
      myRole: clean(input.myRole),
      participants: clean(input.participants),
      projectContext: clean(input.projectContext),
      expectedDecisions: clean(input.expectedDecisions),
      mustAsk: clean(input.mustAsk),
      sensitiveTopics: clean(input.sensitiveTopics),
      successCriteria: clean(input.successCriteria),
      updatedAt: input.updatedAt || Date.now(),
    };
  }

  private hasUsefulContent(input: MeetingBrief | null | undefined): input is MeetingBrief {
    if (!input) return false;
    return Boolean(
      input.title?.trim() ||
      input.objective?.trim() ||
      input.myRole?.trim() ||
      input.participants?.trim() ||
      input.projectContext?.trim() ||
      input.expectedDecisions?.trim() ||
      input.mustAsk?.trim() ||
      input.sensitiveTopics?.trim() ||
      input.successCriteria?.trim(),
    );
  }

  private formatField(label: string, value?: string): string {
    const text = value?.trim();
    return text ? `- ${label}: ${text}` : '';
  }
}
