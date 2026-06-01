import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { TranscriptRouter } from '../transcript/TranscriptRouter';
import type { CanonicalTranscriptSegment, RawTranscriptSegment, TranscriptRouteResult } from '../transcript/types';

type ReplayTrackName = 'system' | 'mic';

interface AudioDebugManifestTrack {
  path: string;
  sampleRate?: number;
  bytes?: number;
  chunks?: number;
  silent?: boolean;
  chunksPath?: string;
  durationMs?: number;
}

interface AudioDebugManifest {
  sessionId: string;
  meetingId?: string;
  startedAt?: string;
  endedAt?: string;
  tracks?: {
    mic?: AudioDebugManifestTrack;
    system?: AudioDebugManifestTrack;
  };
  metadata?: Record<string, unknown>;
  debugTracePath?: string | null;
}

interface WavData {
  path: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

interface AudioUtterance {
  track: ReplayTrackName;
  startMs: number;
  endMs: number;
  timestamp: number;
  pcm16k: Buffer;
  rms: number;
}

interface HelperEvent {
  type: string;
  session_id?: string;
  text?: string;
  confidence?: number;
  error?: string;
  state?: string;
  processing_ms?: number;
  rtfx?: number;
  speaker_id?: string;
  diarization_segments?: Array<{
    speaker_id: string;
    start_time: number;
    end_time: number;
    quality: number;
  }>;
}

interface ReferenceTurn {
  time: string;
  speaker: string;
  text: string;
}

export interface AudioReplayOptions {
  manifestPath: string;
  referencePath?: string;
  outputDir?: string;
  provider?: 'parakeet';
  helperPath?: string;
  maxSeconds?: number;
  track?: 'both' | ReplayTrackName;
  vadThreshold?: number;
  minSpeechMs?: number;
  endSilenceMs?: number;
  maxUtteranceMs?: number;
  meSpeaker?: string;
  allowDiarizationDownload?: boolean;
  noDiarization?: boolean;
  utteranceTimeoutMs?: number;
  writeFixture?: boolean;
}

export interface AudioReplayReport {
  name: string;
  manifestPath: string;
  outputDir: string;
  provider: string;
  meetingId?: string;
  startedAt?: string;
  endedAt?: string;
  helperPath: string;
  tracks: Record<ReplayTrackName, {
    sourcePath?: string;
    sampleRate?: number;
    bytes?: number;
    chunks?: number;
    silent?: boolean;
    utterances: number;
    transcribed: number;
    empty: number;
    errors: number;
    threshold?: number;
  }>;
  rawEvents: number;
  canonicalSegments: number;
  suppressedSegments: number;
  finalInterlocutorSegments: number;
  meSegments: number;
  duplicateCount: number;
  falseMeEchoCount: number;
  reference?: {
    path: string;
    turns: number;
    speakers: Record<string, number>;
    meSpeaker?: string;
    speakerSeparationAvailable?: boolean;
    meRecall?: number;
    interlocutorRecall?: number;
    overallRecall?: number;
  };
  files: {
    rawEventsJsonl: string;
    routeResultsJsonl: string;
    canonicalTranscriptMd: string;
    reportJson: string;
    reportMd: string;
    fixtureJson?: string;
  };
  warnings: string[];
  failures: string[];
}

interface RouteRecord {
  raw: RawTranscriptSegment;
  result: TranscriptRouteResult;
}

const DEFAULT_MIN_SPEECH_MS = 550;
const DEFAULT_END_SILENCE_MS = 850;
const DEFAULT_MAX_UTTERANCE_MS = 24_000;
const FRAME_MS = 100;
const PRE_ROLL_MS = 200;
const SAMPLE_RATE_16K = 16_000;

export async function runAudioReplay(options: AudioReplayOptions): Promise<AudioReplayReport> {
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = readJson<AudioDebugManifest>(manifestPath);
  const provider = options.provider || 'parakeet';
  if (provider !== 'parakeet') {
    throw new Error(`Unsupported audio replay provider: ${provider}`);
  }

  const outputDir = resolveOutputDir(options.outputDir, manifest);
  fs.mkdirSync(outputDir, { recursive: true });

  const rawEventsPath = path.join(outputDir, 'raw-events.jsonl');
  const routeResultsPath = path.join(outputDir, 'route-results.jsonl');
  const canonicalPath = path.join(outputDir, 'canonical-transcript.md');
  const reportJsonPath = path.join(outputDir, 'report.json');
  const reportMdPath = path.join(outputDir, 'report.md');
  const fixtureJsonPath = options.writeFixture !== false ? path.join(outputDir, 'fixture.json') : undefined;

  const warnings: string[] = [];
  const failures: string[] = [];
  const startedAt = manifest.startedAt;
  const baseTimestamp = startedAt ? Date.parse(startedAt) : Date.now();
  const tracksToRun = getTracksToRun(options.track || 'both');
  const helperPath = resolveParakeetHelperPath(options.helperPath);
  const sourceIsSingleTrackMedia = manifest.metadata?.source === 'media' && !manifest.tracks?.mic;

  if (!helperPath || !isExecutableFile(helperPath)) {
    throw new Error(`Parakeet helper not found or not executable. Set --helper-path or NATIVELY_PARAKEET_HELPER_PATH. Tried: ${helperPath || '(empty)'}`);
  }

  const utterances: AudioUtterance[] = [];
  const trackStats: AudioReplayReport['tracks'] = {
    system: buildEmptyTrackStats(manifest.tracks?.system),
    mic: buildEmptyTrackStats(manifest.tracks?.mic),
  };

  for (const track of tracksToRun) {
    const manifestTrack = manifest.tracks?.[track];
    if (!manifestTrack?.path) {
      warnings.push(`Missing ${track} track in manifest.`);
      continue;
    }

    const wav = readWav(path.resolve(manifestTrack.path));
    const segmented = segmentTrackAudio(track, wav, {
      baseTimestamp,
      maxSeconds: options.maxSeconds,
      vadThreshold: options.vadThreshold,
      minSpeechMs: options.minSpeechMs || DEFAULT_MIN_SPEECH_MS,
      endSilenceMs: options.endSilenceMs || DEFAULT_END_SILENCE_MS,
      maxUtteranceMs: options.maxUtteranceMs || DEFAULT_MAX_UTTERANCE_MS,
    });

    trackStats[track] = {
      ...trackStats[track],
      sourcePath: wav.path,
      sampleRate: wav.sampleRate,
      utterances: segmented.utterances.length,
      threshold: segmented.threshold,
    };

    if (!manifestTrack.chunksPath) {
      warnings.push(`${track}.chunks.jsonl is missing, so replay timestamps are based on WAV duration instead of original wall-clock gaps.`);
    }

    utterances.push(...segmented.utterances);
  }

  utterances.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.track === b.track) return 0;
    return a.track === 'system' ? -1 : 1;
  });

  const helper = new ParakeetReplayClient(helperPath, {
    allowDiarizationDownload: options.allowDiarizationDownload !== false,
    noDiarization: options.noDiarization,
    utteranceTimeoutMs: options.utteranceTimeoutMs,
  });

  const rawEvents: RawTranscriptSegment[] = [];
  const routeRecords: RouteRecord[] = [];
  const canonicalSegments: CanonicalTranscriptSegment[] = [];
  const router = new TranscriptRouter();
  let suppressedSegments = 0;

  try {
    await helper.start();
    await helper.startSession('replay_system', 'system');
    await helper.startSession('replay_mic', 'mic');

    for (let index = 0; index < utterances.length; index++) {
      const utterance = utterances[index];
      const sessionId = utterance.track === 'system' ? 'replay_system' : 'replay_mic';
      logProgress(index, utterances.length, utterance);

      let finalEvent: HelperEvent | null = null;
      try {
        finalEvent = await helper.transcribeUtterance(sessionId, utterance.pcm16k);
      } catch (error: any) {
        trackStats[utterance.track].errors += 1;
        warnings.push(`${utterance.track} utterance ${index + 1} failed: ${error?.message || String(error)}`);
        continue;
      }

      if (!finalEvent?.text?.trim()) {
        trackStats[utterance.track].empty += 1;
        continue;
      }

      trackStats[utterance.track].transcribed += 1;
      const raw = toRawSegment(utterance, finalEvent, rawEvents, provider, isSystemAudioActive(utterance, utterances));
      rawEvents.push(raw);

      const result = router.route(raw);
      routeRecords.push({ raw, result });
      if (result.segment) {
        canonicalSegments.push(result.segment);
      } else {
        suppressedSegments += 1;
      }
    }
  } finally {
    helper.shutdown();
  }

  const duplicateCount = countCrossRoleDuplicates(canonicalSegments);
  const falseMeEchoCount = countFalseMeEchoes(canonicalSegments);
  const finalInterlocutorSegments = canonicalSegments.filter(segment => segment.final && segment.role !== 'me' && segment.role !== 'assistant').length;
  const meSegments = canonicalSegments.filter(segment => segment.final && segment.role === 'me').length;
  const reference = options.referencePath
    ? buildReferenceReport(path.resolve(options.referencePath), canonicalSegments, {
      meSpeaker: options.meSpeaker,
      speakerSeparationAvailable: !sourceIsSingleTrackMedia,
    })
    : undefined;

  if (sourceIsSingleTrackMedia) {
    warnings.push('Media replay uses one mixed audio track; ME/interlocutor separation and ME recall are not evaluated from this source.');
  }

  if (canonicalSegments.length === 0) {
    failures.push('No canonical transcript segments were produced.');
  }
  if (finalInterlocutorSegments === 0) {
    failures.push('No final interlocutor/system segments were produced.');
  }
  if (!options.maxSeconds && reference?.overallRecall !== undefined && reference.overallRecall < 0.35) {
    failures.push(`Reference overall recall is low (${reference.overallRecall.toFixed(3)}).`);
  }

  const report: AudioReplayReport = {
    name: `audio-replay-${manifest.sessionId || path.basename(path.dirname(manifestPath))}`,
    manifestPath,
    outputDir,
    provider,
    meetingId: manifest.meetingId,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    helperPath,
    tracks: trackStats,
    rawEvents: rawEvents.length,
    canonicalSegments: canonicalSegments.length,
    suppressedSegments,
    finalInterlocutorSegments,
    meSegments,
    duplicateCount,
    falseMeEchoCount,
    reference,
    files: {
      rawEventsJsonl: rawEventsPath,
      routeResultsJsonl: routeResultsPath,
      canonicalTranscriptMd: canonicalPath,
      reportJson: reportJsonPath,
      reportMd: reportMdPath,
      fixtureJson: fixtureJsonPath,
    },
    warnings,
    failures,
  };

  writeJsonl(rawEventsPath, rawEvents);
  writeJsonl(routeResultsPath, routeRecords);
  fs.writeFileSync(canonicalPath, renderCanonicalTranscript(canonicalSegments), 'utf8');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMdPath, renderReportMarkdown(report), 'utf8');

  if (fixtureJsonPath) {
    fs.writeFileSync(fixtureJsonPath, `${JSON.stringify({
      name: report.name,
      description: `Generated from ${manifestPath}`,
      thresholds: {
        maxFalseMeRate: 0.05,
        maxDuplicateRate: 0.12,
        minInterlocutorFinals: 1,
      },
      events: rawEvents.map(event => ({
        ...event,
        expectedRole: resolveExpectedReplayRole(event),
      })),
    }, null, 2)}\n`, 'utf8');
  }

  return report;
}

