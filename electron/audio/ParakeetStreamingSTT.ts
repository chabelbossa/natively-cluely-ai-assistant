import { EventEmitter } from 'events';
import { ParakeetBridge, ParakeetBridgeEvent } from './ParakeetBridge';
import { TranscriptPostProcessor } from './TranscriptPostProcessor';
import { RECOGNITION_LANGUAGES } from '../config/languages';

export interface ParakeetStreamingConfig {
    glossary?: string;
    speechEndDebounceMs?: number;
}

export class ParakeetStreamingSTT extends EventEmitter {
    private readonly bridge = ParakeetBridge.getInstance();
    private readonly sessionId: string;
    private readonly postProcessor: TranscriptPostProcessor;
    private active = false;
    private ready = false;
    private sampleRate = 16000;
    private numChannels = 1;
    private languageKey = 'auto';
    private pendingChunks: Buffer[] = [];
    private readonly maxPendingChunks = 200;
    private readonly speechEndDebounceMs: number;
    private finalizeTimer: NodeJS.Timeout | null = null;
    private finalizeGeneration = 0;
    private samplesSinceLastFinal = 0;
    private lastFinalText = '';
    private lastFinalAt = 0;
    private readonly sessionListener: (event: ParakeetBridgeEvent) => void;

    constructor(config: ParakeetStreamingConfig = {}) {
        super();
        this.sessionId = `parakeet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.postProcessor = new TranscriptPostProcessor({ glossary: config.glossary });
        this.speechEndDebounceMs = this.normalizeDebounceMs(config.speechEndDebounceMs);
        this.sessionListener = (event: ParakeetBridgeEvent) => this.handleBridgeEvent(event);
        this.bridge.on(`session:${this.sessionId}`, this.sessionListener);
    }

    setRecognitionLanguage(key: string): void {
        this.languageKey = key || 'auto';
    }

    setSampleRate(rate: number): void {
        if (Number.isFinite(rate) && rate > 0) {
            this.sampleRate = rate;
        }
    }

    setAudioChannelCount(count: number): void {
        if (Number.isFinite(count) && count > 0) {
            this.numChannels = Math.max(1, Math.floor(count));
        }
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.ready = false;
        this.pendingChunks = [];
        this.clearFinalizeTimer();
        this.samplesSinceLastFinal = 0;
        this.lastFinalText = '';
        this.lastFinalAt = 0;

        void this.bridge.startSession(this.sessionId, { language: this.getIsoLanguage() || 'auto' })
            .then(() => {
                if (!this.active) {
                    this.bridge.stopSession(this.sessionId);
                    return;
                }
                this.ready = true;
                this.flushPendingChunks();
            })
            .catch((error: Error) => {
                this.emit('error', error);
            });
    }

    stop(): void {
        if (!this.active) return;
        this.active = false;
        this.ready = false;
        this.pendingChunks = [];
        this.clearFinalizeTimer();
        this.bridge.stopSession(this.sessionId);
    }

    finalize(): void {
        this.finalizeNow();
    }

    write(audioData: Buffer): void {
        if (!this.active || !audioData?.length) return;
        this.clearFinalizeTimer();
        const pcm16k = this.resampleTo16kHz(audioData);
        if (pcm16k.length === 0) return;
        this.samplesSinceLastFinal += Math.floor(pcm16k.length / 2);

        if (!this.ready) {
            this.pendingChunks.push(pcm16k);
            if (this.pendingChunks.length > this.maxPendingChunks) {
                this.pendingChunks.splice(0, this.pendingChunks.length - this.maxPendingChunks);
            }
            return;
        }

        this.bridge.sendAudio(this.sessionId, pcm16k);
    }

    notifySpeechEnded(): void {
        if (!this.active || !this.ready) return;
        const generation = ++this.finalizeGeneration;
        this.clearFinalizeTimer();
        this.finalizeTimer = setTimeout(() => {
            if (!this.active || !this.ready || generation !== this.finalizeGeneration) return;
            this.finalizeNow();
        }, this.speechEndDebounceMs);
    }

    removeAllListeners(eventName?: string | symbol): this {
        this.clearFinalizeTimer();
        this.bridge.off(`session:${this.sessionId}`, this.sessionListener);
        return super.removeAllListeners(eventName);
    }

    private handleBridgeEvent(event: ParakeetBridgeEvent): void {
        if (event.type === 'partial' || event.type === 'final') {
            const rawText = String(event.text || '');
            const final = event.type === 'final';
            const confidence = typeof event.confidence === 'number' ? event.confidence : 0.9;
            const result = this.postProcessor.process(rawText, { final, confidence });
            if (result.dropped) return;
            if (final && this.shouldDropRepeatedFinal(result.text)) return;

            this.emit('transcript', {
                text: result.text,
                isFinal: final,
                confidence,
            });

            if (final) {
                this.samplesSinceLastFinal = 0;
                this.lastFinalText = this.normalizeForComparison(result.text);
                this.lastFinalAt = Date.now();
            }
            return;
        }

        if (event.type === 'error') {
            this.emit('error', new Error(event.error || 'Parakeet STT error'));
        }
    }

    private flushPendingChunks(): void {
        if (!this.ready || this.pendingChunks.length === 0) return;
        const chunks = this.pendingChunks;
        this.pendingChunks = [];
        for (const chunk of chunks) {
            this.bridge.sendAudio(this.sessionId, chunk);
        }
    }

    private finalizeNow(): void {
        if (!this.active || !this.ready) return;
        this.clearFinalizeTimer();
        this.finalizeGeneration++;
        this.flushPendingChunks();
        if (this.samplesSinceLastFinal <= 0) return;
        this.bridge.speechEnd(this.sessionId);
    }

    private clearFinalizeTimer(): void {
        if (!this.finalizeTimer) return;
        clearTimeout(this.finalizeTimer);
        this.finalizeTimer = null;
    }

    private shouldDropRepeatedFinal(text: string): boolean {
        const normalized = this.normalizeForComparison(text);
        if (!normalized) return true;
        const now = Date.now();
        if (normalized === this.lastFinalText && now - this.lastFinalAt < 10_000) return true;
        return false;
    }

    private normalizeForComparison(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getIsoLanguage(): string | undefined {
        if (!this.languageKey || this.languageKey === 'auto') return undefined;
        const language = RECOGNITION_LANGUAGES[this.languageKey]?.iso639;
        return language === 'en' ? undefined : language;
    }

    private resampleTo16kHz(raw: Buffer): Buffer {
        const targetRate = 16_000;
        const numSamples = Math.floor(raw.length / 2);
        const inputS16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            inputS16[i] = raw.readInt16LE(i * 2);
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
        const outLen = Math.max(0, Math.floor(monoS16.length / factor));
        const outS16 = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            outS16[i] = monoS16[Math.floor(i * factor)];
        }
        return Buffer.from(outS16.buffer);
    }

    private normalizeDebounceMs(value?: number): number {
        const envValue = Number(process.env.NATIVELY_PARAKEET_SPEECH_END_DEBOUNCE_MS || '');
        const requested = Number.isFinite(value) ? value : envValue;
        if (!Number.isFinite(requested) || requested <= 0) return 2200;
        return Math.max(800, Math.min(5000, Math.round(requested)));
    }
}
