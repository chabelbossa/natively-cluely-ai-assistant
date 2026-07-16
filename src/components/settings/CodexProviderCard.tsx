import React, { useState } from 'react';
import { Plus, AlertCircle, CheckCircle, ExternalLink, Loader2, ChevronDown, Check, Shield, Settings as SettingsIcon } from 'lucide-react';
import {
    CODEX_EXPERIENCE_PRESETS,
    CODEX_MODELS,
    CODEX_REASONING_LABELS,
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    getCodexModel,
    resolveCodexReasoningEffort,
    type CodexReasoningEffort,
} from '../../config/codexModels';

interface CodexProviderCardProps {
    hasAccounts: boolean;
    preferredModel?: string;
    reasoningEffort?: CodexReasoningEffort;
    onAddAccount: () => void;
    onManageAccounts: () => void;
    onPreferredModelChange?: (modelId: string) => void;
    onReasoningEffortChange?: (effort: CodexReasoningEffort, modelId: string) => void;
    testStatus: 'idle' | 'testing' | 'success' | 'error';
    testError?: string;
    onTestConnection: () => void;
}

export const CodexProviderCard: React.FC<CodexProviderCardProps> = ({
    hasAccounts,
    preferredModel,
    reasoningEffort,
    onAddAccount,
    onManageAccounts,
    onPreferredModelChange,
    onReasoningEffortChange,
    testStatus,
    testError,
    onTestConnection,
}) => {
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isReasoningDropdownOpen, setIsReasoningDropdownOpen] = useState(false);
    const selected = getCodexModel(preferredModel || DEFAULT_CODEX_MODEL) || CODEX_MODELS[1];
    const selectedEffort = resolveCodexReasoningEffort(
        selected.id,
        reasoningEffort || DEFAULT_CODEX_REASONING_EFFORT,
    );
    const activePreset = CODEX_EXPERIENCE_PRESETS.find((preset) => (
        preset.modelId === selected.id && preset.reasoningEffort === selectedEffort
    ));

    const applySelection = (modelId: string, effort: CodexReasoningEffort) => {
        const normalizedEffort = resolveCodexReasoningEffort(modelId, effort);
        onPreferredModelChange?.(modelId);
        onReasoningEffortChange?.(normalizedEffort, modelId);
    };

    return (
        <div className="relative overflow-visible bg-bg-card rounded-xl p-5 border border-border-subtle shadow-sm">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <label className="min-w-0 flex flex-wrap items-center gap-2 text-xs font-medium text-text-primary uppercase tracking-wide">
                    <span className="shrink-0">Codex</span>
                    {hasAccounts && (
                        <span className="flex flex-wrap items-center gap-1 normal-case">
                            <CheckCircle size={12} className="text-green-500" />
                            <span className="text-green-500 text-[10px]">Active</span>
                            <span className="bg-bg-elevated border border-border-muted text-text-primary text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                                OAuth
                            </span>
                        </span>
                    )}
                </label>
                <button
                    onClick={() => {
                        // @ts-ignore
                        window.electronAPI?.openExternal('https://openai.com/codex');
                    }}
                    className="shrink-0 text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 transition-colors"
                    title="Learn about Codex"
                >
                    <span className="text-[10px] uppercase tracking-wide">About</span>
                    <ExternalLink size={12} />
                </button>
            </div>

            {!hasAccounts && (
                <div className="flex gap-2 mb-3">
                    <div className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-secondary flex items-center gap-2">
                        <Shield size={14} className="text-text-tertiary" />
                        <span>No ChatGPT account connected</span>
                    </div>
                    <button
                        onClick={onAddAccount}
                        className="px-5 py-2.5 rounded-lg text-xs font-medium bg-accent-primary text-black hover:opacity-90 transition-colors flex items-center gap-1.5"
                    >
                        <Plus size={14} />
                        Add Account
                    </button>
                </div>
            )}

            {hasAccounts && (
                <>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                        <div className="flex items-center gap-1 bg-bg-elevated border border-border-muted rounded-md px-2 py-1 text-[11px] font-mono text-text-primary">
                            <CheckCircle size={10} className="text-green-500" />
                            <span>ChatGPT OAuth connected</span>
                        </div>
                        <button
                            onClick={onAddAccount}
                            className="flex items-center gap-1 bg-bg-elevated border border-dashed border-border-muted rounded-md px-2 py-1 text-[10px] text-text-secondary hover:text-accent-primary hover:border-accent-primary/30 transition-colors"
                        >
                            <Plus size={10} />
                            Add
                        </button>
                    </div>
                </>
            )}

            {hasAccounts && (
                <div className="mb-4">
                    <div className="mb-2 flex items-end justify-between gap-3">
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-secondary">Response profile</p>
                            <p className="mt-0.5 text-[10px] text-text-tertiary">Choose by outcome. Advanced controls remain below.</p>
                        </div>
                        {activePreset && (
                            <span className="rounded-full border border-accent-primary/20 bg-accent-primary/10 px-2 py-0.5 text-[9px] font-semibold text-accent-primary">
                                {activePreset.label}
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border-subtle bg-bg-input p-1.5">
                        {CODEX_EXPERIENCE_PRESETS.map((preset) => {
                            const isActive = activePreset?.id === preset.id;
                            return (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => applySelection(preset.modelId, preset.reasoningEffort)}
                                    className={`min-w-0 rounded-md px-2.5 py-2 text-left transition-colors active:scale-[0.98] ${isActive
                                        ? 'border border-accent-primary/20 bg-bg-elevated text-text-primary shadow-sm'
                                        : 'border border-transparent text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                                        }`}
                                >
                                    <span className="block truncate text-[11px] font-semibold">{preset.label}</span>
                                    <span className="mt-0.5 block text-[9px] leading-snug text-text-tertiary">{preset.description}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between gap-2 mb-3 w-full">
                <button
                    onClick={onTestConnection}
                    disabled={!hasAccounts || testStatus === 'testing'}
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

                {hasAccounts ? (
                    <div className="relative z-20 flex-1 min-w-[150px]">
                        <button
                            onClick={() => setIsDropdownOpen(prev => !prev)}
                            className="w-full bg-bg-elevated border border-border-muted rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary flex items-center justify-between transition-colors hover:bg-bg-input"
                            type="button"
                        >
                            <span className="truncate pr-2">{selected.label}</span>
                            <ChevronDown size={14} className={`text-text-secondary transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>

                        {isDropdownOpen && (
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full min-w-[280px] bg-bg-elevated border border-border-muted rounded-lg shadow-2xl z-[200] max-h-72 overflow-y-auto animated fadeIn">
                                <div className="p-1 space-y-0.5">
                                    {CODEX_MODELS.map((model) => (
                                        <button
                                            key={model.id}
                                            onClick={() => {
                                                setIsDropdownOpen(false);
                                                applySelection(model.id, selectedEffort);
                                            }}
                                            className={`w-full text-left px-3 py-2 text-xs rounded-md flex items-center justify-between group transition-colors ${selected.id === model.id ? 'bg-bg-input text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                            type="button"
                                        >
                                            <span className="min-w-0 pr-2">
                                                <span className="block truncate font-medium">{model.label}</span>
                                                <span className="mt-0.5 block truncate text-[9px] text-text-tertiary">{model.description}</span>
                                            </span>
                                            {selected.id === model.id && <Check size={14} className="text-accent-primary shrink-0 ml-2" />}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex-1 mx-4" />
                )}

                {hasAccounts && (
                    <div className="relative z-20 w-[118px] shrink-0">
                        <button
                            type="button"
                            onClick={() => setIsReasoningDropdownOpen(prev => !prev)}
                            className="flex w-full items-center justify-between rounded-md border border-border-muted bg-bg-elevated px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-input focus:border-accent-primary focus:outline-none"
                        >
                            <span className="truncate pr-1">{CODEX_REASONING_LABELS[selectedEffort]}</span>
                            <ChevronDown size={14} className={`shrink-0 text-text-secondary transition-transform ${isReasoningDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {isReasoningDropdownOpen && (
                            <div className="absolute right-0 top-full z-[200] mt-1 w-40 rounded-lg border border-border-muted bg-bg-elevated p-1 shadow-2xl animated fadeIn">
                                {selected.supportedReasoningEfforts.map((effort) => (
                                    <button
                                        key={effort}
                                        type="button"
                                        onClick={() => {
                                            setIsReasoningDropdownOpen(false);
                                            onReasoningEffortChange?.(effort, selected.id);
                                        }}
                                        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${selectedEffort === effort
                                            ? 'bg-bg-input text-text-primary'
                                            : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'
                                            }`}
                                    >
                                        <span>{CODEX_REASONING_LABELS[effort]}</span>
                                        {selectedEffort === effort && <Check size={13} className="text-accent-primary" />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                <button
                    onClick={onManageAccounts}
                    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors border border-border-subtle flex items-center gap-2 shrink-0 bg-accent-primary/10 text-accent-primary border-accent-primary/20 hover:bg-accent-primary/20"
                >
                    <SettingsIcon size={12} />
                    Manage
                </button>
            </div>

            {testError && <p className="text-[10px] text-red-500 mt-1.5 mb-2">{testError}</p>}
            {selectedEffort === 'ultra' && (
                <p className="mt-2 text-[10px] leading-relaxed text-amber-500">
                    Ultra delegates work to subagents. Use it for long, divisible tasks rather than live meeting answers.
                </p>
            )}
        </div>
    );
};
