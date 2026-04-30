import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

const THEME_CACHE_KEY = 'natively_resolved_theme';
const fallbackPlatform = typeof process !== 'undefined' ? process.platform : '';

if (!window.electronAPI) {
  const unsubscribe = () => {};
  const unavailable = async () => ({ success: false, error: 'Electron API unavailable in browser preview' });
  const success = async () => ({ success: true });

  (window as any).electronAPI = new Proxy({
    platform: fallbackPlatform,
    getThemeMode: async () => ({ mode: 'dark', resolved: 'dark' }),
    getMeetingActive: async () => false,
    getRecentMeetings: async () => [],
    getUpcomingEvents: async () => [],
    getScreenshots: async () => [],
    getInputDevices: async () => [],
    getOutputDevices: async () => [],
    getRecognitionLanguages: async () => ({}),
    getAiResponseLanguages: async () => [],
    getSttLanguage: async () => 'english-us',
    getAiResponseLanguage: async () => 'auto',
    getSttProvider: async () => 'none',
    getUndetectable: async () => false,
    getOverlayMousePassthrough: async () => false,
    getDisguise: async () => 'none',
    getOpenAtLogin: async () => false,
    getCalendarStatus: async () => ({ connected: false }),
    getNativeAudioStatus: async () => ({ connected: false }),
    getKeybinds: async () => [],
    resetKeybinds: async () => [],
    getDefaultModel: async () => ({ model: 'gemini-3.1-flash-lite-preview' }),
    getCurrentLlmConfig: async () => ({ provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', isOllama: false }),
    getAvailableOllamaModels: async () => [],
    getStoredCredentials: async () => ({
      hasGeminiKey: false,
      hasGroqKey: false,
      hasOpenaiKey: false,
      hasClaudeKey: false,
      hasNativelyKey: false,
      googleServiceAccountPath: null,
      sttProvider: 'none',
      groqSttModel: 'whisper-large-v3-turbo',
      localSttEndpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      localSttModel: 'whisper-large-v3-turbo',
      hasSttGroqKey: false,
      hasSttOpenaiKey: false,
      hasDeepgramKey: false,
      hasElevenLabsKey: false,
      hasAzureKey: false,
      azureRegion: 'eastus',
      hasIbmWatsonKey: false,
      ibmWatsonRegion: 'us-south',
      hasSonioxKey: false,
      hasTavilyKey: false,
    }),
    updateContentDimensions: async () => {},
    openExternal: async (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
    setThemeMode: success,
    setSttProvider: success,
    setLocalSttConfig: success,
    testLocalSttConnection: unavailable,
    startMeeting: unavailable,
    endMeeting: unavailable,
    quitApp: unavailable,
  }, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => unsubscribe;
      if (typeof prop === 'string' && (prop.startsWith('get') || prop.startsWith('is'))) return async () => undefined;
      return success;
    },
  });
}

// Set platform attribute synchronously — before React renders — so CSS selectors
// like html[data-platform="win32"] work immediately without a flash on first paint.
document.documentElement.setAttribute(
  'data-platform',
  window.electronAPI?.platform ?? fallbackPlatform
);

// Step 1: Apply cached theme synchronously — before React renders.
// This ensures useResolvedTheme()'s initial useState read sees the correct value.
const cachedTheme = localStorage.getItem(THEME_CACHE_KEY) as 'light' | 'dark' | null;
document.documentElement.setAttribute('data-theme', cachedTheme ?? 'dark');

// Step 2: Confirm/correct from main process (authoritative) and keep cache in sync.
if (window.electronAPI?.getThemeMode) {
  window.electronAPI.getThemeMode().then(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  });

  window.electronAPI?.onThemeChanged?.(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
