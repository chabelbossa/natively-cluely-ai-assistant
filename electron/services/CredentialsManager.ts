/**
 * CredentialsManager - Secure storage for API keys and service account paths
 * Uses Electron's safeStorage API for encryption at rest
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import type { CodexAccount, CodexMultiAuthSettings } from '../types/codex-multi-auth';
import {
    DEFAULT_CODEX_MODEL,
    resolveCodexModelId,
    resolveCodexReasoningEffort,
    type CodexReasoningEffort,
} from '../../src/config/codexModels';

const CREDENTIALS_PATH = path.join(app.getPath('userData'), 'credentials.enc');

export interface CustomProvider {
    id: string;
    name: string;
    curlCommand: string;
}

export interface CurlProvider {
    id: string;
    name: string;
    curlCommand: string;
    responsePath: string; // e.g. "choices[0].message.content"
}

export type StoredSttProvider = 'none' | 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively' | 'local';
export type StoredLocalSttMode = 'server' | 'whisper_cpp' | 'parakeet_stream';

export interface StoredLocalSttConfig {
    mode?: StoredLocalSttMode;
    endpoint?: string;
    model?: string;
    whisperCppModelPath?: string;
    whisperCppExecutablePath?: string;
    glossary?: string;
}

export interface StoredCredentials {
    geminiApiKey?: string;
    groqApiKey?: string;
    deepInfraApiKey?: string;
    openCodeGoApiKey?: string;
    openaiApiKey?: string;
    claudeApiKey?: string;
    googleServiceAccountPath?: string;
    customProviders?: CustomProvider[];
    curlProviders?: CurlProvider[];
    defaultModel?: string;
    nativelyApiKey?: string;
    // STT Provider settings
    sttProvider?: StoredSttProvider;
    groqSttApiKey?: string;
    groqSttModel?: string;
    localSttMode?: StoredLocalSttMode;
    localSttEndpoint?: string;
    localSttModel?: string;
    localSttWhisperCppModelPath?: string;
    localSttWhisperCppExecutablePath?: string;
    localSttGlossary?: string;
    openAiSttApiKey?: string;
    deepgramApiKey?: string;
    elevenLabsApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    ibmWatsonApiKey?: string;
    ibmWatsonRegion?: string;
    sonioxApiKey?: string;
    sttLanguage?: string;
    aiResponseLanguage?: string;
    // Tavily Search
    tavilyApiKey?: string;
    // Dynamic Model Discovery – preferred models per provider
    geminiPreferredModel?: string;
    groqPreferredModel?: string;
    deepinfraPreferredModel?: string;
    openCodeGoPreferredModel?: string;
    openaiPreferredModel?: string;
    claudePreferredModel?: string;
    // Free trial state
    trialToken?:     string;   // server-issued signed token (natively_trial_…)
    trialExpiresAt?: string;   // ISO timestamp — local copy for startup check
    trialStartedAt?: string;   // ISO timestamp
    trialClaimed?:   boolean;  // set true on first claim, never cleared — hides start card permanently
    // Codex Multi-Auth OAuth accounts
    codexAccounts?: CodexAccount[];
    codexSettings?: CodexMultiAuthSettings;
    codexPreferredModel?: string;
    codexReasoningEffort?: CodexReasoningEffort;
}

export type StoredLlmProvider = 'gemini' | 'groq' | 'deepinfra' | 'opencode_go' | 'openai' | 'claude';

export interface MaskedKeyInfo {
    index: number;
    masked: string;
}

const API_KEY_FIELDS: Record<StoredLlmProvider, keyof StoredCredentials> = {
    gemini: 'geminiApiKey',
    groq: 'groqApiKey',
    deepinfra: 'deepInfraApiKey',
    opencode_go: 'openCodeGoApiKey',
    openai: 'openaiApiKey',
    claude: 'claudeApiKey',
};

const PREFERRED_MODEL_KEYS: Record<StoredLlmProvider, keyof StoredCredentials> = {
    gemini: 'geminiPreferredModel',
    groq: 'groqPreferredModel',
    deepinfra: 'deepinfraPreferredModel',
    opencode_go: 'openCodeGoPreferredModel',
    openai: 'openaiPreferredModel',
    claude: 'claudePreferredModel',
};

const parseApiKeyList = (value?: string): string[] => {
    if (!value) return [];
    return value
        .split(/[\s,;]+/)
        .map(key => key.trim())
        .filter(Boolean);
};

const serializeApiKeyList = (value: string): string | undefined => {
    const keys = parseApiKeyList(value);
    return keys.length > 0 ? keys.join('\n') : undefined;
};

export class CredentialsManager {
    private static instance: CredentialsManager;
    private credentials: StoredCredentials = {};

    private constructor() {
        // Load on construction after app ready
    }

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    /**
     * Initialize - load credentials from disk
     * Must be called after app.whenReady()
     */
    public init(): void {
        this.loadCredentials();
        console.log('[CredentialsManager] Initialized');
    }

    // =========================================================================
    // Getters
    // =========================================================================

    public getGeminiApiKey(): string | undefined {
        return this.getGeminiApiKeys()[0];
    }

    public getGroqApiKey(): string | undefined {
        return this.getGroqApiKeys()[0];
    }

    public getDeepInfraApiKey(): string | undefined {
        return this.getDeepInfraApiKeys()[0];
    }

    public getOpenCodeGoApiKey(): string | undefined {
        return this.getOpenCodeGoApiKeys()[0];
    }

    public getOpenaiApiKey(): string | undefined {
        return this.getOpenaiApiKeys()[0];
    }

    public getClaudeApiKey(): string | undefined {
        return this.getClaudeApiKeys()[0];
    }

    public getGeminiApiKeys(): string[] {
        return parseApiKeyList(this.credentials.geminiApiKey);
    }

    public getGroqApiKeys(): string[] {
        return parseApiKeyList(this.credentials.groqApiKey);
    }

    public getDeepInfraApiKeys(): string[] {
        return parseApiKeyList(this.credentials.deepInfraApiKey);
    }

    public getOpenCodeGoApiKeys(): string[] {
        return parseApiKeyList(this.credentials.openCodeGoApiKey);
    }

    public getOpenaiApiKeys(): string[] {
        return parseApiKeyList(this.credentials.openaiApiKey);
    }

    public getClaudeApiKeys(): string[] {
        return parseApiKeyList(this.credentials.claudeApiKey);
    }

    public getMaskedApiKeys(provider: StoredLlmProvider): MaskedKeyInfo[] {
        const keys = this.getApiKeysList(provider);
        return keys.map((key, index) => ({
            index,
            masked: this.maskKey(key),
        }));
    }

    public getApiKeyCount(provider: StoredLlmProvider): number {
        return this.getApiKeysList(provider).length;
    }

    public addApiKey(provider: StoredLlmProvider, newKey: string): number {
        const trimmed = newKey.trim();
        if (!trimmed) return -1;
        const keys = this.getApiKeysList(provider);
        keys.push(trimmed);
        this.setApiKeysList(provider, keys);
        this.saveCredentials();
        console.log(`[CredentialsManager] Added key to ${provider}, total: ${keys.length}`);
        return keys.length - 1;
    }

    public removeApiKey(provider: StoredLlmProvider, index: number): boolean {
        const keys = this.getApiKeysList(provider);
        if (index < 0 || index >= keys.length) return false;
        keys.splice(index, 1);
        this.setApiKeysList(provider, keys);
        this.saveCredentials();
        console.log(`[CredentialsManager] Removed key ${index} from ${provider}, remaining: ${keys.length}`);
        return true;
    }

    private getApiKeysList(provider: StoredLlmProvider): string[] {
        const field = API_KEY_FIELDS[provider];
        const value = this.credentials[field];
        return parseApiKeyList(value as string | undefined);
    }

    private setApiKeysList(provider: StoredLlmProvider, keys: string[]): void {
        const field = API_KEY_FIELDS[provider];
        (this.credentials as any)[field] = keys.length > 0 ? keys.join('\n') : undefined;
    }

    private maskKey(key: string): string {
        if (key.length <= 8) return '••••••••';
        const prefix = key.substring(0, 4);
        const suffix = key.substring(key.length - 3);
        return `${prefix}...${suffix}`;
    }

    public getGoogleServiceAccountPath(): string | undefined {
        return this.credentials.googleServiceAccountPath;
    }

    public getCustomProviders(): CustomProvider[] {
        return this.credentials.customProviders || [];
    }

    public getSttProvider(): StoredSttProvider {
        const provider = this.credentials.sttProvider || 'none';
        // Self-heal: if provider is 'none' but a Natively key exists, the user is in a
        // broken state (key cleared then re-entered via a path that skipped auto-promote,
        // or credentials restored from backup). Silently restore to 'natively' so STT works.
        if (provider === 'none' && this.credentials.nativelyApiKey) {
            this.credentials.sttProvider = 'natively';
            this.saveCredentials();
            console.log('[CredentialsManager] Self-healed sttProvider: none→natively (Natively key present)');
            return 'natively';
        }
        return provider;
    }

    public getDeepgramApiKey(): string | undefined {
        return this.credentials.deepgramApiKey;
    }

    public getGroqSttApiKey(): string | undefined {
        return this.credentials.groqSttApiKey;
    }

    public getGroqSttModel(): string {
        return this.credentials.groqSttModel || 'whisper-large-v3-turbo';
    }

    public getLocalSttEndpoint(): string {
        return this.credentials.localSttEndpoint || 'http://127.0.0.1:8000/v1/audio/transcriptions';
    }

    public getLocalSttModel(): string {
        return this.credentials.localSttModel || 'whisper-large-v3-turbo';
    }

    public getLocalSttConfig(): Required<StoredLocalSttConfig> {
        return {
            mode: this.credentials.localSttMode || 'parakeet_stream',
            endpoint: this.credentials.localSttEndpoint || 'http://127.0.0.1:8000/v1/audio/transcriptions',
            model: this.credentials.localSttModel || 'whisper-large-v3-turbo',
            whisperCppModelPath: this.credentials.localSttWhisperCppModelPath || this.getDefaultVoiceInkWhisperModelPath(),
            whisperCppExecutablePath: this.credentials.localSttWhisperCppExecutablePath || '/opt/homebrew/bin/whisper-cli',
            glossary: this.credentials.localSttGlossary || this.getDefaultSttGlossary(),
        };
    }

    public getOpenAiSttApiKey(): string | undefined {
        return this.credentials.openAiSttApiKey;
    }

    public getElevenLabsApiKey(): string | undefined {
        return this.credentials.elevenLabsApiKey;
    }

    public getAzureApiKey(): string | undefined {
        return this.credentials.azureApiKey;
    }

    public getAzureRegion(): string {
        return this.credentials.azureRegion || 'eastus';
    }

    public getIbmWatsonApiKey(): string | undefined {
        return this.credentials.ibmWatsonApiKey;
    }

    public getIbmWatsonRegion(): string {
        return this.credentials.ibmWatsonRegion || 'us-south';
    }

    public getSonioxApiKey(): string | undefined {
        return this.credentials.sonioxApiKey;
    }

    public getTavilyApiKey(): string | undefined {
        return this.credentials.tavilyApiKey;
    }

    public getSttLanguage(): string {
        return this.credentials.sttLanguage || 'english-us';
    }

    public getAiResponseLanguage(): string {
        return this.credentials.aiResponseLanguage || 'auto';
    }
    public getDefaultModel(): string {
        return this.credentials.defaultModel || 'gemini-3.1-flash-lite-preview';
    }

    public getNativelyApiKey(): string | undefined {
        return this.credentials.nativelyApiKey;
    }

    public getAllCredentials(): StoredCredentials {
        return { ...this.credentials };
    }

    // =========================================================================
    // Codex Multi-Auth Getters
    // =========================================================================

    public getCodexAccounts(): CodexAccount[] {
        return this.credentials.codexAccounts ?? [];
    }

    public getCodexSettings(): CodexMultiAuthSettings {
        return this.credentials.codexSettings ?? {
            rotationStrategy: 'round-robin',
            criticalThreshold: 10,
            lowThreshold: 25,
        };
    }

    // =========================================================================
    // Setters (auto-save)
    // =========================================================================

    public setGeminiApiKey(key: string): void {
        this.credentials.geminiApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] Gemini API Key updated');
    }

    public setGroqApiKey(key: string): void {
        this.credentials.groqApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] Groq API Key updated');
    }

    public setDeepInfraApiKey(key: string): void {
        this.credentials.deepInfraApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] DeepInfra API Key updated');
    }

    public setOpenCodeGoApiKey(key: string): void {
        this.credentials.openCodeGoApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] OpenCode Go API Key updated');
    }

    public setOpenaiApiKey(key: string): void {
        this.credentials.openaiApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI API Key updated');
    }

    public setClaudeApiKey(key: string): void {
        this.credentials.claudeApiKey = serializeApiKeyList(key);
        this.saveCredentials();
        console.log('[CredentialsManager] Claude API Key updated');
    }

    public setCodexAccounts(accounts: CodexAccount[]): void {
        this.credentials.codexAccounts = accounts;
        this.saveCredentials();
        console.log(`[CredentialsManager] Codex accounts updated (${accounts.length} accounts)`);
    }

    public setCodexSettings(settings: CodexMultiAuthSettings): void {
        this.credentials.codexSettings = settings;
        this.saveCredentials();
        console.log('[CredentialsManager] Codex settings updated');
    }

    public setGoogleServiceAccountPath(filePath: string): void {
        this.credentials.googleServiceAccountPath = filePath;
        this.saveCredentials();
        console.log('[CredentialsManager] Google Service Account path updated');
    }

    public setSttProvider(provider: StoredSttProvider): void {
        this.credentials.sttProvider = provider;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Provider set to: ${provider}`);
    }

    public setDeepgramApiKey(key: string): void {
        this.credentials.deepgramApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Deepgram API Key updated');
    }

    public setGroqSttApiKey(key: string): void {
        this.credentials.groqSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Groq STT API Key updated');
    }

    public setOpenAiSttApiKey(key: string): void {
        this.credentials.openAiSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI STT API Key updated');
    }

    public setGroqSttModel(model: string): void {
        this.credentials.groqSttModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Groq STT Model set to: ${model}`);
    }

    public setLocalSttConfig(configOrEndpoint: StoredLocalSttConfig | string, model?: string): void {
        const config: StoredLocalSttConfig = typeof configOrEndpoint === 'string'
            ? { endpoint: configOrEndpoint, model }
            : (configOrEndpoint || {});

        this.credentials.localSttMode = config.mode || this.credentials.localSttMode || 'parakeet_stream';
        this.credentials.localSttEndpoint = (config.endpoint || '').trim() || 'http://127.0.0.1:8000/v1/audio/transcriptions';
        this.credentials.localSttModel = (config.model || '').trim() || 'whisper-large-v3-turbo';
        this.credentials.localSttWhisperCppModelPath = (config.whisperCppModelPath || '').trim() || this.getDefaultVoiceInkWhisperModelPath();
        this.credentials.localSttWhisperCppExecutablePath = (config.whisperCppExecutablePath || '').trim() || '/opt/homebrew/bin/whisper-cli';
        this.credentials.localSttGlossary = (config.glossary || '').trim() || this.getDefaultSttGlossary();
        this.saveCredentials();
        console.log(`[CredentialsManager] Local STT config set to: ${this.credentials.localSttMode}`);
    }

    private getDefaultVoiceInkWhisperModelPath(): string {
        return path.join(app.getPath('home'), 'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin');
    }

    private getDefaultSttGlossary(): string {
        return 'Kyntia, SSO, Next.js, NestJS, WaChap, Kloo, Artiweb, API, frontend, backend';
    }

    public setElevenLabsApiKey(key: string): void {
        this.credentials.elevenLabsApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] ElevenLabs API Key updated');
    }

    public setAzureApiKey(key: string): void {
        this.credentials.azureApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Azure API Key updated');
    }

    public setAzureRegion(region: string): void {
        this.credentials.azureRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] Azure Region set to: ${region}`);
    }

    public setIbmWatsonApiKey(key: string): void {
        this.credentials.ibmWatsonApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] IBM Watson API Key updated');
    }

    public setIbmWatsonRegion(region: string): void {
        this.credentials.ibmWatsonRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] IBM Watson Region set to: ${region}`);
    }

    public setSonioxApiKey(key: string): void {
        this.credentials.sonioxApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Soniox API Key updated');
    }

    public setTavilyApiKey(key: string): void {
        // Store undefined (not empty string) when removing, so hasKey() checks stay consistent
        this.credentials.tavilyApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] Tavily API Key updated');
    }

    public setSttLanguage(language: string): void {
        this.credentials.sttLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Language set to: ${language}`);
    }

    public setAiResponseLanguage(language: string): void {
        this.credentials.aiResponseLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] AI Response Language set to: ${language}`);
    }
    public setDefaultModel(model: string): void {
        this.credentials.defaultModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Default Model set to: ${model}`);
    }

    public setNativelyApiKey(key: string): void {
        const trimmed = key.trim();
        this.credentials.nativelyApiKey = trimmed || undefined;

        if (trimmed) {
            // Auto-promote natively to default model unless user already chose a non-Gemini/Groq model
            const current = this.credentials.defaultModel || '';
            const isAutoDefault = !current
                || current.startsWith('gemini-')
                || current.startsWith('llama-')
                || current.startsWith('mixtral-')
                || current.startsWith('gemma-')
                || current === 'gemini'
                || current === 'llama';
            if (isAutoDefault) {
                this.credentials.defaultModel = 'natively';
                console.log('[CredentialsManager] Auto-set default model to natively');
            }

            // Auto-promote natively STT if still on 'none' or the default Google STT
            if (!this.credentials.sttProvider || this.credentials.sttProvider === 'none' || this.credentials.sttProvider === 'google') {
                this.credentials.sttProvider = 'natively';
                console.log('[CredentialsManager] Auto-set STT provider to natively');
            }
        } else {
            // Key cleared — revert natively-auto-set defaults back to safe fallbacks
            if (this.credentials.defaultModel === 'natively') {
                this.credentials.defaultModel = 'gemini-3.1-flash-lite-preview';
                console.log('[CredentialsManager] Natively key cleared — reset default model to Gemini Flash');
            }
            if (this.credentials.sttProvider === 'natively') {
                this.credentials.sttProvider = 'none';
                console.log('[CredentialsManager] Natively key cleared — reset STT provider to none');
            }
        }

        this.saveCredentials();
        console.log('[CredentialsManager] Natively API Key updated');
    }

    public getPreferredModel(provider: StoredLlmProvider): string | undefined {
        const key = PREFERRED_MODEL_KEYS[provider];
        return this.credentials[key] as string | undefined;
    }

    public setPreferredModel(provider: StoredLlmProvider, modelId: string): void {
        const key = PREFERRED_MODEL_KEYS[provider];
        (this.credentials as any)[key] = modelId;
        this.saveCredentials();
        console.log(`[CredentialsManager] ${provider} preferred model set to: ${modelId}`);
    }

    public getCodexPreferredModel(): string | undefined {
        return resolveCodexModelId(this.credentials.codexPreferredModel || DEFAULT_CODEX_MODEL);
    }

    public setCodexPreferredModel(modelId: string): void {
        const resolvedModelId = resolveCodexModelId(modelId);
        this.credentials.codexPreferredModel = resolvedModelId;
        this.credentials.codexReasoningEffort = resolveCodexReasoningEffort(
            resolvedModelId,
            this.credentials.codexReasoningEffort,
        );
        this.saveCredentials();
        console.log(`[CredentialsManager] Codex preferred model set to: ${resolvedModelId}`);
    }

    public getCodexReasoningEffort(modelId?: string): CodexReasoningEffort {
        return resolveCodexReasoningEffort(
            resolveCodexModelId(modelId || this.credentials.codexPreferredModel),
            this.credentials.codexReasoningEffort,
        );
    }

    public setCodexReasoningEffort(effort: string, modelId?: string): CodexReasoningEffort {
        const resolvedModelId = resolveCodexModelId(modelId || this.credentials.codexPreferredModel);
        const resolvedEffort = resolveCodexReasoningEffort(resolvedModelId, effort);
        this.credentials.codexReasoningEffort = resolvedEffort;
        this.saveCredentials();
        console.log(`[CredentialsManager] Codex reasoning effort set to: ${resolvedEffort}`);
        return resolvedEffort;
    }

    public saveCustomProvider(provider: CustomProvider): void {
        if (!this.credentials.customProviders) {
            this.credentials.customProviders = [];
        }
        // Check if exists, update if so
        const index = this.credentials.customProviders.findIndex(p => p.id === provider.id);
        if (index !== -1) {
            this.credentials.customProviders[index] = provider;
        } else {
            this.credentials.customProviders.push(provider);
        }
        this.saveCredentials();
        console.log(`[CredentialsManager] Custom Provider '${provider.name}' saved`);
    }

    public deleteCustomProvider(id: string): void {
        if (!this.credentials.customProviders) return;
        this.credentials.customProviders = this.credentials.customProviders.filter(p => p.id !== id);
        this.saveCredentials();
        console.log(`[CredentialsManager] Custom Provider '${id}' deleted`);
    }

    public getCurlProviders(): CurlProvider[] {
        return this.credentials.curlProviders || [];
    }

    public saveCurlProvider(provider: CurlProvider): void {
        if (!this.credentials.curlProviders) {
            this.credentials.curlProviders = [];
        }
        const index = this.credentials.curlProviders.findIndex(p => p.id === provider.id);
        if (index !== -1) {
            this.credentials.curlProviders[index] = provider;
        } else {
            this.credentials.curlProviders.push(provider);
        }
        this.saveCredentials();
        console.log(`[CredentialsManager] Curl Provider '${provider.name}' saved`);
    }

    public deleteCurlProvider(id: string): void {
        if (!this.credentials.curlProviders) return;
        this.credentials.curlProviders = this.credentials.curlProviders.filter(p => p.id !== id);
        this.saveCredentials();
        console.log(`[CredentialsManager] Curl Provider '${id}' deleted`);
    }

    // ── Free Trial ─────────────────────────────────────────────
    public getTrialToken(): string | undefined {
        return this.credentials.trialToken;
    }

    public getTrialExpiresAt(): string | undefined {
        return this.credentials.trialExpiresAt;
    }

    public getTrialStartedAt(): string | undefined {
        return this.credentials.trialStartedAt;
    }

    public getTrialClaimed(): boolean {
        return this.credentials.trialClaimed === true;
    }

    public setTrialToken(token: string, expiresAt: string, startedAt: string): void {
        this.credentials.trialToken     = token;
        this.credentials.trialExpiresAt = expiresAt;
        this.credentials.trialStartedAt = startedAt;
        this.credentials.trialClaimed   = true;
        this.saveCredentials();
        console.log('[CredentialsManager] Trial token stored, expires:', expiresAt);
    }

    public clearTrialToken(): void {
        delete this.credentials.trialToken;
        delete this.credentials.trialExpiresAt;
        delete this.credentials.trialStartedAt;
        // trialClaimed intentionally NOT cleared — keeps start card hidden after token wipe
        this.saveCredentials();
        console.log('[CredentialsManager] Trial token cleared');
    }

    public clearAll(): void {
        this.scrubMemory();
        if (fs.existsSync(CREDENTIALS_PATH)) {
            fs.unlinkSync(CREDENTIALS_PATH);
        }
        const plaintextPath = CREDENTIALS_PATH + '.json';
        if (fs.existsSync(plaintextPath)) {
            fs.unlinkSync(plaintextPath);
        }
        console.log('[CredentialsManager] All credentials cleared');
    }

    /**
     * Scrub all API keys from memory to minimize exposure window.
     * Called on app quit and credential clear.
     */
    public scrubMemory(): void {
        // Overwrite each string field with empty before discarding
        for (const key of Object.keys(this.credentials) as (keyof StoredCredentials)[]) {
            const val = this.credentials[key];
            if (typeof val === 'string') {
                (this.credentials as any)[key] = '';
            }
        }
        this.credentials = {};
        console.log('[CredentialsManager] Memory scrubbed');
    }

    // =========================================================================
    // Storage (Encrypted)
    // =========================================================================

    private saveCredentials(): void {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
                // Fallback: save as plaintext (less secure, but functional)
                const plainPath = CREDENTIALS_PATH + '.json';
                const tmpPlain = plainPath + '.tmp';
                fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));
                fs.renameSync(tmpPlain, plainPath);
                return;
            }

            const data = JSON.stringify(this.credentials);
            const encrypted = safeStorage.encryptString(data);
            const tmpEnc = CREDENTIALS_PATH + '.tmp';
            fs.writeFileSync(tmpEnc, encrypted);
            fs.renameSync(tmpEnc, CREDENTIALS_PATH);
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
        }
    }

    private loadCredentials(): void {
        try {
            // Try encrypted file first
            if (fs.existsSync(CREDENTIALS_PATH)) {
                if (!safeStorage.isEncryptionAvailable()) {
                    console.warn('[CredentialsManager] Encryption not available for load');
                    return;
                }

                const encrypted = fs.readFileSync(CREDENTIALS_PATH);
                const decrypted = safeStorage.decryptString(encrypted);
                try {
                    const parsed = JSON.parse(decrypted);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded encrypted credentials');
                    } else {
                        throw new Error('Decrypted credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse decrypted credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }

                // Clean up any leftover plaintext fallback file to eliminate the data leak
                const plaintextPath = CREDENTIALS_PATH + '.json';
                if (fs.existsSync(plaintextPath)) {
                    try {
                        fs.unlinkSync(plaintextPath);
                        console.log('[CredentialsManager] Removed stale plaintext credential file');
                    } catch (cleanupErr) {
                        console.warn('[CredentialsManager] Could not remove stale plaintext file:', cleanupErr);
                    }
                }
                return;
            }

            // Fallback: try plaintext file
            const plaintextPath = CREDENTIALS_PATH + '.json';
            if (fs.existsSync(plaintextPath)) {
                const data = fs.readFileSync(plaintextPath, 'utf-8');
                try {
                    const parsed = JSON.parse(data);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded plaintext credentials');
                    } else {
                        throw new Error('Plaintext credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse plaintext credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }
                return;
            }

            console.log('[CredentialsManager] No stored credentials found');
        } catch (error) {
            console.error('[CredentialsManager] Failed to load credentials:', error);
            this.credentials = {};
        }
    }
}