function resolveExpectedReplayRole(event: RawTranscriptSegment): 'interlocutor' | `speaker_${number}` | undefined {
  if (event.channel !== 'system') return undefined;
  if (event.speakerId === undefined) return 'interlocutor';

  const speakerId = Math.max(0, Math.floor(Number(event.speakerId)));
  const provider = String(event.provider || '').toLowerCase();
  const oneBasedSpeakerId = provider === 'local' || provider === 'parakeet'
    ? Math.max(1, speakerId)
    : speakerId + 1;

  return `speaker_${oneBasedSpeakerId}`;
}

function buildEmptyTrackStats(track?: AudioDebugManifestTrack): AudioReplayReport['tracks'][ReplayTrackName] {
  return {
    sourcePath: track?.path,
    sampleRate: track?.sampleRate,
    bytes: track?.bytes,
    chunks: track?.chunks,
    silent: track?.silent,
    utterances: 0,
    transcribed: 0,
    empty: 0,
    errors: 0,
  };
}

function getTracksToRun(track: 'both' | ReplayTrackName): ReplayTrackName[] {
  if (track === 'both') return ['system', 'mic'];
  return [track];
}

function resolveOutputDir(requested: string | undefined, manifest: AudioDebugManifest): string {
  if (requested) return path.resolve(requested);
  const root = path.join(process.cwd(), '.audio-replay');
  const session = manifest.sessionId || `audio_${Date.now()}`;
  return path.join(root, `${session}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readWav(filePath: string): WavData {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a WAV file: ${filePath}`);
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataSize = size;
      break;
    }

    offset = body + size + (size % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate <= 0 || dataStart < 0) {
    throw new Error(`Unsupported WAV format for ${filePath}: format=${audioFormat} channels=${channels} sampleRate=${sampleRate} bits=${bitsPerSample}`);
  }

  const dataEnd = Math.min(buffer.length, dataStart + dataSize);
  let pcm: Buffer = Buffer.from(buffer.subarray(dataStart, dataEnd));
  if (channels > 1) {
    pcm = downmixPcm16ToMono(pcm, channels);
    channels = 1;
  }

  return { path: filePath, sampleRate, channels, bitsPerSample, pcm };
}

