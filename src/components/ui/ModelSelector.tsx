import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Cloud, Terminal, Monitor, Server, Plus } from 'lucide-react';
import { STANDARD_CLOUD_MODELS, prettifyModelId } from '../../utils/modelUtils';

interface ModelSelectorProps {
    currentModel: string;
    onSelectModel: (model: string) => void;
    placement?: 'top' | 'bottom';
}

interface CustomProvider {
    id: string;
    name: string;
    curlCommand: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onSelectModel, placement = 'top' }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'cloud' | 'custom' | 'local'>('cloud');
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
    const [cloudModels, setCloudModels] = useState<{ id: string; name: string; desc: string; provider: string }[]>([]);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, maxHeight: 260 });

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            const isInsideButton = dropdownRef.current?.contains(target) ?? false;
            const isInsideMenu = menuRef.current?.contains(target) ?? false;
            if (!isInsideButton && !isInsideMenu) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Load Data
    useEffect(() => {
        if (!isOpen) return;

        const loadData = async () => {
            try {
                // Load Custom
                const custom = await window.electronAPI?.getCustomProviders() as CustomProvider[];
                if (custom) setCustomProviders(custom);

                // Load Ollama
                const local = await window.electronAPI?.getAvailableOllamaModels() as string[];
                if (local) setOllamaModels(local);

                // Build dynamic cloud models from credentials
                // @ts-ignore
                const creds = await window.electronAPI?.getStoredCredentials?.();
                const cModels: { id: string; name: string; desc: string; provider: string }[] = [];

                if (creds?.hasNativelyKey) {
                    cModels.push({ id: 'natively', name: 'Natively API', desc: 'Managed AI • Fast execution', provider: 'natively' });
                }
                for (const [prov, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
                    if (!cfg.hasKeyCheck(creds)) continue;
                    cfg.ids.forEach((id, i) => cModels.push({ id, name: cfg.names[i], desc: cfg.descs[i], provider: prov }));
                    const pm = creds?.[cfg.pmKey];
                    if (pm && !cfg.ids.includes(pm)) {
                        cModels.push({ id: pm, name: prettifyModelId(pm), desc: `${prov.charAt(0).toUpperCase() + prov.slice(1)} • Preferred`, provider: prov });
                    }
                }
                setCloudModels(cModels);
            } catch (e) {
                console.error("Failed to load models:", e);
            }
        };
        loadData();
    }, [isOpen]);

    useLayoutEffect(() => {
        if (!isOpen || !buttonRef.current) return;

        const updatePosition = () => {
            if (!buttonRef.current) return;

            const rect = buttonRef.current.getBoundingClientRect();
            const width = 288;
            const viewportPadding = 12;
            const gap = 8;
            const availableAbove = rect.top - viewportPadding - gap;
            const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
            const shouldOpenBelow = placement === 'bottom' || (placement === 'top' && availableAbove < 180 && availableBelow > availableAbove);
            const available = shouldOpenBelow ? availableBelow : availableAbove;
            const maxHeight = Math.max(160, Math.min(360, available));
            const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
            const top = shouldOpenBelow
                ? Math.min(rect.bottom + gap, window.innerHeight - maxHeight - viewportPadding)
                : Math.max(viewportPadding, rect.top - maxHeight - gap);

            setMenuPosition({ top, left, maxHeight });
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);

        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [isOpen, placement]);

    const handleSelect = (model: string) => {
        // For custom/local, we might need to pass an ID or specific format
        // The backend logic (LLMHelper) needs to know how to handle this string or we need a richer object
        // For now, consistent with existing app, we pass a string. 
        // We'll rely on a prefix convention or just the name if unique enough, 
        // OR the app state handling this selection needs to store provider type.
        // Assuming onSelectModel handles the switching logic.

        onSelectModel(model);
        setIsOpen(false);
    };

    const getModelDisplayName = (model: string) => {
        if (model.startsWith('ollama-')) return model.replace('ollama-', '');
        if (model === 'gemini-3.1-flash-lite-preview') return 'Gemini 3.1 Flash';
        if (model === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro';
        if (model === 'llama-3.3-70b-versatile') return 'Groq Llama 3.3';
        if (model === 'gpt-5.4') return 'GPT 5.4';
        if (model === 'claude-sonnet-4-6') return 'Sonnet 4.6';
        if (model === 'gpt-5.2') return 'GPT 5.2 Codex';
        if (model === 'gpt-5.1') return 'GPT 5.1 Codex';
        if (model === 'codex:gpt-5.5') return 'GPT 5.5 Codex';
        if (model === 'codex:gpt-5.4') return 'GPT 5.4 Codex';
        if (model === 'codex:gpt-5.4-mini') return 'GPT 5.4 Mini Codex';
        if (model === 'codex:gpt-5.3') return 'GPT 5.3 Codex';
        if (model === 'codex:gpt-5.2') return 'GPT 5.2 Codex';
        if (model === 'codex:gpt-5.1') return 'GPT 5.1 Codex';
        if (model === 'codex:gpt-5') return 'GPT 5 Codex';
        if (model === 'gpt-4o') return 'GPT 4o';
        if (model === 'gpt-4o-mini') return 'GPT 4o Mini';

        // Check dynamic cloud models
        const cloud = cloudModels.find(m => m.id === model);
        if (cloud) return cloud.name;

        // Check custom providers
        const custom = customProviders.find(p => p.id === model || p.name === model);
        if (custom) return custom.name;

        return model;
    };

    return (
        <div className="relative no-drag z-[90]" ref={dropdownRef}>
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-1.5 min-w-[154px] max-w-[190px] rounded-lg border border-black/15 bg-white/95 text-slate-950 shadow-sm transition-colors text-xs font-semibold dark:border-white/15 dark:bg-[#15171c]/95 dark:text-white dark:shadow-black/30 hover:bg-white dark:hover:bg-[#1d2027]"
            >
                <span className="truncate flex-1 text-left">{getModelDisplayName(currentModel)}</span>
                <ChevronDown size={14} className={`shrink-0 text-slate-600 dark:text-slate-300 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    className="fixed w-72 bg-white text-slate-950 border border-slate-200 rounded-xl shadow-2xl shadow-black/20 z-[10000] overflow-hidden animated fadeIn dark:bg-[#15171c] dark:text-slate-50 dark:border-white/15 dark:shadow-black/50"
                    style={{ top: menuPosition.top, left: menuPosition.left }}
                >
                    {/* Tabs */}
                    <div className="flex border-b border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5">
                        <button
                            onClick={() => setActiveTab('cloud')}
                            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === 'cloud' ? 'border-t-2 border-t-emerald-500 bg-white text-emerald-600 dark:bg-[#1d2027] dark:text-emerald-300' : 'text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white'}`}
                        >
                            Cloud
                        </button>
                        <button
                            onClick={() => setActiveTab('custom')}
                            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === 'custom' ? 'border-t-2 border-t-emerald-500 bg-white text-emerald-600 dark:bg-[#1d2027] dark:text-emerald-300' : 'text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white'}`}
                        >
                            Custom
                        </button>
                        <button
                            onClick={() => setActiveTab('local')}
                            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === 'local' ? 'border-t-2 border-t-emerald-500 bg-white text-emerald-600 dark:bg-[#1d2027] dark:text-emerald-300' : 'text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white'}`}
                        >
                            Local
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-2 overflow-y-auto overscroll-contain" style={{ maxHeight: menuPosition.maxHeight }}>

                        {/* Cloud Models */}
                        {activeTab === 'cloud' && (
                            <div className="space-y-1">
                                {cloudModels.length === 0 ? (
                                    <div className="text-center py-6 text-slate-500 dark:text-slate-400">
                                        <p className="text-xs mb-2">No cloud providers configured.</p>
                                        <p className="text-[10px] opacity-70">Add API keys in Settings.</p>
                                    </div>
                                ) : (
                                    cloudModels.map((m, idx) => {
                                        const prevProvider = idx > 0 ? cloudModels[idx - 1].provider : null;
                                        const showDivider = prevProvider && prevProvider !== m.provider;
                                        const icon = m.provider === 'gemini' ? <Monitor size={14} /> : <Cloud size={14} />;
                                        return (
                                            <React.Fragment key={m.id}>
                                                {showDivider && <div className="h-px bg-slate-200 dark:bg-white/10 my-1" />}
                                                <ModelOption
                                                    id={m.id}
                                                    name={m.name}
                                                    desc={m.desc}
                                                    icon={icon}
                                                    selected={currentModel === m.id}
                                                    onSelect={() => handleSelect(m.id)}
                                                />
                                            </React.Fragment>
                                        );
                                    })
                                )}
                            </div>
                        )}

                        {/* Custom Models */}
                        {activeTab === 'custom' && (
                            <div className="space-y-1">
                                {customProviders.length === 0 ? (
                                    <div className="text-center py-6 text-slate-500 dark:text-slate-400">
                                        <p className="text-xs mb-2">No custom providers.</p>
                                        <button className="text-[10px] text-emerald-600 dark:text-emerald-300 hover:underline">Manage in Settings</button>
                                    </div>
                                ) : (
                                    customProviders.map(provider => (
                                        <ModelOption
                                            key={provider.id}
                                            id={provider.id}
                                            name={provider.name}
                                            desc="Custom cURL"
                                            icon={<Terminal size={14} />}
                                            selected={currentModel === provider.id}
                                            onSelect={() => handleSelect(provider.id)}
                                        />
                                    ))
                                )}
                            </div>
                        )}

                        {/* Local Models (Ollama) */}
                        {activeTab === 'local' && (
                            <div className="space-y-1">
                                {ollamaModels.length === 0 ? (
                                    <div className="text-center py-6 text-slate-500 dark:text-slate-400">
                                        <p className="text-xs">No Ollama models found.</p>
                                        <p className="text-[10px] mt-1 opacity-70">Ensure Ollama is running.</p>
                                    </div>
                                ) : (
                                    ollamaModels.map(model => (
                                        <ModelOption
                                            key={model}
                                            id={`ollama-${model}`}
                                            name={model}
                                            desc="Local"
                                            icon={<Server size={14} />}
                                            selected={currentModel === `ollama-${model}`}
                                            onSelect={() => handleSelect(`ollama-${model}`)}
                                        />
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

interface ModelOptionProps {
    id: string;
    name: string;
    desc: string;
    icon: React.ReactNode;
    selected: boolean;
    onSelect: () => void;
}

const ModelOption: React.FC<ModelOptionProps> = ({ name, desc, icon, selected, onSelect }) => (
    <button
        onClick={onSelect}
        className={`w-full flex items-center justify-between p-2 rounded-lg transition-colors group ${selected ? 'bg-emerald-500/10' : 'hover:bg-slate-100 dark:hover:bg-white/10'}`}
    >
        <div className="flex items-center gap-3">
            <div className={`p-1.5 rounded-md ${selected ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 group-hover:text-slate-950 dark:bg-white/10 dark:text-slate-400 dark:group-hover:text-white'}`}>
                {icon}
            </div>
            <div className="text-left">
                <div className={`text-xs font-medium truncate max-w-[140px] ${selected ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-950 dark:text-slate-50'}`}>{name}</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">{desc}</div>
            </div>
        </div>
        {selected && <Check size={14} className="text-emerald-600 dark:text-emerald-300" />}
    </button>
);
