import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, AlertCircle, CheckCircle, Save, ChevronDown, Check, RefreshCw, ExternalLink, Loader2 } from 'lucide-react';
import { STANDARD_CLOUD_MODELS, prettifyModelId } from '../../utils/modelUtils';
import { validateCurl } from '../../lib/curl-validator';
import { ProviderCard } from './ProviderCard';
import { CodexProviderCard } from './CodexProviderCard';
import {
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    resolveCodexReasoningEffort,
    type CodexReasoningEffort,
} from '../../config/codexModels';

type MaskedKey = { index: number; masked: string };

interface CustomProvider {
    id: string;
    name: string;
    curlCommand: string;
    responsePath: string;
}

interface ModelOption {
    id: string;
    name: string;
}

interface ModelSelectProps {
    value: string;
    options: ModelOption[];
    onChange: (value: string) => void;
    placeholder?: string;
}

const ModelSelect: React.FC<ModelSelectProps> = ({ value, options, onChange, placeholder = "Select model" }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selectedOption = options.find(o => o.id === value);

    return (
        <div className="relative z-20" ref={containerRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-56 bg-bg-elevated border border-border-muted rounded-lg px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary flex items-center justify-between hover:bg-bg-input transition-colors"
                type="button"
            >
                <span className="truncate pr-2">{selectedOption ? selectedOption.name : placeholder}</span>
                <ChevronDown size={14} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute top-full right-0 mt-1 w-72 bg-bg-elevated border border-border-muted rounded-lg shadow-2xl z-[200] max-h-72 overflow-y-auto animated fadeIn">
                    <div className="p-1 space-y-0.5">
                        {options.map((option) => (
                            <button
                                key={option.id}
                                onClick={() => {
                                    onChange(option.id);
                                    setIsOpen(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-xs rounded-md flex items-center justify-between group transition-colors ${value === option.id ? 'bg-bg-input text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                type="button"
                            >
                                <span className="truncate">{option.name}</span>
                                {value === option.id && <Check size={14} className="text-accent-primary shrink-0 ml-2" />}
                            </button>
                        ))}
                        {options.length === 0 && (
                            <div className="px-3 py-2 text-xs text-gray-500 italic">No models available</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export const AIProvidersSettings: React.FC = () => {
    // --- Standard Providers ---
    const [apiKey, setApiKey] = useState('');
    const [groqApiKey, setGroqApiKey] = useState('');
    const [deepInfraApiKey, setDeepInfraApiKey] = useState('');
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [claudeApiKey, setClaudeApiKey] = useState('');

    // Status
    const [savedStatus, setSavedStatus] = useState<Record<string, boolean>>({});
    const [savingStatus, setSavingStatus] = useState<Record<string, boolean>>({});
    const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});
    const [maskedKeys, setMaskedKeys] = useState<Record<string, MaskedKey[]>>({});
    const [keyCounts, setKeyCounts] = useState<Record<string, number>>({});
    // Fast mode is available with a local Groq key OR via the Natively API (server-side Groq pool)
    const canUseFastMode = !!(hasStoredKey.groq || hasStoredKey.natively);
    const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({});
    const [testError, setTestError] = useState<Record<string, string>>({});

    const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
    const [isEditingCustom, setIsEditingCustom] = useState(false);
    const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
    const [customName, setCustomName] = useState('');
    const [customCurl, setCustomCurl] = useState('');
    const [customResponsePath, setCustomResponsePath] = useState('');
    const [curlError, setCurlError] = useState<string | null>(null);

    // --- Local (Ollama) ---
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'detected' | 'not-found' | 'fixing'>('checking');
    const [ollamaRestarted, setOllamaRestarted] = useState(false);
    const [isRefreshingOllama, setIsRefreshingOllama] = useState(false);

    // --- Default Model ---
    const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_CODEX_MODEL);
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(DEFAULT_CODEX_REASONING_EFFORT);
    const [fastResponseMode, setFastResponseMode] = useState(false);
    const [credentialsLoaded, setCredentialsLoaded] = useState(false);

    // --- Dynamic Model Discovery ---
    const [preferredModels, setPreferredModels] = useState<Record<string, string>>({});

    // Load Initial Data
    useEffect(() => {
        const loadCredentials = async () => {
            try {
                // Load credentials FIRST so canUseFastMode is correct before we set fastResponseMode.
                // If we set fastResponseMode before hasStoredKey is populated, the enforcement
                // effect below fires with canUseFastMode=false and immediately resets fast mode
                // to false — writing that reset back to SettingsManager on every startup.
                // @ts-ignore
                const creds = await window.electronAPI?.getStoredCredentials?.();
                if (creds) {
                    setHasStoredKey({
                        gemini: creds.hasGeminiKey,
                        groq: creds.hasGroqKey,
                        deepinfra: !!creds.hasDeepInfraKey,
                        openai: creds.hasOpenaiKey,
                        claude: creds.hasClaudeKey,
                        natively: creds.hasNativelyKey || false,
                        codex: !!creds.hasCodexAccounts
                    });
                    if (creds.providerKeys) {
                        const mk: Record<string, MaskedKey[]> = {};
                        const kc: Record<string, number> = {};
                        for (const [provider, info] of Object.entries(creds.providerKeys)) {
                            mk[provider] = (info as any).keys || [];
                            kc[provider] = (info as any).count || 0;
                        }
                        setMaskedKeys(mk);
                        setKeyCounts(kc);
                    }
                    // Load preferred models
                    const pm: Record<string, string> = {};
                    if (creds.geminiPreferredModel) pm.gemini = creds.geminiPreferredModel;
                    if (creds.groqPreferredModel) pm.groq = creds.groqPreferredModel;
                    if (creds.deepinfraPreferredModel) pm.deepinfra = creds.deepinfraPreferredModel;
                    if (creds.openaiPreferredModel) pm.openai = creds.openaiPreferredModel;
                    if (creds.claudePreferredModel) pm.claude = creds.claudePreferredModel;
                    if (creds.codexPreferredModel) pm.codex = creds.codexPreferredModel;
                    setPreferredModels(pm);
                    if (creds.codexReasoningEffort) {
                        setCodexReasoningEffort(resolveCodexReasoningEffort(
                            creds.codexPreferredModel || DEFAULT_CODEX_MODEL,
                            creds.codexReasoningEffort,
                        ));
                    }
                }

                // Mark credentials as fully loaded after the supported provider state is ready.
                setCredentialsLoaded(true);

                // Load persisted default model
                // @ts-ignore
                const result = await window.electronAPI?.getDefaultModel();
                if (result && result.model) {
                    setDefaultModel(result.model);
                }

            } catch (e) {
                console.error("Failed to load settings:", e);
                setCredentialsLoaded(true); // Unblock even on error
            }
        };
        loadCredentials();
    }, []);

    const ensureOllamaStartup = async () => {
        setOllamaStatus('checking');
        try {
            // @ts-ignore
            const result = await window.electronAPI?.invoke?.('ensure-ollama-running');
            if (result && result.success) {
                // It's running (or just started), now fetch models
                checkOllama(true);
            } else {
                setOllamaStatus('not-found');
            }
        } catch (e) {
            console.warn("Ollama ensure startup failed:", e);
            setOllamaStatus('not-found');
        }
    };

    const checkOllama = async (_isInitial = true) => {
        // Don't override 'checking' if we are already in smart-start mode
        // if (isInitial) setOllamaStatus('checking'); 

        try {
            // @ts-ignore
            const models = await window.electronAPI?.getAvailableOllamaModels?.();
            if (models && models.length > 0) {
                setOllamaModels(models);
                setOllamaStatus('detected');
            } else {
                // Silent failure on background checks
                // Only set not-found if we haven't detected it yet
                if (ollamaStatus !== 'detected') {
                    setOllamaStatus('not-found');
                }
            }
        } catch (e) {
            // console.warn(`Ollama check failed:`, e);
            if (ollamaStatus !== 'detected') {
                setOllamaStatus('not-found');
            }
        }
    };

    const handleFixOllama = async () => {
        setOllamaStatus('fixing');
        try {
            // @ts-ignore
            const result = await window.electronAPI?.invoke?.('force-restart-ollama');
            if (result && result.success) {
                setOllamaRestarted(true);
                // Wait for server to be ready
                setTimeout(() => checkOllama(false), 2000);
            } else {
                setOllamaStatus('not-found');
            }
        } catch (e) {
            console.error("Fix failed", e);
            setOllamaStatus('not-found');
        }
    };

    const handleSaveKey = async (provider: string, key: string, setter: (val: string) => void) => {
        if (!key.trim()) return;
        setSavingStatus(prev => ({ ...prev, [provider]: true }));
        try {
            let result;
            // @ts-ignore
            if (provider === 'gemini') result = await window.electronAPI.setGeminiApiKey(key);
            // @ts-ignore
            if (provider === 'groq') result = await window.electronAPI.setGroqApiKey(key);
            // @ts-ignore
            if (provider === 'deepinfra') result = await window.electronAPI.setDeepInfraApiKey(key);
            // @ts-ignore
            if (provider === 'openai') result = await window.electronAPI.setOpenaiApiKey(key);
            // @ts-ignore
            if (provider === 'claude') result = await window.electronAPI.setClaudeApiKey(key);

            if (result && result.success) {
                setSavedStatus(prev => ({ ...prev, [provider]: true }));
                setHasStoredKey(prev => ({ ...prev, [provider]: true }));
                setter('');
                setTimeout(() => setSavedStatus(prev => ({ ...prev, [provider]: false })), 2000);
                await refreshMaskedKeys(provider);
            }
        } catch (e) {
            console.error(`Failed to save ${provider} key:`, e);
        } finally {
            setSavingStatus(prev => ({ ...prev, [provider]: false }));
        }
    };

    const handleRemoveKey = async (provider: string, setter: (val: string) => void) => {
        if (!confirm(`Are you sure you want to remove the ${provider} API key?`)) return;
        try {
            let result;
            // @ts-ignore
            if (provider === 'gemini') result = await window.electronAPI.setGeminiApiKey('');
            // @ts-ignore
            if (provider === 'groq') result = await window.electronAPI.setGroqApiKey('');
            // @ts-ignore
            if (provider === 'deepinfra') result = await window.electronAPI.setDeepInfraApiKey('');
            // @ts-ignore
            if (provider === 'openai') result = await window.electronAPI.setOpenaiApiKey('');
            // @ts-ignore
            if (provider === 'claude') result = await window.electronAPI.setClaudeApiKey('');

            if (result && result.success) {
                setHasStoredKey(prev => ({ ...prev, [provider]: false }));
                setter('');
                await refreshMaskedKeys(provider);
            }
        } catch (e) {
            console.error(`Failed to remove ${provider} key:`, e);
        }
    };

    const handleTestConnection = async (provider: string, key: string) => {
        // Allow testing if key is provided OR if we have a stored key
        if (!key.trim() && !hasStoredKey[provider]) {
            return;
        }
        setTestStatus(prev => ({ ...prev, [provider]: 'testing' }));
        setTestError(prev => ({ ...prev, [provider]: '' }));

        try {
            // @ts-ignore
            const result = await window.electronAPI.testLlmConnection(provider, key);
            if (result.success) {
                setTestStatus(prev => ({ ...prev, [provider]: 'success' }));
                setTimeout(() => setTestStatus(prev => ({ ...prev, [provider]: 'idle' })), 3000);
            } else {
                setTestStatus(prev => ({ ...prev, [provider]: 'error' }));
                setTestError(prev => ({ ...prev, [provider]: result.error || 'Connection failed' }));
            }
        } catch (e: any) {
            setTestStatus(prev => ({ ...prev, [provider]: 'error' }));
            setTestError(prev => ({ ...prev, [provider]: e.message || 'Connection failed' }));
        }
    };

    const openKeyUrl = (provider: string) => {
        const urls: Record<string, string> = {
            gemini: 'https://aistudio.google.com/app/apikey',
            groq: 'https://console.groq.com/keys',
            deepinfra: 'https://deepinfra.com/dash/api_keys',
            openai: 'https://platform.openai.com/api-keys',
            claude: 'https://console.anthropic.com/settings/keys'
        };
        // @ts-ignore
        window.electronAPI?.openExternal(urls[provider]);
    };

    const refreshMaskedKeys = async (provider: string) => {
        try {
            // @ts-ignore
            const result = await window.electronAPI?.getProviderMaskedKeys(provider);
            if (result && result.success) {
                setMaskedKeys(prev => ({ ...prev, [provider]: result.keys || [] }));
                setKeyCounts(prev => ({ ...prev, [provider]: result.count || 0 }));
                setHasStoredKey(prev => ({ ...prev, [provider]: (result.count || 0) > 0 }));
            }
        } catch (e) {
            console.error('Failed to refresh masked keys:', e);
        }
    };

    const handleAddKey = async (provider: string, key: string) => {
        try {
            // @ts-ignore
            const result = await window.electronAPI?.addProviderKey(provider, key);
            if (result && result.success) {
                await refreshMaskedKeys(provider);
            } else {
                console.error('Failed to add key:', result?.error);
            }
        } catch (e) {
            console.error('Failed to add key:', e);
        }
    };

    const handleRemoveKeyByIndex = async (provider: string, index: number) => {
        try {
            // @ts-ignore
            const result = await window.electronAPI?.removeProviderKey(provider, index);
            if (result && result.success) {
                await refreshMaskedKeys(provider);
                if ((result.count || 0) === 0) {
                    setHasStoredKey(prev => ({ ...prev, [provider]: false }));
                }
            }
        } catch (e) {
            console.error('Failed to remove key:', e);
        }
    };


    // --- Custom Provider Handlers ---

    const handleEditProvider = (provider: CustomProvider) => {
        setEditingProvider(provider);
        setCustomName(provider.name);
        setCustomCurl(provider.curlCommand);
        setCustomResponsePath(provider.responsePath || '');
        setIsEditingCustom(true);
        setCurlError(null);
    };

    const handleNewProvider = () => {
        setEditingProvider(null);
        setCustomName('');
        setCustomCurl('');
        setCustomResponsePath('');
        setIsEditingCustom(true);
        setCurlError(null);
    };

    const handleSaveCustom = async () => {
        setCurlError(null);
        if (!customName.trim()) {
            setCurlError("Provider Name is required.");
            return;
        }

        const validation = validateCurl(customCurl);
        if (!validation.isValid) {
            setCurlError(validation.message || "Invalid cURL command.");
            return;
        }

        const newProvider: CustomProvider = {
            id: editingProvider ? editingProvider.id : crypto.randomUUID(),
            name: customName,
            curlCommand: customCurl,
            responsePath: customResponsePath
        };

        try {
            // @ts-ignore
            const result = await window.electronAPI.saveCustomProvider(newProvider);
            if (result.success) {
                // Refresh list
                // @ts-ignore
                const updated = await window.electronAPI.getCustomProviders();
                setCustomProviders(updated);
                setIsEditingCustom(false);
            } else {
                setCurlError(result.error ?? null);
            }
        } catch (e: any) {
            setCurlError(e.message);
        }
    };

    const handleDeleteCustom = async (id: string) => {
        if (!confirm("Are you sure you want to delete this provider?")) return;
        try {
            // @ts-ignore
            const result = await window.electronAPI.deleteCustomProvider(id);
            if (result.success) {
                // @ts-ignore
                const updated = await window.electronAPI.getCustomProviders();
                setCustomProviders(updated);
            }
        } catch (e) {
            console.error("Failed to delete provider:", e);
        }
    };

    return (
        <div className="space-y-5 animated fadeIn pb-10">
            {/* Default Model for Chat */}
            <div className="space-y-5">
                <div>
                    <h3 className="text-sm font-bold text-text-primary mb-1">Default Model for Chat</h3>
                    <p className="text-xs text-text-secondary mb-2">Primary model for new chats. Other configured models act as fallbacks.</p>
                </div>

                <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle flex items-center justify-between">
                    <div>
                        <label className="block text-xs font-medium text-text-primary uppercase tracking-wide mb-0">Active Model</label>
                        <p className="text-[10px] text-text-secondary">Applies to new chats instantly.</p>
                    </div>
                    <ModelSelect
                        value={defaultModel}
                        options={(() => {
                            const opts: { id: string; name: string }[] = [];

                            for (const [prov, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
                                if (!hasStoredKey[prov as keyof typeof hasStoredKey]) continue;
                                cfg.ids.forEach((id, i) => opts.push({ id, name: cfg.names[i] }));
                                const pm = preferredModels[prov as keyof typeof preferredModels];
                                if (pm && !cfg.ids.includes(pm)) {
                                    opts.push({ id: pm, name: prettifyModelId(pm) });
                                }
                            }
                            if (defaultModel && !opts.find(o => o.id === defaultModel)) {
                                const supportedDefault = defaultModel.startsWith('codex:') || defaultModel.startsWith('gemini-') || defaultModel.startsWith('models/');
                                if (supportedDefault) opts.unshift({ id: defaultModel, name: prettifyModelId(defaultModel) });
                            }
                            return opts;
                        })()}
                        onChange={(val) => {
                            setDefaultModel(val);
                            // @ts-ignore - persist as default + update runtime + broadcast
                            window.electronAPI?.setDefaultModel(val).catch(console.error);
                        }}
                    />
                </div>

            </div>

            {/* Cloud Providers */}
            <div className="space-y-5">
                <div>
                    <h3 className="text-sm font-bold text-text-primary mb-1">Cloud Providers</h3>
                    <p className="text-xs text-text-secondary mb-2">Add API keys to unlock cloud AI models.</p>
                </div>

                <div className="space-y-4">

                    {/* Gemini */}
                    <ProviderCard
                        providerId="gemini"
                        providerName="Gemini"
                        apiKey={apiKey}
                        preferredModel={preferredModels.gemini}
                        hasStoredKey={!!hasStoredKey.gemini}
                        maskedKeys={maskedKeys.gemini || []}
                        keyCount={keyCounts.gemini || 0}
                        onKeyChange={setApiKey}
                        onSaveKey={async () => { await handleSaveKey('gemini', apiKey, setApiKey); }}
                        onRemoveKey={() => handleRemoveKey('gemini', setApiKey)}
                        onAddKey={(key) => handleAddKey('gemini', key)}
                        onRemoveKeyByIndex={(index) => handleRemoveKeyByIndex('gemini', index)}
                        onTestConnection={() => handleTestConnection('gemini', apiKey)}
                        testStatus={testStatus.gemini || 'idle'}
                        testError={testError.gemini}
                        savingStatus={!!savingStatus.gemini}
                        savedStatus={!!savedStatus.gemini}
                        keyPlaceholder="AIzaSy..."
                        keyUrl="https://aistudio.google.com/app/apikey"
                        onPreferredModelChange={(model) => setPreferredModels(prev => ({ ...prev, gemini: model }))}
                    />

                    {/* Codex (ChatGPT OAuth) */}
                    <CodexProviderCard
                        hasAccounts={!!hasStoredKey.codex}
                        preferredModel={preferredModels.codex}
                        reasoningEffort={codexReasoningEffort}
                        onAddAccount={async () => {
                            const alias = window.prompt('Enter an alias for this ChatGPT account (e.g. personal, work):');
                            if (!alias?.trim()) return;
                            try {
                                // @ts-ignore
                                const result = await window.electronAPI?.codexAuthAddAccount?.(alias.trim());
                                if (result?.success) {
                                    setHasStoredKey(prev => ({ ...prev, codex: true }));
                                } else {
                                    alert(result?.error || 'Failed to add account');
                                }
                            } catch (e: any) {
                                alert(e.message || 'Failed to add account');
                            }
                        }}
                        onManageAccounts={() => {
                            // @ts-ignore
                            window.electronAPI?.openSettingsTab?.('codex-multi-auth');
                        }}
                        onPreferredModelChange={(model) => {
                            setPreferredModels(prev => ({ ...prev, codex: model }));
                            window.electronAPI?.setProviderPreferredModel?.('codex', model).catch(console.error);
                            if (defaultModel.startsWith('codex:')) {
                                setDefaultModel(model);
                                window.electronAPI?.setDefaultModel(model).catch(console.error);
                            }
                        }}
                        onReasoningEffortChange={(effort, model) => {
                            setCodexReasoningEffort(effort);
                            window.electronAPI?.setCodexReasoningEffort?.(effort, model).catch(console.error);
                        }}
                        testStatus={testStatus.codex || 'idle'}
                        testError={testError.codex}
                        onTestConnection={() => handleTestConnection('codex', '')}
                    />

                </div>
            </div>

        </div>
    );
};