function downmixPcm16ToMono(input: Buffer, channels: number): Buffer {
  const frames = Math.floor(input.length / 2 / channels);
  const output = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += input.readInt16LE((frame * channels + channel) * 2);
    }
    const value = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
    output.writeInt16LE(value, frame * 2);
  }
  return output;
}

function segmentTrackAudio(
  track: ReplayTrackName,
  wav: WavData,
  options: {
    baseTimestamp: number;
    maxSeconds?: number;
    vadThreshold?: number;
    minSpeechMs: number;
    endSilenceMs: number;
    maxUtteranceMs: number;
  },
): { utterances: AudioUtterance[]; threshold: number } {
  const frameSamples = Math.max(1, Math.floor(wav.sampleRate * FRAME_MS / 1000));
  const frameBytes = frameSamples * 2;
  const maxBytes = options.maxSeconds
    ? Math.min(wav.pcm.length, Math.floor(options.maxSeconds * wav.sampleRate) * 2)
    : wav.pcm.length;
  const rmsFrames: Array<{ offset: number; rms: number }> = [];

  for (let offset = 0; offset + 2 <= maxBytes; offset += frameBytes) {
    const end = Math.min(maxBytes, offset + frameBytes);
    rmsFrames.push({ offset, rms: computeRms(wav.pcm.subarray(offset, end)) });
  }

  const threshold = options.vadThreshold || inferVadThreshold(rmsFrames.map(frame => frame.rms), track);
  const minSpeechBytes = Math.floor(options.minSpeechMs * wav.sampleRate / 1000) * 2;
  const endSilenceBytes = Math.floor(options.endSilenceMs * wav.sampleRate / 1000) * 2;
  const maxUtteranceBytes = Math.floor(options.maxUtteranceMs * wav.sampleRate / 1000) * 2;
  const preRollBytes = Math.floor(PRE_ROLL_MS * wav.sampleRate / 1000) * 2;
  const utterances: AudioUtterance[] = [];
  let speechStart: number | null = null;
  let lastSpeechEnd = 0;

  const closeUtterance = (endOffset: number) => {
    if (speechStart === null) return;
    const start = Math.max(0, speechStart - preRollBytes);
    const end = Math.min(maxBytes, Math.max(endOffset, lastSpeechEnd));
    if (end - speechStart >= minSpeechBytes) {
      const pcm = wav.pcm.subarray(start, end);
      const segmentRms = computeRms(pcm);
      if (segmentRms < threshold) {
        speechStart = null;
        lastSpeechEnd = 0;
        return;
      }
      const pcm16k = resamplePcm16Mono(pcm, wav.sampleRate, SAMPLE_RATE_16K);
      const startMs = bytesToMs(start, wav.sampleRate);
      const endMs = bytesToMs(end, wav.sampleRate);
      utterances.push({
        track,
        startMs,
        endMs,
        timestamp: options.baseTimestamp + Math.round(startMs),
        pcm16k,
        rms: segmentRms,
      });
    }
    speechStart = null;
    lastSpeechEnd = 0;
  };

  for (const frame of rmsFrames) {
    const audible = frame.rms >= threshold;
    const frameEnd = Math.min(maxBytes, frame.offset + frameBytes);

    if (audible) {
      if (speechStart === null) speechStart = frame.offset;
      lastSpeechEnd = frameEnd;
    }

    if (speechStart !== null) {
      const silenceBytes = frameEnd - lastSpeechEnd;
      const utteranceBytes = frameEnd - speechStart;
      if (silenceBytes >= endSilenceBytes || utteranceBytes >= maxUtteranceBytes) {
        closeUtterance(frameEnd);
      }
    }
  }

  closeUtterance(maxBytes);
  return { utterances, threshold };
}

