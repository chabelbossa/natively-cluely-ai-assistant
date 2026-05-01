import { EventEmitter } from 'events';
import { ParakeetBridge, ParakeetBridgeEvent } from './ParakeetBridge';
import { TranscriptPostProcessor } from './TranscriptPostProcessor';
import { RECOGNITION_LANGUAGES } from '../config/languages';

export interface ParakeetStreamingConfig {
    glossary?: string;
    speechEndDebounceMs?: number;
    partialCommitIntervalMs?: number;
    channel?: 'system' | 'mic';
}

export class ParakeetStreamingSTT extends EventEmitter {
    private readonly bridge = ParakeetBridge.getInstance();
    private readonly sessionId: string;
    private readonly channel: 'system' | 'mic';
    private readonly postProcessor: TranscriptPostProcessor;
    /** True only after the helper confirms FluidAudio diarization models are ready. */
    public supportsDiarization = false;
    private active = false;
    private ready = false;
    private sampleRate = 16000;
    private numChannels = 1;
    private languageKey = 'auto';
    private pendingChunks: Buffer[] = [];
    private readonly maxPendingChunks = 200;
    private readonly speechEndDebounceMs: number;
    private readonly partialCommitIntervalMs: number;
    private finalizeTimer: NodeJS.Timeout | null = null;
    private finalizeGeneration = 0;
    private samplesSinceLastFinal = 0;
    private lastFinalText = '';
    private lastFinalAt = 0;
    private lastPartialText = '';
    private lastPartialConfidence = 0.9;
    private lastPartialAt = 0;
    private lastCommittedPartialSourceText = '';
    private audioChunks = 0;
    private audioBytes = 0;
    private transcriptEvents = 0;
    private lastAudioLogAt = 0;
    private lastTranscriptLogAt = 0;
    private readonly sessionListener: (event: ParakeetBridgeEvent) => void;
    private readonly bridgeStatusListener: (event: ParakeetBridgeEvent) => void;

