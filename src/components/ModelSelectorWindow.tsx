import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { STANDARD_CLOUD_MODELS, prettifyModelId } from '../utils/modelUtils';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

// Define Model Types
interface ModelOption {
    id: string;
    name: string;
    type: 'cloud' | 'local' | 'custom' | 'ollama';
    provider?: string;
}



const ModelSelectorWindow = () => {
    const isLight = useResolvedTheme() === 'light';
    const [currentModel, setCurrentModel] = useState<string>(() => localStorage.getItem('cached-current-model') || '');
    const [availableModels, setAvailableModels] = useState<ModelOption[]>(() => {
        try {
            const cached = localStorage.getItem('cached-models');
            return cached ? JSON.parse(cached) : [];
        } catch { return []; }
    });
    const [isLoading, setIsLoading] = useState<boolean>(() => availableModels.length === 0);





    // Load Data
    useEffect(() => {
        const loadModels = async () => {
            try {
                // If we already have models, don't show loading to avoid flicker
                if (availableModels.length === 0) {
                    setIsLoading(true);
                }
                
                // 1. Get Stored Credentials (to know which Cloud providers are active)
                const creds = await window.electronAPI?.getStoredCredentials?.();

                // 2. Custom Providers
                const customProviders = await window.electronAPI?.getCustomProviders?.() || [];

                // 3. Ollama
                let ollamaModels: string[] = [];
                try {
                    let oModels = await window.electronAPI?.getAvailableOllamaModels?.();

                    // If no models found, the daemon might be DOWN — or it might
                    // simply be UP with zero models pulled. Only restart in the
                    // former case: getAvailableOllamaModels returns [] for BOTH,
                    // and forceRestartOllama does a `kill -9` that would tear down a
                    // perfectly healthy user-managed daemon (and abort an in-flight
                    // embedding-model pull). Probe reachability first.
                    if (!oModels || oModels.length === 0) {
                        try {
                            const reachable = await window.electronAPI?.isOllamaReachable?.();
                            // Reachable === false means the daemon isn't answering; only
                            // then is a restart warranted. If reachable (or the probe is
                            // unavailable on an older preload → undefined), leave it alone.
                            if (reachable === false && window.electronAPI?.forceRestartOllama) {
                                await window.electronAPI.forceRestartOllama();
                                // Wait a moment for server to come up
                                await new Promise(resolve => setTimeout(resolve, 1500));
                                // Retry fetch
                                oModels = await window.electronAPI?.getAvailableOllamaModels?.();
                            }
                        } catch (e) {
                            console.warn("Retrying Ollama failed", e);
                        }
                    }

                    if (oModels) ollamaModels = oModels;
                } catch (e) {
                    // Ignore ollama errors here
                }

                // Build the list
                const models: ModelOption[] = [];

                if (creds?.hasNativelyKey) {
                    models.push({ id: 'natively', name: 'Natively API', type: 'cloud', provider: 'natively' });
                }

                // Cloud Models — standard models + unique preferred models
                for (const [prov, cfg] of Object.entries(STANDARD_CLOUD_MODELS)) {
                    if (!cfg.hasKeyCheck(creds)) continue;
                    cfg.ids.forEach((id, i) => {
                        models.push({ id, name: cfg.names[i], type: 'cloud', provider: prov });
                    });
                    const pm = creds?.[cfg.pmKey];
                    if (pm && !cfg.ids.includes(pm)) {
                        models.push({ id: pm, name: prettifyModelId(pm), type: 'cloud', provider: prov });
                    }
                }

                // Custom Providers
                customProviders.forEach((p: any) => {
                    models.push({ id: p.id, name: p.name, type: 'custom' });
                });

                // Ollama
                ollamaModels.forEach((m: string) => {
                    models.push({ id: `ollama-${m}`, name: `${m} (Local)`, type: 'ollama' });
                });

                localStorage.setItem('cached-models', JSON.stringify(models));
                setAvailableModels(models);

                // 4. Get Current Active Model
                const config = await window.electronAPI?.getCurrentLlmConfig?.(); // Get runtime model
                if (config && config.model) {
                    setCurrentModel(config.model);
                    localStorage.setItem('cached-current-model', config.model);
                }

            } catch (err) {
                console.error("Failed to load models:", err);
            } finally {
                setIsLoading(false);
            }
        };

        loadModels();
        window.addEventListener('focus', loadModels);

        // Listen for changes
        const unsubscribe = window.electronAPI?.onModelChanged?.((modelId: string) => {
            setCurrentModel(modelId);
        });
        return () => {
            unsubscribe?.();
            window.removeEventListener('focus', loadModels);
        };
    }, []);

    const handleSelectFn = (modelId: string) => {
        setCurrentModel(modelId);
        localStorage.setItem('cached-current-model', modelId);

        window.electronAPI?.setModel(modelId)
            .then(() => window.electronAPI?.hideModelSelector?.())
            .catch((err: any) => console.error("Failed to set model:", err));
    };

    const panelClass = isLight
        ? 'bg-white border-slate-200 shadow-black/15 text-slate-950'
        : 'bg-[#202127] border-white/10 shadow-black/40 text-white';
    const mutedTextClass = isLight ? 'text-slate-500' : 'text-slate-400';
    const selectedClass = isLight
        ? 'bg-slate-100 text-slate-950'
        : 'bg-white/10 text-white';
    const idleClass = isLight
        ? 'text-slate-700 hover:bg-slate-100 hover:text-slate-950'
        : 'text-slate-300 hover:bg-white/5 hover:text-white';

    return (
        <div className="w-fit h-fit bg-transparent flex flex-col">
            <div className={`w-[240px] h-[280px] border rounded-[16px] overflow-hidden shadow-2xl p-2 flex flex-col animate-scale-in origin-top-left ${panelClass}`}>

                {isLoading ? (
                    <div className={`flex items-center justify-center py-4 ${mutedTextClass}`}>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span className="text-xs">Loading models...</span>
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-0.5">
                        {availableModels.length === 0 ? (
                            <div className={`px-4 py-3 text-center text-xs ${mutedTextClass}`}>
                                No models connected.<br />Check Settings.
                            </div>
                        ) : (
                            availableModels.map((model) => {
                                const isSelected = currentModel === model.id;
                                return (
                                    <button
                                        type="button"
                                        key={model.id}
                                        onClick={() => handleSelectFn(model.id)}
                                        className={`
                                            w-full text-left px-3 py-2 flex items-center justify-between group transition-colors duration-200 rounded-lg
                                            ${isSelected ? selectedClass : idleClass}
                                        `}
                                    >
                                        <span className="text-[12px] font-medium truncate flex-1 min-w-0" title={model.name}>{model.name}</span>
                                        {isSelected && <Check className={`w-3.5 h-3.5 shrink-0 ml-2 ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`} />}
                                    </button>
                                );
                            })
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};

export default ModelSelectorWindow;