function computeRms(buffer: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sum += sample * sample;
    count++;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

function inferVadThreshold(values: number[], track: ReplayTrackName): number {
  const audible = values.filter(value => value > 0).sort((a, b) => a - b);
  if (audible.length === 0) return track === 'system' ? 60 : 260;
  const q10 = audible[Math.floor(audible.length * 0.1)] || audible[0];
  const q50 = audible[Math.floor(audible.length * 0.5)] || q10;
  const base = track === 'system'
    ? Math.max(55, Math.min(q50 * 0.45, q10 * 2.8))
    : Math.max(260, Math.min(q50 * 0.7, q10 * 3.5));
  return Math.max(40, Math.min(1500, Math.round(base)));
}

function bytesToMs(byteOffset: number, sampleRate: number): number {
  return (byteOffset / 2 / sampleRate) * 1000;
}

function resamplePcm16Mono(input: Buffer, inputRate: number, outputRate: number): Buffer {
  if (inputRate === outputRate) return Buffer.from(input);
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples <= 0) return Buffer.alloc(0);
  const outputSamples = Math.max(1, Math.floor(inputSamples * outputRate / inputRate));
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const sourceIndex = Math.min(inputSamples - 1, Math.floor(i * inputRate / outputRate));
    output.writeInt16LE(input.readInt16LE(sourceIndex * 2), i * 2);
  }
  return output;
}

