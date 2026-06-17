import React, { useState } from 'react';
import { Plus, Trash2, AlertCircle, CheckCircle, ExternalLink, Loader2, ChevronDown, Check, Shield, Settings as SettingsIcon } from 'lucide-react';

interface CodexProviderCardProps {
    hasAccounts: boolean;
    preferredModel?: string;
    onAddAccount: () => void;
    onManageAccounts: () => void;
    onPreferredModelChange?: (modelId: string) => void;
    testStatus: 'idle' | 'testing' | 'success' | 'error';
    testError?: string;
    onTestConnection: () => void;
}

export const CodexProviderCard: React.FC<CodexProviderCardProps> = ({
    hasAccounts,
    preferredModel,
    onAddAccount,
    onManageAccounts,
    onPreferredModelChange,
    testStatus,
    testError,
    onTestConnection,
}) => {
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const models = [
        { id: 'codex:gpt-5.5', label: 'GPT 5.5 Codex' },
        { id: 'codex:gpt-5.4', label: 'GPT 5.4 Codex' },
        { id: 'codex:gpt-5.4-mini', label: 'GPT 5.4 Mini Codex' },
        { id: 'codex:gpt-5.3', label: 'GPT 5.3 Codex' },
        { id: 'codex:gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark' },
        { id: 'codex:gpt-5.2', label: 'GPT 5.2 Codex' },
        { id: 'codex:gpt-5.1', label: 'GPT 5.1 Codex' },
        { id: 'codex:gpt-5', label: 'GPT 5 Codex' },
    ];
    const selected = models.find(m => m.id === preferredModel) || models[0];

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

            <div className="flex items-center justify-between mb-3 w-full">
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
                    <div className="relative z-20 flex-1 max-w-[240px] min-w-[160px] mx-4">
                        <button
                            onClick={() => setIsDropdownOpen(prev => !prev)}
                            className="w-full bg-bg-elevated border border-border-muted rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary flex items-center justify-between transition-colors hover:bg-bg-input"
                            type="button"
                        >
                            <span className="truncate pr-2">{selected.label}</span>
                            <ChevronDown size={14} className={`text-text-secondary transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>

                        {isDropdownOpen && (
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full min-w-[240px] bg-bg-elevated border border-border-muted rounded-lg shadow-2xl z-[200] max-h-60 overflow-y-auto animated fadeIn">
                                <div className="p-1 space-y-0.5">
                                    {models.map((model) => (
                                        <button
                                            key={model.id}
                                            onClick={() => {
                                                setIsDropdownOpen(false);
                                                if (onPreferredModelChange) onPreferredModelChange(model.id);
                                            }}
                                            className={`w-full text-left px-3 py-2 text-xs rounded-md flex items-center justify-between group transition-colors ${selected.id === model.id ? 'bg-bg-input text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                            type="button"
                                        >
                                            <span className="truncate">{model.label}</span>
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

                <button
                    onClick={onManageAccounts}
                    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors border border-border-subtle flex items-center gap-2 shrink-0 bg-accent-primary/10 text-accent-primary border-accent-primary/20 hover:bg-accent-primary/20"
                >
                    <SettingsIcon size={12} />
                    Manage
                </button>
            </div>

            {testError && <p className="text-[10px] text-red-500 mt-1.5 mb-2">{testError}</p>}
        </div>
    );
};
