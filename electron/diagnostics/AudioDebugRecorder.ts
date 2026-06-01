import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export type AudioDebugTrackName = 'mic' | 'system';

interface AudioDebugTrackManifest {
  path: string;
  chunksPath?: string;
  sampleRate: number;
  bytes: number;
  chunks: number;
  durationMs?: number;
  silent?: boolean;
}

export interface AudioDebugManifest {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  meetingId?: string;
  debugTracePath?: string | null;
  metadata?: Record<string, unknown>;
  tracks: Partial<Record<AudioDebugTrackName, AudioDebugTrackManifest>>;
}

interface AudioDebugRecorderStartOptions {
  metadata?: Record<string, unknown>;
  debugTracePath?: string | null;
}

interface AudioDebugRecorderStopOptions {
  meetingId?: string | null;
  endedAt?: string;
}

interface TrackState {
  name: AudioDebugTrackName;
  path: string;
  sampleRate: number;
  bytes: number;
  chunks: number;
  chunkLogPath: string;
  chunkLogStream: fs.WriteStream;
  audibleChunks: number;
  stream: fs.WriteStream;
  finalized: boolean;
}

const WAV_HEADER_BYTES = 44;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export class AudioDebugRecorder {
  private sessionId: string | null = null;
  private startedAt: string | null = null;
  private sessionDir: string | null = null;
  private manifestPath: string | null = null;
  private debugTracePath: string | null = null;
  private metadata: Record<string, unknown> = {};
  private tracks: Partial<Record<AudioDebugTrackName, TrackState>> = {};
  private active = false;

  start(options: AudioDebugRecorderStartOptions = {}): AudioDebugManifest | null {
    if (this.active) {
      this.abort();
    }

    this.sessionId = `audio_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.startedAt = new Date().toISOString();
    this.sessionDir = path.join(this.getAudioDebugDir(), this.sessionId);
    this.manifestPath = path.join(this.sessionDir, 'manifest.json');
    this.debugTracePath = options.debugTracePath || null;
    this.metadata = this.safeClone(options.metadata || {});
    this.tracks = {};
    this.active = true;

    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.writeManifest();
    console.log(`[AudioDebugRecorder] Recording local audio debug tracks: ${this.sessionDir}`);
    return this.buildManifest();
  }

  writeTrack(trackName: AudioDebugTrackName, chunk: Buffer, sampleRate: number): void {
    if (!this.active || !this.sessionDir || !chunk || chunk.length === 0) return;

    try {
      const track = this.ensureTrack(trackName, sampleRate);
      const now = Date.now();
      const offsetBytes = track.bytes;
      const audible = this.isAudiblePcm16(chunk);
      track.stream.write(chunk);
      track.bytes += chunk.length;
      track.chunks += 1;
      track.chunkLogStream.write(`${JSON.stringify({
        index: track.chunks,
        timestamp: now,
        offsetBytes,
        bytes: chunk.length,
        sampleRate: track.sampleRate,
        audible,
      })}\n`);
      if (audible) {
        track.audibleChunks += 1;
      }
    } catch (error: any) {
      console.warn(`[AudioDebugRecorder] Failed to write ${trackName} chunk:`, error?.message || error);
    }
  }

  async stop(options: AudioDebugRecorderStopOptions = {}): Promise<AudioDebugManifest | null> {
    if (!this.sessionId || !this.manifestPath) return null;

    this.active = false;
    const endedAt = options.endedAt || new Date().toISOString();

    for (const track of Object.values(this.tracks)) {
      if (track && !track.finalized) {
        await this.finalizeTrack(track);
      }
    }

    const manifest = this.buildManifest({
      meetingId: options.meetingId || undefined,
      endedAt,
    });
    this.writeManifest(manifest);
    console.log(`[AudioDebugRecorder] Audio debug manifest saved: ${this.manifestPath}`);
    this.reset();
    return manifest;
  }

  abort(): void {
    this.active = false;
    for (const track of Object.values(this.tracks)) {
      try {
        track?.stream.destroy();
        track?.chunkLogStream.destroy();
      } catch {
        // Best effort cleanup only.
      }
    }
    this.reset();
  }

  getManifestPath(): string | null {
    return this.manifestPath;
  }

  getSessionDir(): string | null {
    return this.sessionDir;
  }

  private ensureTrack(trackName: AudioDebugTrackName, sampleRate: number): TrackState {
    const existing = this.tracks[trackName];
    if (existing) return existing;
    if (!this.sessionDir) throw new Error('Audio debug recorder has no session directory');

    const filePath = path.join(this.sessionDir, `${trackName}.wav`);
    const chunkLogPath = path.join(this.sessionDir, `${trackName}.chunks.jsonl`);
    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    const chunkLogStream = fs.createWriteStream(chunkLogPath, { flags: 'w' });
    stream.write(Buffer.alloc(WAV_HEADER_BYTES));

    const track: TrackState = {
      name: trackName,
      path: filePath,
      sampleRate,
      bytes: 0,
      chunks: 0,
      chunkLogPath,
      chunkLogStream,
      audibleChunks: 0,
      stream,
      finalized: false,
    };

    stream.on('error', (error) => {
      console.warn(`[AudioDebugRecorder] ${trackName}.wav stream error:`, error.message);
    });
    chunkLogStream.on('error', (error) => {
      console.warn(`[AudioDebugRecorder] ${trackName}.chunks.jsonl stream error:`, error.message);
    });

    this.tracks[trackName] = track;
    return track;
  }

  private async finalizeTrack(track: TrackState): Promise<void> {
    await new Promise<void>((resolve) => {
      track.stream.end(resolve);
    });
    await new Promise<void>((resolve) => {
      track.chunkLogStream.end(resolve);
    });

    const header = this.createWavHeader(track.bytes, track.sampleRate);
    const fd = fs.openSync(track.path, 'r+');
    try {
      fs.writeSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    track.finalized = true;
  }

  private createWavHeader(dataBytes: number, sampleRate: number): Buffer {
    const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
    const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
    const header = Buffer.alloc(WAV_HEADER_BYTES);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);

    return header;
  }

  private buildManifest(overrides: Partial<AudioDebugManifest> = {}): AudioDebugManifest {
    const tracks: AudioDebugManifest['tracks'] = {};
    for (const [name, track] of Object.entries(this.tracks) as Array<[AudioDebugTrackName, TrackState]>) {
      tracks[name] = {
        path: track.path,
        chunksPath: track.chunkLogPath,
        sampleRate: track.sampleRate,
        bytes: track.bytes,
        chunks: track.chunks,
        durationMs: Math.round((track.bytes / 2 / Math.max(1, track.sampleRate)) * 1000),
        silent: track.chunks > 0 ? track.audibleChunks === 0 : undefined,
      };
    }

    return {
      sessionId: this.sessionId || 'unknown',
      startedAt: this.startedAt || new Date().toISOString(),
      debugTracePath: this.debugTracePath,
      metadata: this.metadata,
      tracks,
      ...overrides,
    };
  }

  private writeManifest(manifest: AudioDebugManifest = this.buildManifest()): void {
    if (!this.manifestPath) return;
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private isAudiblePcm16(chunk: Buffer): boolean {
    if (!chunk || chunk.length < 2) return false;
    let peak = 0;
    const step = Math.max(2, Math.floor((chunk.length / 2) / 1200) * 2);
    for (let i = 0; i < chunk.length - 1; i += step) {
      peak = Math.max(peak, Math.abs(chunk.readInt16LE(i)));
      if (peak > 80) return true;
    }
    return false;
  }

  private getAudioDebugDir(): string {
    try {
      return path.join(app.getPath('userData'), 'audio-debug');
    } catch {
      return path.join(process.cwd(), '.audio-debug');
    }
  }

  private safeClone<T>(value: T): T {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  private reset(): void {
    this.sessionId = null;
    this.startedAt = null;
    this.sessionDir = null;
    this.manifestPath = null;
    this.debugTracePath = null;
    this.metadata = {};
    this.tracks = {};
    this.active = false;
  }
}