function toRawSegment(
  utterance: AudioUtterance,
  event: HelperEvent,
  previous: RawTranscriptSegment[],
  provider: string,
  systemAudioActive: boolean,
): RawTranscriptSegment {
  const speakerId = parseSpeakerId(event.speaker_id);
  return {
    channel: utterance.track,
    provider,
    speaker: utterance.track === 'system'
      ? speakerId === undefined ? 'interviewer' : `locuteur_${speakerId}`
      : 'user',
    text: event.text || '',
    timestamp: utterance.timestamp,
    final: true,
    confidence: event.confidence ?? 0.9,
    speakerId,
    diarized: utterance.track === 'system' && speakerId !== undefined,
    systemAudioActive: utterance.track === 'mic' ? systemAudioActive : undefined,
    systemAudioLevel: utterance.track === 'system' ? { rms: utterance.rms, peak: 0 } : null,
    micGateActive: utterance.track === 'mic' ? systemAudioActive : undefined,
  };
}

function parseSpeakerId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(?:speaker_)?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function isSystemAudioActive(utterance: AudioUtterance, utterances: AudioUtterance[]): boolean {
  if (utterance.track !== 'mic') return false;
  return utterances.some(candidate => (
    candidate.track === 'system' &&
    candidate.startMs <= utterance.endMs + 1500 &&
    candidate.endMs >= utterance.startMs - 1500
  ));
}

class ParakeetReplayClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readonly listeners = new Map<string, Array<(event: HelperEvent) => void>>();

  constructor(
    private readonly helperPath: string,
    private readonly options: { allowDiarizationDownload: boolean; noDiarization?: boolean; utteranceTimeoutMs?: number },
  ) {}

  async start(): Promise<void> {
    if (this.ready) return;
    this.process = spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NATIVELY_PARAKEET_NO_DOWNLOAD: '1',
        NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD: this.options.allowDiarizationDownload ? '1' : '0',
        ...(this.options.noDiarization ? { NATIVELY_NO_DIARIZATION: '1' } : {}),
      },
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', line => this.handleLine(line));
    this.process.stderr.on('data', data => {
      const text = String(data).trim();
      if (text) console.warn(`[audio-replay:parakeet] ${text}`);
    });

    this.process.on('exit', (code, signal) => {
      this.ready = false;
      this.emitLocal({ type: 'error', error: `Parakeet helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}` });
    });

    await this.waitForGlobalEvent(event => event.type === 'ready', 120_000, 'Parakeet helper did not become ready');
    this.ready = true;
  }

  async startSession(sessionId: string, channel: ReplayTrackName): Promise<void> {
    this.send({ type: 'start_session', session_id: sessionId, channel });
    await this.waitForSessionEvent(sessionId, event => event.type === 'status' && event.state === 'streaming', 10_000, `Session ${sessionId} did not start`);
  }

  async transcribeUtterance(sessionId: string, pcm16k: Buffer): Promise<HelperEvent | null> {
    if (pcm16k.length === 0) return null;
    const finalPromise = this.waitForSessionEvent(
      sessionId,
      event => event.type === 'final' || event.type === 'error',
      this.options.utteranceTimeoutMs || 35_000,
      `Timed out waiting for final transcript from ${sessionId}`,
    );

    const chunkBytes = SAMPLE_RATE_16K * 2 * 0.5;
    for (let offset = 0; offset < pcm16k.length; offset += chunkBytes) {
      const chunk = pcm16k.subarray(offset, Math.min(pcm16k.length, offset + chunkBytes));
      this.send({ type: 'audio', session_id: sessionId, audio: chunk.toString('base64') });
    }
    this.send({ type: 'speech_end', session_id: sessionId });

    const event = await finalPromise;
    if (event.type === 'error') {
      throw new Error(event.error || `Parakeet session ${sessionId} failed`);
    }
    return event;
  }

  shutdown(): void {
    try {
      this.send({ type: 'shutdown' });
    } catch {
      // Ignore shutdown errors.
    }
    this.process?.kill();
    this.process = null;
    this.ready = false;
    this.listeners.clear();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.process || this.process.killed) {
      throw new Error('Parakeet helper is not running');
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: HelperEvent;
    try {
      event = JSON.parse(trimmed) as HelperEvent;
    } catch {
      console.warn(`[audio-replay:parakeet] Non-JSON helper output: ${trimmed.slice(0, 200)}`);
      return;
    }
    this.emitLocal(event);
  }

  private emitLocal(event: HelperEvent): void {
    const sessionKey = event.session_id ? `session:${event.session_id}` : 'global';
    for (const key of [sessionKey, 'global']) {
      const callbacks = this.listeners.get(key) || [];
      for (const callback of callbacks) callback(event);
    }
  }

  private waitForGlobalEvent(predicate: (event: HelperEvent) => boolean, timeoutMs: number, timeoutMessage: string): Promise<HelperEvent> {
    return this.waitForKey('global', predicate, timeoutMs, timeoutMessage);
  }

  private waitForSessionEvent(sessionId: string, predicate: (event: HelperEvent) => boolean, timeoutMs: number, timeoutMessage: string): Promise<HelperEvent> {
    return this.waitForKey(`session:${sessionId}`, predicate, timeoutMs, timeoutMessage);
  }

  private waitForKey(key: string, predicate: (event: HelperEvent) => boolean, timeoutMs: number, timeoutMessage: string): Promise<HelperEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      const callback = (event: HelperEvent) => {
        if (event.type === 'error' && !event.session_id && key !== 'global') {
          cleanup();
          reject(new Error(event.error || 'Parakeet helper failed'));
          return;
        }
        if (!predicate(event)) return;
        cleanup();
        resolve(event);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const callbacks = this.listeners.get(key) || [];
        this.listeners.set(key, callbacks.filter(item => item !== callback));
      };

      const callbacks = this.listeners.get(key) || [];
      callbacks.push(callback);
      this.listeners.set(key, callbacks);
    });
  }
}

