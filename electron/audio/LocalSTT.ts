/**
 * LocalSTT - OpenAI-compatible local Speech-to-Text adapter.
 *
 * This provider keeps Natively's existing audio capture pipeline intact and
 * sends flushed WAV chunks either to whisper.cpp directly or to a user-
 * configured local endpoint, typically:
 *   http://127.0.0.1:8000/v1/audio/transcriptions
 *
 * The direct whisper.cpp path reuses an existing ggml .bin model. Other local
 * engines remain supported through the OpenAI-compatible endpoint mode.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import FormData from 'form-data';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { TranscriptPostProcessor } from './TranscriptPostProcessor';

export const DEFAULT_LOCAL_STT_ENDPOINT = 'http://127.0.0.1:8000/v1/audio/transcriptions';
export const DEFAULT_LOCAL_STT_MODEL = 'whisper-large-v3-turbo';
export const DEFAULT_LOCAL_STT_WHISPER_CPP_MODEL = 'ggml-large-v3-turbo-q5_0';
export type LocalSttMode = 'server' | 'whisper_cpp' | 'parakeet_stream';

export interface LocalSttConfig {
    mode?: LocalSttMode;
    endpoint?: string;
    model?: string;
    whisperCppModelPath?: string;
    whisperCppExecutablePath?: string;
    glossary?: string;
}

const execFileAsync = promisify(execFile);

const MIN_SPEECH_DURATION_MS = 650;
const SAFETY_NET_INTERVAL_MS = 4000;
const SILENCE_RMS_THRESHOLD = 80;

export class LocalSTT extends EventEmitter {
    private mode: LocalSttMode;
    private endpoint: string;
    private model: string;
    private whisperCppModelPath: string;
    private whisperCppExecutablePath: string;
    private postProcessor: TranscriptPostProcessor;
    private languageKey = 'auto';

    private chunks: Buffer[] = [];
    private totalBufferedBytes = 0;
    private safetyNetTimer: NodeJS.Timeout | null = null;
    private isActive = false;
    private isUploading = false;
    private flushPending = false;

    private sampleRate = 16000;
    private numChannels = 1;
    private bitsPerSample = 16;

    constructor(config?: LocalSttConfig | string, model?: string) {
        super();
        const normalized = LocalSTT.normalizeConfig(config, model);
        this.mode = normalized.mode;
        this.endpoint = normalized.endpoint;
        this.model = normalized.model;
        this.whisperCppModelPath = normalized.whisperCppModelPath;
        this.whisperCppExecutablePath = normalized.whisperCppExecutablePath;
        this.postProcessor = new TranscriptPostProcessor({ glossary: normalized.glossary });
        console.log(`[LocalSTT] Initialized mode=${this.mode}, endpoint=${this.endpoint}, model=${this.model || '(none)'}, whisperCppModel=${this.whisperCppModelPath || '(none)'}`);
    }

    public static normalizeEndpoint(endpoint?: string): string {
        const raw = (endpoint || DEFAULT_LOCAL_STT_ENDPOINT).trim() || DEFAULT_LOCAL_STT_ENDPOINT;

        try {
            const url = new URL(raw);
            const normalizedPath = url.pathname.replace(/\/+$/, '');
            if (!normalizedPath || normalizedPath === '/') {
                url.pathname = '/v1/audio/transcriptions';
            } else if (normalizedPath === '/v1') {
                url.pathname = '/v1/audio/transcriptions';
            }
            return url.toString();
        } catch {
            return raw;
        }
    }

    public static normalizeConfig(config?: LocalSttConfig | string, model?: string): Required<LocalSttConfig> {
        const rawConfig: LocalSttConfig = typeof config === 'string'
            ? { endpoint: config, model }
            : (config || {});

        const detectedModelPath = LocalSTT.detectDefaultWhisperCppModelPath();
        const whisperCppModelPath = (rawConfig.whisperCppModelPath || detectedModelPath || '').trim();
        const mode = rawConfig.mode || (whisperCppModelPath ? 'whisper_cpp' : 'server');

        return {
            mode,
            endpoint: LocalSTT.normalizeEndpoint(rawConfig.endpoint),
            model: (rawConfig.model || DEFAULT_LOCAL_STT_MODEL).trim(),
            whisperCppModelPath,
            whisperCppExecutablePath: (rawConfig.whisperCppExecutablePath || LocalSTT.detectWhisperCppExecutablePath() || '').trim(),
            glossary: (rawConfig.glossary || '').trim(),
        };
    }

    public static detectWhisperCppExecutablePath(): string {
        const pathCandidates = [
            '/opt/homebrew/bin/whisper-cli',
            '/usr/local/bin/whisper-cli',
        ];

        for (const candidate of pathCandidates) {
            if (LocalSTT.isExecutableFile(candidate)) return candidate;
        }

        for (const directory of (process.env.PATH || '').split(path.delimiter)) {
            const candidate = path.join(directory, 'whisper-cli');
            if (LocalSTT.isExecutableFile(candidate)) return candidate;
        }

        return '';
    }

    public static detectDefaultWhisperCppModelPath(): string {
        const home = os.homedir();
        const modelDirs = [
            path.join(home, 'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels'),
            path.join(home, 'Library/Application Support/com.voiceinkapp.transcribe/WhisperModels'),
        ];

        const preferredNames = [
            `${DEFAULT_LOCAL_STT_WHISPER_CPP_MODEL}.bin`,
            'ggml-large-v3-turbo.bin',
            'ggml-large-v3.bin',
        ];

        for (const dir of modelDirs) {
            for (const name of preferredNames) {
                const candidate = path.join(dir, name);
                if (LocalSTT.isReadableFile(candidate)) return candidate;
            }
        }

        for (const dir of modelDirs) {
            try {
                const modelFiles = fs.readdirSync(dir)
                    .filter(name => name.endsWith('.bin'))
                    .sort((a, b) => {
                        const score = (name: string) => name.includes('turbo') ? 0 : name.includes('large') ? 1 : 2;
                        return score(a) - score(b) || a.localeCompare(b);
                    });
                if (modelFiles[0]) return path.join(dir, modelFiles[0]);
            } catch {
                // Ignore missing app support folders.
            }
        }

        return '';
    }

    public static isReadableFile(filePath?: string): boolean {
        if (!filePath) return false;
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    public static isExecutableFile(filePath?: string): boolean {
        if (!filePath) return false;
        try {
            fs.accessSync(filePath, fs.constants.X_OK);
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    public setConfig(config?: LocalSttConfig | string, model?: string): void {
        const normalized = LocalSTT.normalizeConfig(config, model);
        this.mode = normalized.mode;
        this.endpoint = normalized.endpoint;
        this.model = normalized.model;
        this.whisperCppModelPath = normalized.whisperCppModelPath;
        this.whisperCppExecutablePath = normalized.whisperCppExecutablePath;
        this.postProcessor = new TranscriptPostProcessor({ glossary: normalized.glossary });
        console.log(`[LocalSTT] Config updated mode=${this.mode}, endpoint=${this.endpoint}, model=${this.model || '(none)'}, whisperCppModel=${this.whisperCppModelPath || '(none)'}`);
    }

    public setCredentials(_keyFilePath: string): void {
        console.log('[LocalSTT] setCredentials called (no-op for local provider)');
    }

    public setRecognitionLanguage(key: string): void {
        this.languageKey = key || 'auto';
        console.log(`[LocalSTT] Recognition language set to: ${this.languageKey}`);
    }

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        console.log(`[LocalSTT] Updating sample rate to ${rate}Hz`);
        this.sampleRate = rate;
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        console.log(`[LocalSTT] Updating channel count to ${count}`);
        this.numChannels = count;
    }

    public start(): void {
        if (this.isActive) return;

        console.log('[LocalSTT] Starting...');
        this.isActive = true;
        this.chunks = [];
        this.totalBufferedBytes = 0;
        this.safetyNetTimer = setInterval(() => {
            this.flushAndUpload();
        }, SAFETY_NET_INTERVAL_MS);
    }

    public stop(): void {
        if (!this.isActive) return;

        console.log('[LocalSTT] Stopping...');
        this.isActive = false;
        if (this.safetyNetTimer) {
            clearInterval(this.safetyNetTimer);
            this.safetyNetTimer = null;
        }
        this.flushAndUpload();
    }

    public finalize(): void {
        this.flushAndUpload();
    }

    public write(audioData: Buffer): void {
        if (!this.isActive) return;
        this.chunks.push(audioData);
        this.totalBufferedBytes += audioData.length;
    }

    public notifySpeechEnded(): void {
        if (!this.isActive) return;
        console.log('[LocalSTT] Speech ended detected by native VAD - flushing buffer');
        this.flushAndUpload();
    }

    private async flushAndUpload(): Promise<void> {
        if (this.chunks.length === 0 || this.totalBufferedBytes < this.getMinBufferedBytes()) return;

        if (this.isUploading) {
            this.flushPending = true;
            return;
        }

        if (this.safetyNetTimer) {
            clearInterval(this.safetyNetTimer);
            this.safetyNetTimer = setInterval(() => {
                this.flushAndUpload();
            }, SAFETY_NET_INTERVAL_MS);
        }

        const currentChunks = this.chunks;
        this.chunks = [];
        this.totalBufferedBytes = 0;

        const rawPcm = Buffer.concat(currentChunks);
        if (this.isSilent(rawPcm)) {
            if (Math.random() < 0.1) {
                console.log(`[LocalSTT] Skipping silent buffer (${rawPcm.length} bytes)`);
            }
            return;
        }

        const targetRate = 16_000;
        const pcm16k = this.sampleRate === targetRate && this.numChannels === 1
            ? rawPcm
            : this.resampleTo16kHz(rawPcm);
        const wavBuffer = this.addWavHeader(pcm16k, targetRate);

        this.isUploading = true;
        try {
            const transcript = await this.transcribeWav(wavBuffer);
            const processed = this.postProcessor.process(transcript, { final: true });
            const cleanedTranscript = processed.text;
            if (cleanedTranscript && !processed.dropped) {
                console.log(`[LocalSTT] Transcript: "${cleanedTranscript.substring(0, 60)}..."`);
                this.emit('transcript', {
                    text: cleanedTranscript,
                    isFinal: true,
                    confidence: 1.0,
                });
            } else if (transcript.trim()) {
                console.log(`[LocalSTT] Dropping transcript (${processed.reason || 'filtered'}): "${transcript.trim().substring(0, 60)}..."`);
            }
        } catch (err) {
            console.error('[LocalSTT] Upload error:', err);
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.isUploading = false;
            if (this.flushPending) {
                this.flushPending = false;
                this.flushAndUpload();
            }
        }
    }

    private async transcribeWav(wavBuffer: Buffer): Promise<string> {
        if (this.mode === 'whisper_cpp') {
            return this.transcribeWithWhisperCpp(wavBuffer);
        }
        if (this.mode === 'parakeet_stream') {
            throw new Error('Parakeet realtime mode is handled by ParakeetStreamingSTT, not LocalSTT.');
        }
        return this.uploadMultipart(wavBuffer);
    }

    private async transcribeWithWhisperCpp(wavBuffer: Buffer): Promise<string> {
        if (!LocalSTT.isExecutableFile(this.whisperCppExecutablePath)) {
            throw new Error(`whisper-cli not found or not executable: ${this.whisperCppExecutablePath || '(empty)'}`);
        }
        if (!LocalSTT.isReadableFile(this.whisperCppModelPath)) {
            throw new Error(`Whisper.cpp model not found or not readable: ${this.whisperCppModelPath || '(empty)'}`);
        }

        const tempPath = path.join(os.tmpdir(), `natively-local-stt-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
        fs.writeFileSync(tempPath, wavBuffer);

        try {
            const args = [
                '-m', this.whisperCppModelPath,
                '-f', tempPath,
                '-nt',
                '-np',
                '-sns',
                '-l', this.getWhisperCppLanguage(),
            ];
            const { stdout } = await execFileAsync(this.whisperCppExecutablePath, args, {
                timeout: 120000,
                maxBuffer: 1024 * 1024,
            });
            return this.cleanWhisperCppOutput(stdout);
        } finally {
            fs.rmSync(tempPath, { force: true });
        }
    }

    private async uploadMultipart(wavBuffer: Buffer): Promise<string> {
        const form = new FormData();
        form.append('file', wavBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav',
        });

        if (this.model) {
            form.append('model', this.model);
        }

        const language = this.getIsoLanguage();
        if (language) {
            form.append('language', language);
        }
        form.append('response_format', 'json');

        const response = await axios.post(this.endpoint, form, {
            headers: form.getHeaders(),
            timeout: 60000,
        });

        return this.extractTranscript(response.data);
    }

    private extractTranscript(data: any): string {
        if (typeof data === 'string') return data;
        if (!data || typeof data !== 'object') return '';
        return data.text
            || data.transcript
            || data.transcription
            || data.result
            || data.results?.[0]?.alternatives?.[0]?.transcript
            || data.segments?.map((segment: any) => segment?.text).filter(Boolean).join(' ')
            || '';
    }

    private getIsoLanguage(): string | undefined {
        if (!this.languageKey || this.languageKey === 'auto') return undefined;
        return RECOGNITION_LANGUAGES[this.languageKey]?.iso639;
    }

    private getWhisperCppLanguage(): string {
        if (!this.languageKey || this.languageKey === 'auto') return 'auto';
        const language = RECOGNITION_LANGUAGES[this.languageKey]?.iso639 || 'auto';
        // The default app language is english-us, which makes French local dictation
        // degrade into common hallucinations ("thank you", "hello"). Let whisper.cpp
        // auto-detect unless the user explicitly chooses a non-English language.
        return language === 'en' ? 'auto' : language;
    }

    private cleanWhisperCppOutput(stdout: string): string {
        return stdout
            .split('\n')
            .map(line => line.replace(/\[[^\]]+\]\s*/g, '').trim())
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    private resampleTo16kHz(raw: Buffer): Buffer {
        const targetRate = 16_000;
        const numSamples = Math.floor(raw.length / 2);
        const inputS16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            inputS16[i] = raw.readInt16LE(i * 2);
        }

        if (this.sampleRate === targetRate && this.numChannels === 1) {
            return Buffer.from(inputS16.buffer);
        }

        let monoS16: Int16Array;
        if (this.numChannels > 1) {
            const monoLen = Math.floor(inputS16.length / this.numChannels);
            monoS16 = new Int16Array(monoLen);
            for (let i = 0; i < monoLen; i++) {
                let sum = 0;
                for (let c = 0; c < this.numChannels; c++) {
                    sum += inputS16[i * this.numChannels + c];
                }
                monoS16[i] = Math.round(sum / this.numChannels);
            }
        } else {
            monoS16 = inputS16;
        }

        if (this.sampleRate === targetRate) {
            return Buffer.from(monoS16.buffer);
        }

        const factor = this.sampleRate / targetRate;
        const outLen = Math.floor(monoS16.length / factor);
        const outS16 = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            outS16[i] = monoS16[Math.floor(i * factor)];
        }
        return Buffer.from(outS16.buffer);
    }

    private isSilent(pcmBuffer: Buffer): boolean {
        let sum = 0;
        const step = 20;
        let count = 0;

        for (let i = 0; i < pcmBuffer.length - 1; i += 2 * step) {
            const sample = pcmBuffer.readInt16LE(i);
            sum += sample * sample;
            count++;
        }

        if (count === 0) return true;
        const rms = Math.sqrt(sum / count);
        return rms < SILENCE_RMS_THRESHOLD;
    }

    private getMinBufferedBytes(): number {
        const bytesPerSecond = this.sampleRate * this.numChannels * (this.bitsPerSample / 8);
        return Math.max(4000, Math.floor(bytesPerSecond * (MIN_SPEECH_DURATION_MS / 1000)));
    }

    private addWavHeader(samples: Buffer, sampleRate = 16_000, channels = 1): Buffer {
        const buffer = Buffer.alloc(44 + samples.length);
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + samples.length, 4);
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(channels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * channels * (this.bitsPerSample / 8), 28);
        buffer.writeUInt16LE(channels * (this.bitsPerSample / 8), 32);
        buffer.writeUInt16LE(this.bitsPerSample, 34);
        buffer.write('data', 36);
        buffer.writeUInt32LE(samples.length, 40);
        samples.copy(buffer, 44);
        return buffer;
    }
}
