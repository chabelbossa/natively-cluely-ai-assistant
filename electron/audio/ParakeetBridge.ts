import { EventEmitter } from 'events';
import { app } from 'electron';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

export type ParakeetBridgeEventType = 'ready' | 'partial' | 'final' | 'error' | 'metrics' | 'status';

export interface DiarizationSegment {
    speaker_id: string;
    start_time: number;
    end_time: number;
    quality: number;
}

export interface ParakeetBridgeEvent {
    type: ParakeetBridgeEventType;
    session_id?: string;
    text?: string;
    confidence?: number;
    error?: string;
    state?: string;
    speaker_id?: string;
    diarization_segments?: DiarizationSegment[];
    [key: string]: unknown;
}

export interface ParakeetSessionConfig {
    language?: string;
    channel?: 'system' | 'mic';
}

type PendingReady = {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

export class ParakeetBridge extends EventEmitter {
    private static instance: ParakeetBridge | null = null;

    private process: ChildProcessWithoutNullStreams | null = null;
    private ready = false;
    private starting: Promise<void> | null = null;
    private pendingReady: PendingReady | null = null;
    private readonly activeSessions = new Set<string>();

    static getInstance(): ParakeetBridge {
        if (!ParakeetBridge.instance) {
            ParakeetBridge.instance = new ParakeetBridge();
        }
        return ParakeetBridge.instance;
    }

    async startSession(sessionId: string, config: ParakeetSessionConfig = {}): Promise<void> {
        await this.ensureReady();
        this.activeSessions.add(sessionId);
        this.send({
            type: 'start_session',
            session_id: sessionId,
            language: config.language || 'auto',
            channel: config.channel || 'unknown',
        });
    }

    sendAudio(sessionId: string, pcm16k: Buffer): void {
        if (!this.ready || !this.activeSessions.has(sessionId) || pcm16k.length === 0) return;
        this.send({
            type: 'audio',
            session_id: sessionId,
            audio: pcm16k.toString('base64'),
        });
    }

    speechEnd(sessionId: string): void {
        if (!this.ready || !this.activeSessions.has(sessionId)) return;
        this.send({ type: 'speech_end', session_id: sessionId });
    }

    stopSession(sessionId: string): void {
        if (!this.activeSessions.has(sessionId)) return;
        this.activeSessions.delete(sessionId);
        if (this.ready) {
            this.send({ type: 'stop_session', session_id: sessionId });
        }
    }

    shutdown(): void {
        if (this.process && this.ready) {
            this.send({ type: 'shutdown' });
        }
        this.process?.kill();
        this.process = null;
        this.ready = false;
        this.starting = null;
        this.activeSessions.clear();
    }

    getHelperPath(): string {
        const candidates = [
            process.env.NATIVELY_PARAKEET_HELPER_PATH || '',
            path.join(process.resourcesPath || '', 'helpers', 'parakeet-stt-helper'),
            path.join(app.getAppPath(), 'native-helpers', 'parakeet-stt-helper', 'dist', 'parakeet-stt-helper'),
            path.join(app.getAppPath(), 'native-helpers', 'parakeet-stt-helper', '.build', 'release', 'parakeet-stt-helper'),
        ].filter(Boolean);

        for (const candidate of candidates) {
            if (this.isExecutable(candidate)) return candidate;
        }

        return candidates[0] || 'parakeet-stt-helper';
    }

    static getDefaultModelDirectory(): string {
        return path.join(app.getPath('home'), 'Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3');
    }

    static isDefaultModelAvailable(): boolean {
        const dir = ParakeetBridge.getDefaultModelDirectory();
        const required = [
            'Encoder.mlmodelc',
            'Decoder.mlmodelc',
            'JointDecision.mlmodelc',
            'Preprocessor.mlmodelc',
        ];
        return required.every(name => fs.existsSync(path.join(dir, name)));
    }

    private async ensureReady(): Promise<void> {
        if (this.ready && this.process && !this.process.killed) return;
        if (this.starting) return this.starting;

        this.starting = new Promise<void>((resolve, reject) => {
            const helperPath = this.getHelperPath();
            if (!this.isExecutable(helperPath)) {
                const error = new Error(`Parakeet helper missing or not executable: ${helperPath}`);
                this.starting = null;
                reject(error);
                return;
            }

            console.log(`[ParakeetBridge] Starting helper: ${helperPath}`);
            this.process = spawn(helperPath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    NATIVELY_PARAKEET_NO_DOWNLOAD: '1',
                    // ASR stays cache-only; diarization models are separate and may be
                    // downloaded once so local speaker separation can actually work.
                    NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD: process.env.NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD || '1',
                },
            });

            const timeout = setTimeout(() => {
                const error = new Error('Parakeet helper timed out while warming up');
                this.pendingReady = null;
                this.process?.kill();
                this.process = null;
                this.starting = null;
                reject(error);
            }, 90000);

            this.pendingReady = { resolve, reject, timeout };

            const rl = readline.createInterface({ input: this.process.stdout });
            rl.on('line', line => this.handleLine(line));

            this.process.stderr.on('data', data => {
                const text = String(data).trim();
                if (text) console.warn(`[ParakeetBridge] ${text}`);
            });

            this.process.on('exit', (code, signal) => {
                const message = `Parakeet helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
                console.warn(`[ParakeetBridge] ${message}`);
                this.ready = false;
                this.process = null;
                this.starting = null;
                this.activeSessions.clear();
                if (this.pendingReady) {
                    clearTimeout(this.pendingReady.timeout);
                    this.pendingReady.reject(new Error(message));
                    this.pendingReady = null;
                }
                this.emitBridgeEvent({ type: 'error', error: message });
            });
        });

        return this.starting;
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: ParakeetBridgeEvent;
        try {
            event = JSON.parse(trimmed);
        } catch {
            console.warn(`[ParakeetBridge] Ignoring non-JSON helper output: ${trimmed.slice(0, 200)}`);
            return;
        }

        if (event.type === 'ready') {
            this.ready = true;
            if (this.pendingReady) {
                clearTimeout(this.pendingReady.timeout);
                this.pendingReady.resolve();
                this.pendingReady = null;
            }
            this.emit('ready', event);
            return;
        }

        if (event.type === 'error' && !event.session_id && this.pendingReady) {
            const error = new Error(event.error || 'Parakeet helper failed during warmup');
            clearTimeout(this.pendingReady.timeout);
            this.pendingReady.reject(error);
            this.pendingReady = null;
            this.starting = null;
            this.process?.kill();
            this.process = null;
        }

        this.emitBridgeEvent(event);
        if (event.session_id) {
            this.emit(`session:${event.session_id}`, event);
        }
    }

    private emitBridgeEvent(event: ParakeetBridgeEvent): void {
        if (event.type === 'error' && this.listenerCount('error') === 0) {
            console.warn(`[ParakeetBridge] ${event.error || 'Unknown helper error'}`);
            return;
        }
        this.emit(event.type, event);
    }

    private send(payload: Record<string, unknown>): void {
        if (!this.process || this.process.killed) return;
        this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    private isExecutable(filePath: string): boolean {
        try {
            fs.accessSync(filePath, fs.constants.X_OK);
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    }
}