    constructor(config: ParakeetStreamingConfig = {}) {
        super();
        this.sessionId = `parakeet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.channel = config.channel || 'mic';
        this.postProcessor = new TranscriptPostProcessor({ glossary: config.glossary });
        this.speechEndDebounceMs = this.normalizeDebounceMs(config.speechEndDebounceMs);
        this.partialCommitIntervalMs = this.normalizePartialCommitIntervalMs(config.partialCommitIntervalMs);
        this.sessionListener = (event: ParakeetBridgeEvent) => this.handleBridgeEvent(event);
        this.bridgeStatusListener = (event: ParakeetBridgeEvent) => this.handleBridgeEvent(event);
        this.bridge.on(`session:${this.sessionId}`, this.sessionListener);
        this.bridge.on('status', this.bridgeStatusListener);
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
        this.lastFinalAt = Date.now();
        this.lastPartialText = '';
        this.lastPartialConfidence = 0.9;
        this.lastPartialAt = 0;
        this.lastCommittedPartialSourceText = '';
        this.audioChunks = 0;
        this.audioBytes = 0;
        this.transcriptEvents = 0;
        this.lastAudioLogAt = 0;
        this.lastTranscriptLogAt = 0;

        console.log(`[ParakeetStreaming][lifecycle] start session=${this.sessionId} source=${this.channel} inputRate=${this.sampleRate}Hz channels=${this.numChannels} language=${this.getIsoLanguage() || 'auto'} debounce=${this.speechEndDebounceMs}ms partialCommit=${this.partialCommitIntervalMs}ms`);

        void this.bridge.startSession(this.sessionId, {
            language: this.getIsoLanguage() || 'auto',
            channel: this.channel,
        })
            .then(() => {
                if (!this.active) {
                    this.bridge.stopSession(this.sessionId);
                    return;
                }
                this.ready = true;
                console.log(`[ParakeetStreaming][lifecycle] ready session=${this.sessionId} pendingChunks=${this.pendingChunks.length}`);
                this.flushPendingChunks();
            })
            .catch((error: Error) => {
                this.emit('error', error);
            });
    }

    stop(): void {
        if (!this.active) return;
        this.flushPendingTranscript();
        this.active = false;
        this.ready = false;
        this.pendingChunks = [];
        this.clearFinalizeTimer();
        this.bridge.stopSession(this.sessionId);
    }

    finalize(): void {
        this.finalizeNow();
    }

    flushPendingTranscript(): void {
        this.clearFinalizeTimer();

        const fallbackText = this.lastPartialText.trim();
        if (fallbackText) {
            this.commitPartialAsFinal(fallbackText, this.lastPartialConfidence || 0.85);
            this.lastPartialText = '';
            this.lastPartialAt = 0;
        }

        this.finalizeNow();
    }

    write(audioData: Buffer): void {
        if (!this.active || !audioData?.length) return;
        this.clearFinalizeTimer();
        const pcm16k = this.resampleTo16kHz(audioData);
        if (pcm16k.length === 0) return;
        this.samplesSinceLastFinal += Math.floor(pcm16k.length / 2);
        this.logAudioWrite(this.ready ? 'sent' : 'buffered', audioData.length, pcm16k.length);

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
        this.bridge.off('status', this.bridgeStatusListener);
        return super.removeAllListeners(eventName);
    }

    private handleBridgeEvent(event: ParakeetBridgeEvent): void {
        if (event.type === 'partial' || event.type === 'final') {
            const rawText = String(event.text || '');
            const final = event.type === 'final';
            const confidence = typeof event.confidence === 'number' ? event.confidence : 0.9;
            const result = this.postProcessor.process(rawText, { final, confidence });
            if (result.dropped) return;
            const emittedText = this.getIncrementalTranscriptText(result.text);
            if (!emittedText) return;
            if (final && this.shouldDropRepeatedFinal(emittedText)) {
                console.log(`[ParakeetStreaming][transcript] dropped repeated final session=${this.sessionId} text="${emittedText.substring(0, 100)}"`);
                this.lastCommittedPartialSourceText = result.text.trim();
                return;
            }

            if (!final) {
                this.lastPartialText = result.text;
                this.lastPartialConfidence = confidence;
                this.lastPartialAt = Date.now();
            }

            // Extract speakerId from diarization (only present on final events)
            const speakerId = final && event.speaker_id ? this.parseSpeakerId(event.speaker_id) : undefined;

            this.emit('transcript', {
                text: emittedText,
                isFinal: final,
                confidence,
                speakerId,
            });
            this.logTranscriptEvent(final, emittedText, result.text, confidence);

            if (final && speakerId !== undefined) {
                console.log(`[ParakeetStreaming][diarization] session=${this.sessionId} speaker=${speakerId} segments=${event.diarization_segments?.length ?? 0}`);
            }

            if (!final && this.shouldAutoCommitPartial(result.text)) {
                console.log(`[ParakeetStreaming][auto-final] session=${this.sessionId} partialChars=${result.text.length} emittedChars=${emittedText.length}`);
                this.commitPartialAsFinal(result.text, confidence);
            }

            if (final) {
                this.samplesSinceLastFinal = 0;
                this.lastFinalText = this.normalizeForComparison(emittedText);
                this.lastFinalAt = Date.now();
                this.lastCommittedPartialSourceText = result.text.trim();
                this.lastPartialText = '';
                this.lastPartialAt = 0;
            }
            return;
        }

        if (event.type === 'status') {
            const state = String(event.state || '');
            if (state === 'diarization_ready') {
                this.supportsDiarization = true;
                console.log(`[ParakeetStreaming][diarization] ready session=${this.sessionId} source=${this.channel}`);
            } else if (state === 'diarization_unavailable' || state === 'diarization_skipped') {
                this.supportsDiarization = false;
                console.warn(`[ParakeetStreaming][diarization] ${state} session=${this.sessionId} source=${this.channel}${event.error ? ` error=${event.error}` : ''}`);
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
        console.log(`[ParakeetStreaming][audio] flushing pending session=${this.sessionId} chunks=${chunks.length}`);
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
        if (normalized === this.lastFinalText && now - this.lastFinalAt < 60_000) return true;
        return false;
    }

    private shouldAutoCommitPartial(text: string): boolean {
        const normalized = this.normalizeForComparison(this.getIncrementalTranscriptText(text));
        if (normalized.length < 24) return false;
        const now = Date.now();
        if (now - this.lastFinalAt < this.partialCommitIntervalMs) return false;
        if (normalized === this.lastFinalText) return false;
        return true;
    }

    private commitPartialAsFinal(text: string, confidence: number): void {
        const emittedText = this.getIncrementalTranscriptText(text);
        if (!emittedText || this.shouldDropRepeatedFinal(emittedText)) return;
        this.emit('transcript', {
            text: emittedText,
            isFinal: true,
            confidence: confidence || 0.85,
            // No speakerId for committed partials — diarization only runs on true finals
        });
        this.logTranscriptEvent(true, emittedText, text, confidence || 0.85, 'committed-partial');
        this.samplesSinceLastFinal = 0;
        this.lastFinalText = this.normalizeForComparison(emittedText);
        this.lastFinalAt = Date.now();
        this.lastCommittedPartialSourceText = text.trim();
    }

    /**
     * Parse speaker ID from FluidAudio diarization.
     * FluidAudio emits speaker IDs like "speaker_0", "speaker_1", etc.
     * We extract the numeric part for compatibility with main.ts speaker mapping.
     */
    private parseSpeakerId(raw: string): number | undefined {
        if (!raw) return undefined;
        // FluidAudio SpeakerManager uses "speaker_N" format
        const match = raw.match(/(?:speaker_)?(\d+)/);
        if (match) return parseInt(match[1], 10);
        return undefined;
    }

    private logAudioWrite(state: 'buffered' | 'sent', rawBytes: number, pcm16kBytes: number): void {
        this.audioChunks++;
        this.audioBytes += pcm16kBytes;
        const now = Date.now();
        if (this.audioChunks <= 5 || this.audioChunks % 250 === 0 || now - this.lastAudioLogAt > 5000) {
            this.lastAudioLogAt = now;
            console.log(`[ParakeetStreaming][audio] session=${this.sessionId} state=${state} chunks=${this.audioChunks} rawLast=${rawBytes} pcm16kLast=${pcm16kBytes} pcm16kTotal=${this.audioBytes} ready=${this.ready} pending=${this.pendingChunks.length} samplesSinceFinal=${this.samplesSinceLastFinal}`);
        }
    }

    private logTranscriptEvent(final: boolean, emittedText: string, sourceText: string, confidence: number, source = 'helper'): void {
        this.transcriptEvents++;
        const now = Date.now();
        if (!final && this.transcriptEvents > 5 && now - this.lastTranscriptLogAt < 3000) {
            return;
        }
        this.lastTranscriptLogAt = now;
        console.log(`[ParakeetStreaming][transcript] session=${this.sessionId} #${this.transcriptEvents} source=${source} final=${final} conf=${Number(confidence || 0).toFixed(2)} emittedChars=${emittedText.length} sourceChars=${sourceText.length} text="${emittedText.substring(0, 140)}"`);
    }

