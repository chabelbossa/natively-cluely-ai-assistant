import { app } from 'electron';
import fs from 'fs';
import path from 'path';

type DebugEventType =
  | 'meeting_start'
  | 'meeting_end'
  | 'raw_transcript'
  | 'route_result'
  | 'canonical_transcript'
  | 'stt_status'
  | 'action_context'
  | 'action_result'
  | 'audio_health';

export interface MeetingDebugEvent {
  type: DebugEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

const MAX_EVENTS_PER_SESSION = 12_000;

export class MeetingDebugRecorder {
  private static instance: MeetingDebugRecorder | null = null;
  private events: MeetingDebugEvent[] = [];
  private sessionId: string | null = null;
  private filePath: string | null = null;
  private enabled: boolean = process.env.NATIVELY_MEETING_DEBUG !== '0';

  static getInstance(): MeetingDebugRecorder {
    if (!MeetingDebugRecorder.instance) {
      MeetingDebugRecorder.instance = new MeetingDebugRecorder();
    }
    return MeetingDebugRecorder.instance;
  }

  startSession(metadata?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.sessionId = `meeting_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.events = [];
    this.filePath = path.join(this.getDebugDir(), `${this.sessionId}.jsonl`);
    this.record('meeting_start', {
      sessionId: this.sessionId,
      metadata: this.safeClone(metadata || {}),
      appVersion: app.getVersion?.() || 'unknown',
    });
    console.log(`[MeetingDebugRecorder] Recording local debug trace: ${this.filePath}`);
  }

  finishSession(payload: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.sessionId) return;
    this.record('meeting_end', {
      sessionId: this.sessionId,
      ...payload,
    });
    this.flush();
    console.log(`[MeetingDebugRecorder] Debug trace saved: ${this.filePath}`);
    this.sessionId = null;
    this.filePath = null;
    this.events = [];
  }

  recordRawTranscript(payload: Record<string, unknown>): void {
    this.record('raw_transcript', payload);
  }

  recordRouteResult(payload: Record<string, unknown>): void {
    this.record('route_result', payload);
  }

  recordCanonicalTranscript(payload: Record<string, unknown>): void {
    this.record('canonical_transcript', payload);
  }

  recordSttStatus(payload: Record<string, unknown>): void {
    this.record('stt_status', payload);
  }

  recordActionContext(payload: Record<string, unknown>): void {
    this.record('action_context', payload);
  }

  recordActionResult(payload: Record<string, unknown>): void {
    this.record('action_result', payload);
  }

  recordAudioHealth(payload: Record<string, unknown>): void {
    this.record('audio_health', payload);
  }

  getCurrentFilePath(): string | null {
    return this.filePath;
  }

  private record(type: DebugEventType, payload: Record<string, unknown>): void {
    if (!this.enabled || !this.sessionId) return;
    this.events.push({
      type,
      timestamp: Date.now(),
      payload: this.safeClone(payload),
    });

    if (this.events.length >= MAX_EVENTS_PER_SESSION) {
      this.flush();
      this.events = [];
    }
  }

  private flush(): void {
    if (!this.filePath || this.events.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const lines = this.events.map((event) => JSON.stringify(event)).join('\n');
      fs.appendFileSync(this.filePath, `${lines}\n`, 'utf8');
    } catch (error: any) {
      console.warn('[MeetingDebugRecorder] Failed to write debug trace:', error?.message || error);
    }
  }

  private getDebugDir(): string {
    try {
      return path.join(app.getPath('userData'), 'meeting-debug');
    } catch {
      return path.join(process.cwd(), '.meeting-debug');
    }
  }

  private safeClone<T>(value: T): T {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}
