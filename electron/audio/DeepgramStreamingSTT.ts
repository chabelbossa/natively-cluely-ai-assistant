/**
 * DeepgramStreamingSTT - SDK-based streaming Speech-to-Text using Deepgram Nova-3
 *
 * Uses @deepgram/sdk v3 (listen.live) instead of raw WebSocket.
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 */

import { EventEmitter } from 'events';
import { RECOGNITION_LANGUAGES } from '../config/languages';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 8000;

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private live: any = null;
    private isActive = false;
    private shouldReconnect = false;
    private isOpen = false; // tracks whether SDK connection is in OPEN state

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode = 'en';

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;
    private sentChunks = 0;
    private sentBytes = 0;
    private transcriptEvents = 0;
    private lastAudioLogAt = 0;
    private lastTranscriptLogAt = 0;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    /** This provider supports real-time speaker diarization via Deepgram's API */
    public readonly supportsDiarization = true;

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming] Sample rate set to ${rate}`);
        if (this.isActive) this.restartStream();
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
        if (this.isActive) this.restartStream();
    }

    public setRecognitionLanguage(key: string): void {
        if (key === 'auto') {
            if (this.languageCode === 'multi') return;
            this.languageCode = 'multi';
            console.log('[DeepgramStreaming] Language set to multilingual (multi)');
            if (this.isActive) this.restartStream();
            return;
        }
        const config = RECOGNITION_LANGUAGES[key];
        if (config && this.languageCode !== config.iso639) {
            this.languageCode = config.iso639;
            console.log(`[DeepgramStreaming] Language set to ${this.languageCode}`);
            if (this.isActive) this.restartStream();
        }
    }

    public setCredentials(_path: string): void { }

    private restartStream(): void {
        console.log('[DeepgramStreaming] Restarting due to config change...');
        this.stop();
        this.start();
    }

    public start(): void {
        if (this.isActive) return;
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.sentChunks = 0;
        this.sentBytes = 0;
        this.transcriptEvents = 0;
        this.lastAudioLogAt = 0;
        this.lastTranscriptLogAt = 0;
        console.log(`[DeepgramStreaming][lifecycle] start rate=${this.sampleRate}Hz channels=${this.numChannels} lang=${this.languageCode} diarize=true`);
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.live) {
            try {
                this.live.requestClose();
            } catch {
                // ignore errors during shutdown
            }
            this.live = null;
        }

        this.isActive = false;
        this.isConnecting = false;
        this.isOpen = false;
        this.buffer = [];
        console.log('[DeepgramStreaming] Stopped');
    }

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.isOpen) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift();
            this.logAudioWrite('buffered', chunk);

            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                this.connect();
            }
            return;
        }

        try {
            this.live.send(chunk);
            this.logAudioWrite('sent', chunk);
        } catch (err: any) {
            console.error('[DeepgramStreaming] Send error:', err?.message);
        }
    }

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;

        console.log(`[DeepgramStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels}, lang=${this.languageCode})...`);

        try {
            const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

            const deepgram = createClient(this.apiKey);

            const liveOptions = {
                model: 'nova-3',
                language: this.languageCode,
                smart_format: true,
                interim_results: true,
                encoding: 'linear16',
                sample_rate: this.sampleRate,
                channels: this.numChannels,
                endpointing: 300,
                utterance_end_ms: 1000,
                vad_events: true,
                diarize: true,          // Backward-compatible streaming diarization flag.
                diarize_model: 'latest', // Current streaming diarizer; avoids relying on deprecated diarize-only routing.
            };

            console.log(`[DeepgramStreaming][connect] options=${JSON.stringify({
                model: liveOptions.model,
                language: liveOptions.language,
                sample_rate: liveOptions.sample_rate,
                channels: liveOptions.channels,
                interim_results: liveOptions.interim_results,
                endpointing: liveOptions.endpointing,
                utterance_end_ms: liveOptions.utterance_end_ms,
                diarize: liveOptions.diarize,
                diarize_model: liveOptions.diarize_model,
            })}`);

            this.live = deepgram.listen.live(liveOptions);

            this.live.on(LiveTranscriptionEvents.Open, () => {
                this.isConnecting = false;
                this.isOpen = true;
                console.log('[DeepgramStreaming] Connected');

                // Register Transcript inside Open per SDK README pattern
                this.live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
                    try {
                        const alt = data.channel?.alternatives?.[0];
                        const transcript = alt?.transcript;
                        const isFinal = data.is_final ?? false;
                        if (!transcript) return;

                        // Extract speaker_id from word-level diarization data.
                        // Deepgram attaches speaker to each word; we take the most
                        // frequent speaker across the utterance as the segment label.
                        let speakerId: number | undefined;
                        const words: any[] = alt?.words ?? [];
                        const speakerCounts: Record<number, number> = {};
                        if (words.length > 0 && words[0]?.speaker !== undefined) {
                            for (const w of words) {
                                if (w.speaker !== undefined) speakerCounts[w.speaker] = (speakerCounts[w.speaker] ?? 0) + 1;
                            }
                            speakerId = Number(Object.entries(speakerCounts).sort((a, b) => b[1] - a[1])[0]?.[0]);
                        }

                        this.logTranscriptEvent({
                            isFinal,
                            transcript,
                            confidence: alt?.confidence,
                            wordsCount: words.length,
                            speakerId,
                            speakerCounts,
                            speechFinal: data.speech_final,
                            channelIndex: data.channel_index ?? data.channel?.channel_index,
                        });

                        this.emit('transcript', {
                            text: transcript,
                            isFinal,
                            confidence: alt?.confidence ?? 1.0,
                            speakerId,  // undefined for local/non-diarized providers
                        });
                    } catch (err) {
                        console.error('[DeepgramStreaming] Parse error:', err);
                    }
                });

                // Flush buffered audio
                const buffered = this.buffer.splice(0);
                for (const chunk of buffered) {
                    try { this.live?.send(chunk); } catch { }
                }
                if (buffered.length > 0) {
                    console.log(`[DeepgramStreaming] Flushed ${buffered.length} buffered chunks`);
                }

                // SDK keepAlive() every 8s prevents idle timeout (per Deepgram docs)
                this.keepAliveInterval = setInterval(() => {
                    if (this.isOpen) {
                        try { this.live?.keepAlive(); } catch { }
                    }
                }, KEEPALIVE_INTERVAL_MS);

                // Reset backoff only after 5s of stable connection
                setTimeout(() => {
                    if (this.isOpen) this.reconnectAttempts = 0;
                }, 5000);
            });

            this.live.on(LiveTranscriptionEvents.Error, (err: any) => {
                console.error('[DeepgramStreaming] Error:', err);
                this.emit('error', err instanceof Error ? err : new Error(String(err)));
            });

            this.live.on(LiveTranscriptionEvents.Close, (event: any) => {
                const code = event?.code ?? 'unknown';
                const reason = event?.reason || '(empty)';
                console.log(`[DeepgramStreaming] Closed (code=${code}, reason=${reason})`);

                this.isOpen = false;
                this.isConnecting = false;
                this.clearTimers();

                if (this.shouldReconnect && code !== 1000) {
                    this.scheduleReconnect();
                }
            });

        } catch (err: any) {
            console.error('[DeepgramStreaming] Initialization error:', err?.message);
            this.isConnecting = false;
            if (this.shouldReconnect) this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        // Discard stale buffered audio — replaying seconds-old audio on reconnect
        // overwhelms Deepgram's real-time endpoint and causes EPIPE storms.
        this.buffer = [];

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[DeepgramStreaming] Max reconnect attempts reached — giving up`);
            this.emit('error', new Error('DeepgramStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) this.connect();
        }, delay);
    }

    private clearTimers(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    private logAudioWrite(state: 'buffered' | 'sent', chunk: Buffer): void {
        this.sentChunks++;
        this.sentBytes += chunk.length;
        const now = Date.now();
        if (this.sentChunks <= 5 || this.sentChunks % 250 === 0 || now - this.lastAudioLogAt > 5000) {
            this.lastAudioLogAt = now;
            console.log(`[DeepgramStreaming][audio] state=${state} chunks=${this.sentChunks} bytes=${this.sentBytes} last=${chunk.length} open=${this.isOpen} connecting=${this.isConnecting} buffer=${this.buffer.length}`);
        }
    }

    private logTranscriptEvent(event: {
        isFinal: boolean;
        transcript: string;
        confidence?: number;
        wordsCount: number;
        speakerId?: number;
        speakerCounts: Record<number, number>;
        speechFinal?: boolean;
        channelIndex?: unknown;
    }): void {
        this.transcriptEvents++;
        const now = Date.now();
        if (!event.isFinal && this.transcriptEvents > 5 && now - this.lastTranscriptLogAt < 3000) {
            return;
        }
        this.lastTranscriptLogAt = now;

        const speakerCounts = Object.keys(event.speakerCounts).length > 0
            ? JSON.stringify(event.speakerCounts)
            : '{}';
        console.log(`[DeepgramStreaming][transcript] #${this.transcriptEvents} final=${event.isFinal} speechFinal=${event.speechFinal ?? 'n/a'} channelIndex=${JSON.stringify(event.channelIndex ?? null)} words=${event.wordsCount} speakerId=${event.speakerId ?? 'none'} speakerCounts=${speakerCounts} conf=${Number(event.confidence ?? 0).toFixed(2)} text="${event.transcript.substring(0, 140)}"`);
    }
}