function resolveParakeetHelperPath(requested?: string): string {
  const candidates = [
    requested || '',
    process.env.NATIVELY_PARAKEET_HELPER_PATH || '',
    path.join(process.cwd(), 'native-helpers', 'parakeet-stt-helper', 'dist', 'parakeet-stt-helper'),
    path.join(process.cwd(), 'native-helpers', 'parakeet-stt-helper', '.build', 'release', 'parakeet-stt-helper'),
    '/Applications/Natively.app/Contents/Resources/helpers/parakeet-stt-helper',
  ].filter(Boolean);

  return candidates.find(isExecutableFile) || candidates[0] || '';
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function logProgress(index: number, total: number, utterance: AudioUtterance): void {
  const current = index + 1;
  if (current <= 5 || current === total || current % 10 === 0) {
    const start = (utterance.startMs / 1000).toFixed(1);
    const end = (utterance.endMs / 1000).toFixed(1);
    console.log(`[audio-replay] ${current}/${total} ${utterance.track} ${start}s-${end}s rms=${utterance.rms.toFixed(0)}`);
  }
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function renderCanonicalTranscript(segments: CanonicalTranscriptSegment[]): string {
  const lines = ['# Canonical Transcript', ''];
  for (const segment of segments) {
    if (!segment.final) continue;
    const label = segment.role === 'me' ? 'ME' : segment.role.toUpperCase();
    const flags = segment.qualityFlags.length ? ` _${segment.qualityFlags.join(', ')}_` : '';
    lines.push(`- **${label}** [${new Date(segment.timestamp).toISOString()}]${flags}: ${segment.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderReportMarkdown(report: AudioReplayReport): string {
  const lines = [
    `# Audio Replay Report`,
    '',
    `- Name: ${report.name}`,
    `- Provider: ${report.provider}`,
    `- Meeting ID: ${report.meetingId || '(none)'}`,
    `- Canonical segments: ${report.canonicalSegments}`,
    `- Suppressed segments: ${report.suppressedSegments}`,
    `- Final interlocutor segments: ${report.finalInterlocutorSegments}`,
    `- ME segments: ${report.meSegments}`,
    `- Cross-role duplicates: ${report.duplicateCount}`,
    `- False ME echo suspects: ${report.falseMeEchoCount}`,
    '',
    `## Tracks`,
    '',
    `| Track | Utterances | Transcribed | Empty | Errors | Threshold |`,
    `| --- | ---: | ---: | ---: | ---: | ---: |`,
  ];

  for (const track of ['system', 'mic'] as ReplayTrackName[]) {
    const stats = report.tracks[track];
    lines.push(`| ${track} | ${stats.utterances} | ${stats.transcribed} | ${stats.empty} | ${stats.errors} | ${stats.threshold ?? ''} |`);
  }

  if (report.reference) {
    lines.push(
      '',
      `## Reference`,
      '',
      `- Turns: ${report.reference.turns}`,
      `- ME speaker: ${report.reference.meSpeaker || '(not inferred)'}`,
      `- Overall recall: ${formatPercent(report.reference.overallRecall)}`,
      `- ME recall: ${formatPercent(report.reference.meRecall)}`,
      `- Interlocutor recall: ${formatPercent(report.reference.interlocutorRecall)}`,
    );
  }

  if (report.warnings.length) {
    lines.push('', '## Warnings', '', ...report.warnings.map(item => `- ${item}`));
  }

  if (report.failures.length) {
    lines.push('', '## Failures', '', ...report.failures.map(item => `- ${item}`));
  }

  lines.push('', '## Files', '');
  for (const [key, value] of Object.entries(report.files)) {
    if (value) lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatPercent(value?: number): string {
  return value === undefined ? '(n/a)' : `${Math.round(value * 1000) / 10}%`;
}

function countCrossRoleDuplicates(segments: CanonicalTranscriptSegment[]): number {
  let duplicates = 0;
  const finals = segments.filter(segment => segment.final);
  for (let i = 0; i < finals.length; i++) {
    for (let j = 0; j < i; j++) {
      if (finals[i].role === finals[j].role) continue;
      if (Math.abs(finals[i].timestamp - finals[j].timestamp) > 15_000) continue;
      if (textSimilarity(finals[i].text, finals[j].text) >= 0.72) {
        duplicates++;
        break;
      }
    }
  }
  return duplicates;
}

function countFalseMeEchoes(segments: CanonicalTranscriptSegment[]): number {
  const system = segments.filter(segment => segment.final && segment.source === 'system');
  return segments.filter(segment => (
    segment.final &&
    segment.role === 'me' &&
    system.some(candidate => Math.abs(segment.timestamp - candidate.timestamp) <= 15_000 && textSimilarity(segment.text, candidate.text) >= 0.55)
  )).length;
}

function buildReferenceReport(
  referencePath: string,
  segments: CanonicalTranscriptSegment[],
  options: { meSpeaker?: string; speakerSeparationAvailable?: boolean } = {},
): AudioReplayReport['reference'] {
  const turns = parseReferenceTranscript(referencePath);
  const speakers: Record<string, number> = {};
  for (const turn of turns) speakers[turn.speaker] = (speakers[turn.speaker] || 0) + 1;
  const inferredMeSpeaker = options.meSpeaker || inferMeSpeaker(Object.keys(speakers));
  const speakerSeparationAvailable = options.speakerSeparationAvailable !== false;

  const referenceMe = turns
    .filter(turn => inferredMeSpeaker && normalizeSpeaker(turn.speaker) === normalizeSpeaker(inferredMeSpeaker))
    .map(turn => turn.text)
    .join(' ');
  const referenceInterlocutor = turns
    .filter(turn => !inferredMeSpeaker || normalizeSpeaker(turn.speaker) !== normalizeSpeaker(inferredMeSpeaker))
    .map(turn => turn.text)
    .join(' ');
  const canonicalMe = segments.filter(segment => segment.final && segment.role === 'me').map(segment => segment.text).join(' ');
  const canonicalInterlocutor = segments.filter(segment => segment.final && segment.role !== 'me' && segment.role !== 'assistant').map(segment => segment.text).join(' ');
  const referenceAll = turns.map(turn => turn.text).join(' ');
  const canonicalAll = segments.filter(segment => segment.final).map(segment => segment.text).join(' ');

  return {
    path: referencePath,
    turns: turns.length,
    speakers,
    meSpeaker: inferredMeSpeaker,
    speakerSeparationAvailable,
    meRecall: speakerSeparationAvailable && referenceMe ? wordRecall(referenceMe, canonicalMe) : undefined,
    interlocutorRecall: referenceInterlocutor ? wordRecall(referenceInterlocutor, canonicalInterlocutor) : undefined,
    overallRecall: referenceAll ? wordRecall(referenceAll, canonicalAll) : undefined,
  };
}

function parseReferenceTranscript(referencePath: string): ReferenceTurn[] {
  const text = fs.readFileSync(referencePath, 'utf8');
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const turns: ReferenceTurn[] = [];
  let index = 0;

  while (index < lines.length) {
    const time = lines[index];
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time)) {
      index++;
      continue;
    }

    const speaker = lines[index + 1] || '';
    index += 2;
    const body: string[] = [];
    while (index < lines.length && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(lines[index])) {
      if (lines[index]) body.push(lines[index]);
      index++;
    }
    if (speaker && body.length) {
      turns.push({ time, speaker, text: body.join(' ') });
    }
  }

  return turns;
}

function inferMeSpeaker(speakers: string[]): string | undefined {
  const known = speakers.find(speaker => normalizeSpeaker(speaker).includes('chabel'));
  return known || undefined;
}

function normalizeSpeaker(speaker: string): string {
  return normalizeText(speaker);
}

function wordRecall(reference: string, candidate: string): number {
  const referenceWords = normalizeText(reference).split(' ').filter(word => word.length >= 3);
  const candidateWords = new Set(normalizeText(candidate).split(' ').filter(word => word.length >= 3));
  if (!referenceWords.length) return 0;
  let matched = 0;
  for (const word of referenceWords) {
    if (candidateWords.has(word)) matched++;
  }
  return matched / referenceWords.length;
}

function textSimilarity(a: string, b: string): number {
  const aWords = normalizeText(a).split(' ').filter(Boolean);
  const bWords = normalizeText(b).split(' ').filter(Boolean);
  if (!aWords.length || !bWords.length) return 0;
  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  let intersection = 0;
  for (const word of aSet) {
    if (bSet.has(word)) intersection++;
  }
  return intersection / new Set([...aSet, ...bSet]).size;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findLatestAudioDebugManifest(rootDir?: string): string | null {
  const roots = [
    rootDir,
    path.join(os.homedir(), 'Library/Application Support/natively/audio-debug'),
    path.join(process.cwd(), '.audio-debug'),
  ].filter(Boolean) as string[];

  const manifests: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, 'manifest.json');
      if (!fs.existsSync(candidate)) continue;
      manifests.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
    }
  }

  manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return manifests[0]?.path || null;
}
