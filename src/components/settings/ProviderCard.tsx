import React, { useState, useEffect, useRef } from 'react';
import { Trash2, AlertCircle, CheckCircle, ExternalLink, Loader2, ChevronDown, Check, RefreshCw, Plus, X, Shield } from 'lucide-react';

interface FetchedModel {
    id: string;
    label: string;
}

interface MaskedKey {
    index: number;
    masked: string;
}

interface ProviderCardProps {
    providerId: 'gemini' | 'groq' | 'deepinfra' | 'opencode_go' | 'openai' | 'claude';
    providerName: string;
    apiKey: string;
    preferredModel?: string;
    hasStoredKey: boolean;
    maskedKeys: MaskedKey[];
    keyCount: number;
    onKeyChange: (key: string) => void;
    onSaveKey: () => Promise<void>;
    onRemoveKey: () => void;
    onAddKey: (key: string) => Promise<void>;
    onRemoveKeyByIndex: (index: number) => Promise<void>;
    onTestConnection: () => void;
    testStatus: 'idle' | 'testing' | 'success' | 'error';
    testError?: string;
    savingStatus: boolean;
    savedStatus: boolean;
    keyPlaceholder: string;
    keyUrl: string;
    onPreferredModelChange?: (modelId: string) => void;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
    providerId,
    providerName,
    apiKey,
    preferredModel,
    hasStoredKey,
    maskedKeys,
    keyCount,
    onKeyChange,
    onSaveKey,
    onRemoveKey,
    onAddKey,
    onRemoveKeyByIndex,
    onTestConnection,
    testStatus,
    testError,
    savingStatus,
    savedStatus,
    keyPlaceholder,
    keyUrl,
    onPreferredModelChange,
}) => {
    const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState<string>(preferredModel || '');
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isAddingKey, setIsAddingKey] = useState(false);
    const [newKeyValue, setNewKeyValue] = useState('');
    const [isAdding, setIsAdding] = useState(false);
    const [removingIndex, setRemovingIndex] = useState<number | null>(null);
    const dropdownRef = React.useRef<HTMLDivElement>(null);
    const addKeyInputRef = useRef<HTMLInputElement>(null);

    const savedRef = useRef(savedStatus);
    const savingRef = useRef(savingStatus);
    savedRef.current = savedStatus;
    savingRef.current = savingStatus;

    useEffect(() => {
        if (!apiKey.trim()) return;
        const timer = setTimeout(() => {
            if (!savedRef.current && !savingRef.current) {
                onSaveKey().catch(console.error);
            }
        }, 5000);
        return () => clearTimeout(timer);
    }, [apiKey]);

    useEffect(() => {
        if (preferredModel) setSelectedModel(preferredModel);
    }, [preferredModel]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isAddingKey && addKeyInputRef.current) {
            addKeyInputRef.current.focus();
        }
    }, [isAddingKey]);

    const handleFetchModels = async (): Promise<FetchedModel[]> => {
        setIsFetching(true);
        setFetchError(null);

        try {
            if (apiKey.trim()) {
                await onSaveKey();
            }

            const keyToUse = apiKey.trim() || '';
            // @ts-ignore
            const result = await window.electronAPI?.fetchProviderModels(providerId, keyToUse);

            if (result?.success && result.models) {
                const models = result.models as FetchedModel[];
                setFetchedModels(models);
                if (result.models.length > 0) {
                    const existsInList = models.some((m: FetchedModel) => m.id === selectedModel);
                    if (!existsInList) {
                        const firstModel = models[0].id;
                        setSelectedModel(firstModel);
                        // @ts-ignore
                        await window.electronAPI?.setProviderPreferredModel(providerId, firstModel);
                        if (onPreferredModelChange) {
                            onPreferredModelChange(firstModel);
                        }
                    }
                }
                return models;
            } else {
                setFetchError(result?.error || 'Failed to fetch models');
                return [];
            }
        } catch (e: any) {
            setFetchError(e.message || 'Failed to fetch models');
            return [];
        } finally {
            setIsFetching(false);
        }
    };

    const handleDropdownToggle = async () => {
        if (fetchedModels.length > 0) {
            setIsDropdownOpen(prev => !prev);
            return;
        }

        const models = await handleFetchModels();
        if (models.length > 0) {
            setIsDropdownOpen(true);
        }
    };

    const handleSelectModel = async (modelId: string) => {
        setSelectedModel(modelId);
        setIsDropdownOpen(false);
        try {
            // @ts-ignore
            await window.electronAPI?.setProviderPreferredModel(providerId, modelId);
            if (onPreferredModelChange) {
                onPreferredModelChange(modelId);
            }
        } catch (e) {
            console.error('Failed to save preferred model:', e);
        }
    };

    const handleAddKey = async () => {
        const trimmed = newKeyValue.trim();
        if (!trimmed) return;
        setIsAdding(true);
        try {
            await onAddKey(trimmed);
            setNewKeyValue('');
            setIsAddingKey(false);
        } catch (e) {
            console.error('Failed to add key:', e);
        } finally {
            setIsAdding(false);
        }
    };

    const handleRemoveKeyByIndex = async (index: number) => {
        setRemovingIndex(index);
        try {
            await onRemoveKeyByIndex(index);
        } catch (e) {
            console.error('Failed to remove key:', e);
        } finally {
            setRemovingIndex(null);
        }
    };

    const selectedOption = fetchedModels.find(m => m.id === selectedModel);

    return (
        <div className="relative overflow-visible bg-bg-card rounded-xl p-5 border border-border-subtle shadow-sm">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <label className="min-w-0 flex flex-wrap items-center gap-2 text-xs font-medium text-text-primary uppercase tracking-wide">
                    <span className="shrink-0">{providerName} API Key</span>
                    {hasStoredKey && keyCount > 0 && (
                        <span className="flex flex-wrap items-center gap-1 normal-case">
                            <CheckCircle size={12} className="text-green-500" />
                            <span className="text-green-500 text-[10px]">Saved</span>
                            <span className="bg-bg-elevated border border-border-muted text-text-primary text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                                {keyCount} {keyCount === 1 ? 'key' : 'keys'}
                            </span>
                            {keyCount > 1 && (
                                <span className="bg-accent-primary/10 text-accent-primary border border-accent-primary/20 text-[9px] px-1.5 py-0.5 rounded-full font-bold flex items-center gap-0.5">
                                    <Shield size={9} />
                                    Round Robin
                                </span>
                            )}
                        </span>
                    )}
                </label>
                <button
                    onClick={() => {
                        // @ts-ignore
                        window.electronAPI?.openExternal(keyUrl);
                    }}
                    className="shrink-0 text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 transition-colors"
                    title={`Get ${providerName} API Key`}
                >
                    <span className="text-[10px] uppercase tracking-wide">Get Key</span>
                    <ExternalLink size={12} />
                </button>
            </div>

            {keyCount > 0 && maskedKeys.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                    {maskedKeys.map((mk) => (
                        <div
                            key={mk.index}
                            className="group flex items-center gap-1 bg-bg-elevated border border-border-muted rounded-md px-2 py-1 text-[11px] font-mono text-text-primary hover:border-text-tertiary transition-colors"
                        >
                            <span>{mk.masked}</span>
                            <button
                                onClick={() => handleRemoveKeyByIndex(mk.index)}
                                disabled={removingIndex === mk.index}
                                className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-red-400 transition-all ml-0.5"
                                title="Remove this key"
                            >
                                {removingIndex === mk.index ? (
                                    <Loader2 size={10} className="animate-spin" />
                                ) : (
                                    <X size={10} strokeWidth={2.5} />
                                )}
                            </button>
                        </div>
                    ))}
                    <button
                        onClick={() => setIsAddingKey(true)}
                        className="flex items-center gap-1 bg-bg-elevated border border-dashed border-border-muted rounded-md px-2 py-1 text-[10px] text-text-secondary hover:text-accent-primary hover:border-accent-primary/30 transition-colors"
                    >
                        <Plus size={10} />
                        Add
                    </button>
                </div>
            )}

            {keyCount === 0 && !isAddingKey && (
                <div className="flex gap-2 mb-3">
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => onKeyChange(e.target.value)}
                        placeholder={keyPlaceholder}
                        className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                    />
                    <button
                        onClick={onSaveKey}
                        disabled={savingStatus || !apiKey.trim()}
                        className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${savedStatus
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary disabled:opacity-50'
                            }`}
                    >
                        {savingStatus ? 'Saving...' : savedStatus ? 'Saved!' : 'Save'}
                    </button>
                    {hasStoredKey && (
                        <button
                            onClick={onRemoveKey}
                            className="px-2.5 py-2.5 rounded-lg text-xs font-medium text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-all"
                            title="Remove all API keys"
                        >
                            <Trash2 size={16} strokeWidth={1.5} />
                        </button>
                    )}
                </div>
            )}

            {isAddingKey && (
                <div className="flex gap-2 mb-3">
                    <input
                        ref={addKeyInputRef}
                        type="password"
                        value={newKeyValue}
                        onChange={(e) => setNewKeyValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddKey();
                            if (e.key === 'Escape') { setIsAddingKey(false); setNewKeyValue(''); }
                        }}
                        placeholder={`Enter new ${providerName} API key`}
                        className="flex-1 bg-bg-input border border-accent-primary/50 rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                    />
                    <button
                        onClick={handleAddKey}
                        disabled={isAdding || !newKeyValue.trim()}
                        className="px-4 py-2.5 rounded-lg text-xs font-medium bg-accent-primary text-white hover:bg-accent-secondary transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                        {isAdding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        {isAdding ? 'Adding...' : 'Add'}
                    </button>
                    <button
                        onClick={() => { setIsAddingKey(false); setNewKeyValue(''); }}
                        className="px-3 py-2.5 rounded-lg text-xs font-medium text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-colors border border-border-subtle"
                    >
                        Cancel
                    </button>
                </div>
            )}

            {keyCount > 1 && (
                <p className="text-[10px] text-accent-primary mb-3 flex items-center gap-1">
                    <Shield size={10} />
                    Keys are automatically rotated on rate limits or failures (round robin).
                </p>
            )}

            <div className="flex items-center justify-between mb-3 w-full">
                <button
                    onClick={onTestConnection}
                    disabled={(!apiKey.trim() && !hasStoredKey) || testStatus === 'testing'}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border border-border-subtle flex items-center gap-2 shrink-0 ${testStatus === 'success' ? 'bg-green-500/10 text-green-500 border-green-500/20' :
                        testStatus === 'error' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
                            'bg-bg-input hover:bg-bg-elevated text-text-primary'
                        }`}
                    title={testError || "Test Connection"}
                >
                    {testStatus === 'testing' ? <><Loader2 size={12} className="animate-spin" /> Testing...</> :
                        testStatus === 'success' ? <><CheckCircle size={12} /> Connected</> :
                            testStatus === 'error' ? <><AlertCircle size={12} /> Error</> :
                                <>{/* No Icon */} Test Connection</>}
                </button>

                {fetchedModels.length > 0 || preferredModel ? (
                    <div className="relative z-20 flex-1 max-w-[240px] min-w-[160px] mx-4" ref={dropdownRef}>
                        <button
                            onClick={handleDropdownToggle}
                            disabled={isFetching}
                            className="w-full bg-bg-elevated border border-border-muted rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary flex items-center justify-between transition-colors hover:bg-bg-input disabled:opacity-60"
                            type="button"
                        >
                            <span className="truncate pr-2">{selectedOption ? selectedOption.label : (preferredModel || (isFetching ? 'Loading models...' : 'Select model'))}</span>
                            {isFetching ? (
                                <Loader2 size={14} className="text-text-secondary animate-spin" />
                            ) : (
                                <ChevronDown size={14} className={`text-text-secondary transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                            )}
                        </button>

                        {isDropdownOpen && fetchedModels.length > 0 && (
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full min-w-[240px] bg-bg-elevated border border-border-muted rounded-lg shadow-2xl z-[200] max-h-60 overflow-y-auto animated fadeIn">
                                <div className="p-1 space-y-0.5">
                                    {fetchedModels.map((model) => (
                                        <button
                                            key={model.id}
                                            onClick={() => handleSelectModel(model.id)}
                                            className={`w-full text-left px-3 py-2 text-xs rounded-md flex items-center justify-between group transition-colors ${selectedModel === model.id ? 'bg-bg-input text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                            type="button"
                                        >
                                            <span className="truncate">{model.label}</span>
                                            {selectedModel === model.id && <Check size={14} className="text-accent-primary shrink-0 ml-2" />}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex-1 mx-4" />
                )}

                {hasStoredKey ? (
                    <button
                        onClick={handleFetchModels}
                        disabled={isFetching}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border border-border-subtle flex items-center gap-2 shrink-0 ${isFetching
                            ? 'bg-bg-input text-text-secondary'
                            : 'bg-accent-primary/10 text-accent-primary border-accent-primary/20 hover:bg-accent-primary/20'
                            }`}
                    >
                        {isFetching ? (
                            <><Loader2 size={12} className="animate-spin" /> Fetching...</>
                        ) : (
                            <><RefreshCw size={12} /> Fetch Models</>
                        )}
                    </button>
                ) : (
                    <span className="w-[110px]" />
                )}
            </div>

            {testError && <p className="text-[10px] text-red-400 mt-1.5 mb-2">{testError}</p>}
            {fetchError && <p className="text-[10px] text-red-400 mt-1.5 mb-2">Model fetch error: {fetchError}</p>}
        </div>
    );
};