    private getIncrementalTranscriptText(sourceText: string): string {
        const text = sourceText.trim();
        const previous = this.lastCommittedPartialSourceText.trim();
        if (!text || !previous) return text;

        const currentNormalized = this.normalizeForComparison(text);
        const previousNormalized = this.normalizeForComparison(previous);
        if (!currentNormalized || currentNormalized === previousNormalized) return '';
        if (previousNormalized.includes(currentNormalized)) return '';

        const currentWords = text.split(/\s+/);
        const previousWords = previous.split(/\s+/);
        const normalizeWord = (word: string) => this.normalizeForComparison(word);
        const currentNormWords = currentWords.map(normalizeWord);
        const previousNormWords = previousWords.map(normalizeWord);
        const maxOverlap = Math.min(currentNormWords.length, previousNormWords.length);

        for (let overlap = maxOverlap; overlap >= 2; overlap--) {
            const previousSuffix = previousNormWords.slice(previousNormWords.length - overlap).join(' ');
            const currentPrefix = currentNormWords.slice(0, overlap).join(' ');
            if (previousSuffix && previousSuffix === currentPrefix) {
                return currentWords.slice(overlap).join(' ').trim();
            }
        }

        if (currentNormalized.startsWith(previousNormalized)) {
            return currentWords.slice(Math.min(previousWords.length, currentWords.length)).join(' ').trim();
        }

        return text;
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

    private normalizePartialCommitIntervalMs(value?: number): number {
        const envValue = Number(process.env.NATIVELY_PARAKEET_PARTIAL_COMMIT_MS || '');
        const requested = Number.isFinite(value) ? value : envValue;
        if (!Number.isFinite(requested) || requested <= 0) return 12000;
        return Math.max(6000, Math.min(30000, Math.round(requested)));
    }
}
