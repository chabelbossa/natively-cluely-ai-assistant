import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, systemPreferences, screen, desktopCapturer } from "electron"
import path from "path"
import fs from "fs"
import { autoUpdater } from "electron-updater"
if (!app.isPackaged) {
  require('dotenv').config();
}

// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });

process.on('uncaughtException', (err) => {
  logToFile('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err));
});

process.on('unhandledRejection', (reason, promise) => {
  logToFile('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason));
});

// CQ-04 fix: do NOT call app.getPath() at module load time.
// app.getPath('documents') is not guaranteed to be available before app.whenReady().
// Use a lazy getter instead — the path is resolved on first logToFile() call.
let _logFile: string | null = null;
const getLogFile = (): string | null => {
  if (_logFile) return _logFile;
  try {
    _logFile = path.join(app.getPath('documents'), 'natively_debug.log');
    return _logFile;
  } catch {
    // app.ready not yet fired — return null, logToFile will skip silently
    return null;
  }
};

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

/** Maximum log file size before rotation (10 MB). */
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function logToFile(msg: string) {
  try {
    const logFile = getLogFile();
    // If the app isn't ready yet (path not available), skip silently.
    if (!logFile) return;

    // P2-1: rotate the log file when it exceeds LOG_MAX_BYTES so that long-running
    // sessions (or meetings with dense transcripts) don't fill the user's disk.
    // The previous log is kept as .log.1 for one-generation rollover.
    try {
      const stat = fs.statSync(logFile);
      if (stat.size >= LOG_MAX_BYTES) {
        const rotated = logFile + '.1';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(logFile, rotated);
      }
    } catch {
      // statSync throws if the file doesn't exist yet — that's fine
    }
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}

async function ensureMacMicrophoneAccess(context: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  try {
    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Main] macOS microphone permission before ${context}: ${currentStatus}`);

    if (currentStatus === 'granted') {
      return true;
    }

    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(
      `[Main] macOS microphone permission request during ${context}: ${granted ? 'granted' : 'denied'}`
    );
    return granted;
  } catch (error) {
    console.error(`[Main] Failed to check macOS microphone permission during ${context}:`, error);
    return false;
  }
}

/**
 * Check macOS Screen Recording (kTCCServiceScreenCapture) permission status.
 *
 * Electron has no askForMediaAccess('screen') API — macOS only shows the TCC
 * dialog when the app actually calls a protected API (SCK / CoreAudio tap).
 * If the permission is 'denied', we cannot re-prompt; the user must re-enable
 * manually in System Settings → Privacy & Security → Screen Recording.
 *
 * Returns false only when the permission is explicitly 'denied'. All other
 * statuses ('granted', 'not-determined', 'restricted') return true because:
 *   - 'granted':         already allowed — nothing to do.
 *   - 'not-determined':  macOS will show the dialog when SCK/CoreAudio tap runs.
 *   - 'restricted':      managed device policy — nothing we can do programmatically.
 */
function getMacScreenCaptureStatus(): 'granted' | 'denied' | 'not-determined' | 'restricted' {
  if (process.platform !== 'darwin') return 'granted';
  
  // In development mode, macOS TCC often falsely reports 'denied' for the electron binary 
  // even if the user has granted permission to their Terminal app.
  // Still log the REAL status for diagnostic purposes.
  if (!app.isPackaged) {
    try {
      const realStatus = systemPreferences.getMediaAccessStatus('screen');
      console.log(`[Main] Screen capture permission (dev bypass): real=${realStatus}, returning 'granted'`);
    } catch { /* ignore in dev */ }
    return 'granted';
  }

  try {
    return systemPreferences.getMediaAccessStatus('screen') as
      'granted' | 'denied' | 'not-determined' | 'restricted';
  } catch (error) {
    console.error('[Main] Failed to check screen recording permission:', error);
    return 'not-determined';
  }
}

console.log = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[LOG] ' + msg);
  try {
    originalLog.apply(console, args);
  } catch { }
};

console.warn = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[WARN] ' + msg);
  try {
    originalWarn.apply(console, args);
  } catch { }
};

console.error = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[ERROR] ' + msg);
  try {
    originalError.apply(console, args);
  } catch { }
};

import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { SettingsWindowHelper } from "./SettingsWindowHelper"
import { ModelSelectorWindowHelper } from "./ModelSelectorWindowHelper"
import { CropperWindowHelper } from "./CropperWindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { KeybindManager } from "./services/KeybindManager"
import { ProcessingHelper } from "./ProcessingHelper"

import { IntelligenceManager } from "./IntelligenceManager"
import { SystemAudioCapture } from "./audio/SystemAudioCapture"
import { MicrophoneCapture } from "./audio/MicrophoneCapture"
import { GoogleSTT } from "./audio/GoogleSTT"
import { RestSTT } from "./audio/RestSTT"
import { LocalSTT } from "./audio/LocalSTT"
import { ParakeetStreamingSTT } from "./audio/ParakeetStreamingSTT"
import { DeepgramStreamingSTT } from "./audio/DeepgramStreamingSTT"
import { SonioxStreamingSTT } from "./audio/SonioxStreamingSTT"
import { ElevenLabsStreamingSTT } from "./audio/ElevenLabsStreamingSTT"
import { OpenAIStreamingSTT } from "./audio/OpenAIStreamingSTT"
import { NativelyProSTT } from "./audio/NativelyProSTT"
import { ThemeManager } from "./ThemeManager"
import { RAGManager } from "./rag/RAGManager"
import { DatabaseManager } from "./db/DatabaseManager"
import { warmupIntentClassifier } from "./llm"
import { TranscriptRouter } from "./transcript/TranscriptRouter"
import type { RawTranscriptSegment } from "./transcript/types"
import { MeetingBriefManager } from "./meeting/MeetingBriefManager"
import { MeetingSummaryAgent } from "./meeting/MeetingSummaryAgent"
import { MeetingDebugRecorder } from "./diagnostics/MeetingDebugRecorder"
import { AudioDebugRecorder, type AudioDebugTrackName } from "./diagnostics/AudioDebugRecorder"

/** Unified type for all STT providers with optional extended capabilities */
type STTProvider = (GoogleSTT | RestSTT | LocalSTT | ParakeetStreamingSTT | DeepgramStreamingSTT | SonioxStreamingSTT | ElevenLabsStreamingSTT | OpenAIStreamingSTT | NativelyProSTT) & {
  finalize?: () => void;
  setAudioChannelCount?: (count: number) => void;
  setCredentials?: (keyPath: string) => void;
  notifySpeechEnded?: () => void;
  flushPendingTranscript?: () => void;
  /** True if this provider supports real-time speaker diarization */
  supportsDiarization?: boolean;
};

type ScreenshotWindowMode = 'launcher' | 'overlay';

/** Payload for stt-status IPC events broadcast from main to renderer */
interface SttStatusPayload {
  state: 'connected' | 'reconnecting' | 'failed';
  provider: string;
  error?: string;
  channel: 'user' | 'interviewer';
  reconnectAttempts?: number;
}
type ScreenshotCaptureKind = 'full' | 'selective';

interface ScreenshotCaptureSession {
  captureKind: ScreenshotCaptureKind;
  wasMainWindowVisible: boolean;
  windowMode: ScreenshotWindowMode;
  wasSettingsVisible: boolean;
  wasModelSelectorVisible: boolean;
  overlayBounds: Electron.Rectangle | null;
  overlayDisplayId: number | null;
  restoreWithoutFocus: boolean;
}

// Premium: Knowledge modules loaded conditionally
let KnowledgeOrchestratorClass: any = null;
let KnowledgeDatabaseManagerClass: any = null;
try {
    KnowledgeOrchestratorClass = require('../premium/electron/knowledge/KnowledgeOrchestrator').KnowledgeOrchestrator;
    KnowledgeDatabaseManagerClass = require('../premium/electron/knowledge/KnowledgeDatabaseManager').KnowledgeDatabaseManager;
} catch {
    console.log('[Main] Knowledge modules not available — profile intelligence disabled.');
}

import { CredentialsManager } from "./services/CredentialsManager"
import { SettingsManager } from "./services/SettingsManager"
import { setVerboseLoggingFlag } from "./verboseLog"
import { ReleaseNotesManager } from "./update/ReleaseNotesManager"
import { OllamaManager } from './services/OllamaManager'

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  public settingsWindowHelper: SettingsWindowHelper
  public modelSelectorWindowHelper: ModelSelectorWindowHelper
  public cropperWindowHelper: CropperWindowHelper
  private screenshotHelper: ScreenshotHelper
  public processingHelper: ProcessingHelper

  private intelligenceManager: IntelligenceManager
  private themeManager: ThemeManager
  private ragManager: RAGManager | null = null
  private knowledgeOrchestrator: any = null
  private tray: Tray | null = null
  private updateAvailable: boolean = false
  private disguiseMode: 'terminal' | 'settings' | 'activity' | 'none' = 'none'

  // View management
  private view: "queue" | "solutions" = "queue"
  private isUndetectable: boolean = false

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasDebugged: boolean = false
  private isMeetingActive: boolean = false; // Guard for session state leaks
  private isMeetingStopping: boolean = false;
  private meetingFinalizationPromise: Promise<void> | null = null;
  private lastAcceptedSttTranscriptAt: number = 0;
  private speakerSeparationEnabled: boolean = true;
  private readonly POST_STOP_STT_WAIT_MS = 45_000;
  private readonly POST_STOP_STT_MIN_WAIT_MS = 5_000;
  private _isQuitting: boolean = false;
  private _verboseLogging: boolean = false;
  private _disguiseTimers: NodeJS.Timeout[] = []; // Track forceUpdate timeouts
  private _dockDebounceTimer: NodeJS.Timeout | null = null; // Debounce dock state changes
  private _dockReassertTimers: NodeJS.Timeout[] = []; // Re-assert dock-hidden state after show+focus
  private _ollamaBootstrapPromise: Promise<void> | null = null;
  private screenshotCaptureInProgress: boolean = false;


  // Processing events
  public readonly PROCESSING_EVENTS = {
    //global states
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",

    //states for generating the initial solution
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",

    //states for processing the debugging
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  constructor() {
    // 1. Load boot-critical settings first (used by WindowHelpers)
    const settingsManager = SettingsManager.getInstance();
    this.isUndetectable = settingsManager.get('isUndetectable') ?? false;
    this.disguiseMode = settingsManager.get('disguiseMode') ?? 'none';
    this._verboseLogging = settingsManager.get('verboseLogging') ?? false;
    this.speakerSeparationEnabled = settingsManager.get('speakerSeparationEnabled') ?? true;
    setVerboseLoggingFlag(this._verboseLogging);
    console.log(`[AppState] Initialized with isUndetectable=${this.isUndetectable}, disguiseMode=${this.disguiseMode}, verboseLogging=${this._verboseLogging}`);

    // 2. Initialize Helpers with loaded state
    this.windowHelper = new WindowHelper(this)
    this.settingsWindowHelper = new SettingsWindowHelper()
    this.modelSelectorWindowHelper = new ModelSelectorWindowHelper()
    this.cropperWindowHelper = new CropperWindowHelper()

    // 3. Initialize other helpers
    this.screenshotHelper = new ScreenshotHelper(this.view)
    this.processingHelper = new ProcessingHelper(this)

    this.windowHelper.setContentProtection(this.isUndetectable);
    this.settingsWindowHelper.setContentProtection(this.isUndetectable);
    this.modelSelectorWindowHelper.setContentProtection(this.isUndetectable);
    this.cropperWindowHelper.setContentProtection(this.isUndetectable);

    if (process.platform === 'win32' || process.platform === 'darwin') {
      this.cropperWindowHelper.preload();
    }

    // Initialize KeybindManager
    const keybindManager = KeybindManager.getInstance();
    keybindManager.setWindowHelper(this.windowHelper);
    keybindManager.setupIpcHandlers();
    keybindManager.onUpdate(() => {
      this.updateTrayMenu();
    });

    keybindManager.onShortcutTriggered(async (actionId) => {
      console.log(`[Main] Global shortcut triggered: ${actionId}`);
      try {
        if (actionId === 'general:toggle-visibility') {
          this.toggleMainWindow();
        } else if (actionId === 'general:toggle-mouse-passthrough') {
          // Adapted from public PR #113 — verify premium interaction
          this.toggleOverlayMousePassthrough();
        } else if (actionId === 'general:take-screenshot') {
          // Route to renderer via global-shortcut so the renderer handles the
          // screenshot through the IPC invoke path (request/response guarantee).
          // The old pattern — main takes screenshot → fires screenshot-taken event →
          // renderer listener catches it — was unreliable in overlay mode because the
          // fire-and-forget event could be missed if the listener registration had any
          // timing gap. The invoke path used by generalHandlers.takeScreenshot() is
          // already proven to work for UI-button screenshots; reuse it here.
          const mainWindow = this.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('global-shortcut', { action: 'takeScreenshot' });
          }
        } else if (actionId === 'general:selective-screenshot') {
          const mainWindow = this.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('global-shortcut', { action: 'selectiveScreenshot' });
          }
        } else if (actionId === 'general:capture-and-process') {
          // Single-trigger: capture current screen then immediately request AI analysis
          const screenshotPath = await this.takeScreenshot(false);
          const preview = await this.getImagePreview(screenshotPath);
          // Ensure the window is visible so the user can see the response without stealing focus
          this.showMainWindow(true);
          // win.focus() can cause macOS to re-activate the app. Re-hide the dock
          // if we are in undetectable mode.
          if (process.platform === 'darwin' && this.isUndetectable) {
            app.dock.hide();
          }
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("capture-and-process", {
              path: screenshotPath,
              preview
            });
          }

        // --- STEALTH SHORTCUTS: no focus, no show, pure IPC dispatch ---

        // Chat actions — fire into the renderer without focusing the window
        } else if (
          actionId === 'chat:whatToAnswer' ||
          actionId === 'chat:clarify' ||
          actionId === 'chat:followUp' ||
          actionId === 'chat:answer' ||
          actionId === 'chat:codeHint' ||
          actionId === 'chat:brainstorm' ||
          actionId === 'chat:dynamicAction4' ||
          actionId === 'chat:scrollUp' ||
          actionId === 'chat:scrollDown'
        ) {
          const actionMap: Record<string, string> = {
            'chat:whatToAnswer': 'whatToAnswer',
            'chat:clarify': 'clarify',
            'chat:followUp': 'followUp',
            'chat:answer': 'answer',
            'chat:codeHint': 'codeHint',
            'chat:brainstorm': 'brainstorm',
            'chat:dynamicAction4': 'dynamicAction4',
            'chat:scrollUp': 'scrollUp',
            'chat:scrollDown': 'scrollDown',
          };
          const action = actionMap[actionId];
          // Send to all windows without focusing — stealth operation
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action });
            }
          });

        // Window movement — move window position without focus change
        } else if (actionId === 'window:move-up') {
          this.windowHelper.moveWindowUp();
        } else if (actionId === 'window:move-down') {
          this.windowHelper.moveWindowDown();
        } else if (actionId === 'window:move-left') {
          this.windowHelper.moveWindowLeft();
        } else if (actionId === 'window:move-right') {
          this.windowHelper.moveWindowRight();

        // General actions that are now global (stealth)
        } else if (actionId === 'general:process-screenshots') {
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action: 'processScreenshots' });
            }
          });
        } else if (actionId === 'general:reset-cancel') {
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action: 'resetCancel' });
            }
          });
        }
      } catch (e: any) {
        if (e.message !== "Selection cancelled" && e.message !== "Screenshot capture already in progress") {
          console.error(`[Main] Error handling global shortcut ${actionId}:`, e);
        }
      }
    });

    // Inject WindowHelper into other helpers
    this.settingsWindowHelper.setWindowHelper(this.windowHelper);
    this.modelSelectorWindowHelper.setWindowHelper(this.windowHelper);





    // Initialize IntelligenceManager with LLMHelper
    this.intelligenceManager = new IntelligenceManager(this.processingHelper.getLLMHelper())

    // Initialize ThemeManager
    this.themeManager = ThemeManager.getInstance()

    // Restore toggle states that live in LLMHelper memory.
    // This MUST happen here — not inside initializeRAGManager() — so that
    // it runs unconditionally regardless of whether premium modules are available.
    // Previously, groqFastTextMode restore was inside the KnowledgeOrchestrator
    // block which silently skips when premium modules are absent.
    {
      const llmHelper = this.processingHelper.getLLMHelper();
      if (settingsManager.get('groqFastTextMode')) {
        llmHelper.setGroqFastTextMode(true);
        console.log('[AppState] Fast mode restored from settings');
      }
      // Restore custom notes for non-premium path
      try {
        const savedNotes = DatabaseManager.getInstance().getCustomNotes();
        if (savedNotes) {
          llmHelper.setCustomNotes(savedNotes);
        }
      } catch (_) {}
    }

    // Initialize RAGManager (requires database to be ready)
    this.initializeRAGManager()
    
    // Check and prep Ollama embedding model
    this.bootstrapOllamaEmbeddings()


    this.setupIntelligenceEvents()

    // Pre-warm the zero-shot intent classifier in background
    warmupIntentClassifier();

    // Setup Ollama IPC
    this.setupOllamaIpcHandlers()

    // --- NEW SYSTEM AUDIO PIPELINE (SOX + NODE GOOGLE STT) ---
    // LAZY INIT: Do not setup pipeline here to prevent launch volume surge.
    // this.setupSystemAudioPipeline()

    // Initialize Auto-Updater
    this.setupAutoUpdater()
  }

  private broadcast(channel: string, ...args: any[]): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    });
  }

  public getIsMeetingActive(): boolean {
    return this.isMeetingActive;
  }

  public getIsMeetingFinalizing(): boolean {
    return this.isMeetingStopping;
  }

  public getSpeakerSeparationEnabled(): boolean {
    return this.speakerSeparationEnabled;
  }

  public setSpeakerSeparationEnabled(enabled: boolean): void {
    if (this.speakerSeparationEnabled === enabled) return;
    this.speakerSeparationEnabled = enabled;
    SettingsManager.getInstance().set('speakerSeparationEnabled', enabled);
    this.clearPendingMicEchoTranscripts('speaker_separation_toggle', false);
    this.transcriptRouter.reset();
    this.broadcast('speaker-separation-changed', { enabled });
    console.log(`[Main] Speaker separation ${enabled ? 'enabled' : 'disabled'} for live meeting routing`);
  }

  public isQuitting(): boolean {
    return this._isQuitting;
  }

  public setQuitting(value: boolean): void {
    this._isQuitting = value;
  }

  private broadcastMeetingState(): void {
    this.broadcast('meeting-state-changed', { isActive: this.isMeetingActive });
  }

  private async bootstrapOllamaEmbeddings() {
    this._ollamaBootstrapPromise = (async () => {
      try {
        const { OllamaBootstrap } = require('./rag/OllamaBootstrap');
        const bootstrap = new OllamaBootstrap();

        // Fire and forget — don't await this before showing the window
        const result = await bootstrap.bootstrap('nomic-embed-text', (status: string, percent: number) => {
          // Send progress to renderer via IPC
          this.broadcast('ollama:pull-progress', { status, percent });
        });

        if (result === 'pulled' || result === 'already_pulled') {
          this.broadcast('ollama:pull-complete');
          // Re-resolve the embedding provider given that Ollama might now be available
          if (this.ragManager) {
             console.log('[AppState] Ollama model ready, re-evaluating RAG pipeline provider');
             const { CredentialsManager } = require('./services/CredentialsManager');
             const cm = CredentialsManager.getInstance();
             this.ragManager.initializeEmbeddings({
                openaiKey: cm.getOpenaiApiKey() || process.env.OPENAI_API_KEY || undefined,
                geminiKey: cm.getGeminiApiKey() || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || undefined,
                ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434"
             });
          }
        }
      } catch (err) {
         console.error('[AppState] Failed to bootstrap Ollama:', err);
      }
    })();
  }

  private initializeRAGManager(): void {
    try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const cm = CredentialsManager.getInstance();
        const openaiKey = cm.getOpenaiApiKey() || process.env.OPENAI_API_KEY;
        const geminiKey = cm.getGeminiApiKey() || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        
        this.ragManager = new RAGManager({ 
            db: sqliteDb, 
            dbPath: db.getDbPath(),
            extPath: db.getExtPath(),
            openaiKey,
            geminiKey,
            ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434'
        });
        this.ragManager.setLLMHelper(this.processingHelper.getLLMHelper());
        console.log('[AppState] RAGManager initialized');
      }
    } catch (error) {
      console.error('[AppState] Failed to initialize RAGManager:', error);
    }

    // Initialize Knowledge Orchestrator
    try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb && KnowledgeDatabaseManagerClass && KnowledgeOrchestratorClass) {
        const knowledgeDb = new KnowledgeDatabaseManagerClass(sqliteDb);
        this.knowledgeOrchestrator = new KnowledgeOrchestratorClass(knowledgeDb);

        // Wire up LLM functions
        const llmHelper = this.processingHelper.getLLMHelper();

        // generateContent function for LLM calls
        this.knowledgeOrchestrator.setGenerateContentFn(async (contents: any[]) => {
          return await llmHelper.generateContentStructured(
            contents[0]?.text || ''
          );
        });

        // Embedding function — lazily delegate to the cascaded EmbeddingPipeline
        // (OpenAI → Gemini → Ollama → Local bundled model).
        // We await waitForReady() so uploads during boot wait for the pipeline
        // instead of immediately throwing 'not ready'.
        const self = this;
        this.knowledgeOrchestrator.setEmbedFn(async (text: string) => {
          const pipeline = self.ragManager?.getEmbeddingPipeline();
          if (!pipeline) throw new Error('RAG pipeline not available');
          await pipeline.waitForReady();
          return await pipeline.getEmbedding(text);
        });
        if (typeof this.knowledgeOrchestrator.setEmbedQueryFn === 'function') {
          this.knowledgeOrchestrator.setEmbedQueryFn(async (text: string) => {
            const pipeline = self.ragManager?.getEmbeddingPipeline();
            if (!pipeline) throw new Error('RAG pipeline not available');
            await pipeline.waitForReady();
            return await pipeline.getEmbeddingForQuery(text);
          });
        }

        // Attach KnowledgeOrchestrator to LLMHelper
        llmHelper.setKnowledgeOrchestrator(this.knowledgeOrchestrator);

        // Restore persisted toggle states so UI reflects what the user left them as.
        // NOTE: groqFastTextMode is now restored unconditionally in the AppState constructor
        // so it is not repeated here.
        const sm = SettingsManager.getInstance();
        if (sm.get('knowledgeMode')) {
          this.knowledgeOrchestrator.setKnowledgeMode(true);
          console.log('[AppState] Knowledge mode restored from settings');
        }

        // Restore custom notes so orchestrator has them from first request
        const savedNotes = DatabaseManager.getInstance().getCustomNotes();
        if (savedNotes) {
          this.knowledgeOrchestrator.setCustomNotes(savedNotes);
          llmHelper.setCustomNotes(savedNotes);
          console.log('[AppState] Custom notes restored');
        }

        console.log('[AppState] KnowledgeOrchestrator initialized');
      }
    } catch (error) {
      console.error('[AppState] Failed to initialize KnowledgeOrchestrator:', error);
    }
  }

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false  // Manual install only via button

    // Default to latest (stable) channel - matches latest.yml generated by electron-builder
    autoUpdater.channel = 'latest'
    console.log(`[AutoUpdater] Channel: ${autoUpdater.channel}`)

    autoUpdater.on("checking-for-update", () => {
      console.log("[AutoUpdater] Checking for update...")
      this.broadcast("update-checking")
    })

    autoUpdater.on("update-available", async (info) => {
      console.log("[AutoUpdater] Update available:", info.version)
      this.updateAvailable = true

      // Fetch structured release notes
      const releaseManager = ReleaseNotesManager.getInstance();
      const notes = await releaseManager.fetchReleaseNotes(info.version);

      // Notify renderer that an update is available with parsed notes if available
      this.broadcast("update-available", {
        ...info,
        parsedNotes: notes
      })
    })

    autoUpdater.on("update-not-available", (info) => {
      console.log("[AutoUpdater] Update not available:", info.version)
      this.broadcast("update-not-available", info)
    })

    autoUpdater.on("error", (err) => {
      console.error("[AutoUpdater] Error:", err)
      // Include more details in the error message for debugging
      const errorMessage = err.message || err.toString() || 'Unknown update error'
      this.broadcast("update-error", errorMessage)
    })

    autoUpdater.on("download-progress", (progressObj) => {
      let log_message = "Download speed: " + progressObj.bytesPerSecond
      log_message = log_message + " - Downloaded " + progressObj.percent + "%"
      log_message = log_message + " (" + progressObj.transferred + "/" + progressObj.total + ")"
      console.log("[AutoUpdater] " + log_message)
      this.broadcast("download-progress", progressObj)
    })

    autoUpdater.on("update-downloaded", (info) => {
      console.log("[AutoUpdater] Update downloaded:", info.version)
      // Notify renderer that update is ready to install
      this.broadcast("update-downloaded", info)
    })

    // Start checking for updates with a 10-second delay
    setTimeout(() => {
      if (process.env.NODE_ENV === "development") {
        console.log("[AutoUpdater] Development mode: Skipping auto check (use manual button)");
      } else {
        autoUpdater.checkForUpdatesAndNotify().catch(err => {
          console.error("[AutoUpdater] Failed to check for updates:", err);
        });
      }
    }, 10000);
  }

  private async checkForUpdatesManual(): Promise<void> {
    try {
      console.log('[AutoUpdater] Checking for updates manually via GitHub API...');
      const releaseManager = ReleaseNotesManager.getInstance();
      // Fetch latest release
      const notes = await releaseManager.fetchReleaseNotes('latest');

      if (notes) {
        const currentVersion = app.getVersion();
        const latestVersionTag = notes.version; // e.g., "v1.2.0" or "1.2.0"
        const latestVersion = latestVersionTag.replace(/^v/, '');

        console.log(`[AutoUpdater] Manual Check: Current=${currentVersion}, Latest=${latestVersion}`);

        if (this.isVersionNewer(currentVersion, latestVersion)) {
          console.log('[AutoUpdater] Manual Check: New version found!');
          this.updateAvailable = true;

          // Mock an info object compatible with electron-updater
          const info = {
            version: latestVersion,
            files: [] as any[],
            path: '',
            sha512: '',
            releaseName: notes.summary,
            releaseNotes: notes.fullBody
          };

          // Notify renderer
          this.broadcast("update-available", {
            ...info,
            parsedNotes: notes
          });
        } else {
          console.log('[AutoUpdater] Manual Check: App is up to date.');
          this.broadcast("update-not-available", { version: currentVersion });
        }
      }
    } catch (err) {
      console.error('[AutoUpdater] Manual update check failed:', err);
    }
  }

  private isVersionNewer(current: string, latest: string): boolean {
    // EC-01 fix: strip pre-release suffixes (e.g. "2.1.0-beta.1" → "2.1.0")
    // before splitting so Number() never returns NaN on comparison.
    const stripPre = (v: string) => v.replace(/-.*$/, '');
    const c = stripPre(current).split('.').map(Number);
    const l = stripPre(latest).split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const cv = c[i] || 0;
      const lv = l[i] || 0;
      if (lv > cv) return true;
      if (lv < cv) return false;
    }
    return false;
  }


  public async quitAndInstallUpdate(): Promise<void> {
    console.log('[AutoUpdater] quitAndInstall called - applying update...')

    // On macOS, unsigned apps can't auto-restart via quitAndInstall
    // Workaround: Open the folder containing the downloaded update so user can install manually
    if (process.platform === 'darwin') {
      try {
        // Get the downloaded update file path (e.g., .../Natively-1.0.9-mac.zip)
        const updateFile = (autoUpdater as any).downloadedUpdateHelper?.file
        console.log('[AutoUpdater] Downloaded update file:', updateFile)

        if (updateFile) {
          const updateDir = path.dirname(updateFile)
          // Open the directory containing the update in Finder
          await shell.openPath(updateDir)
          console.log('[AutoUpdater] Opened update directory:', updateDir)

          // Quit the app so user can install new version
          setTimeout(() => app.quit(), 1000)
          return
        }
      } catch (err) {
        console.error('[AutoUpdater] Failed to open update directory:', err)
      }
    }

    // Fallback to standard quitAndInstall (works on Windows/Linux or if signed)
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (err) {
        console.error('[AutoUpdater] quitAndInstall failed:', err)
        app.exit(0)
      }
    })
  }

  public async checkForUpdates(): Promise<void> {
    console.log('[AutoUpdater] Manual check for updates requested')
    try {
      // In development mode, use manual GitHub API check (electron-updater skips in dev)
      if (process.env.NODE_ENV === "development") {
        await this.checkForUpdatesManual()
      } else {
        await autoUpdater.checkForUpdatesAndNotify()
      }
    } catch (err: any) {
      console.error('[AutoUpdater] checkForUpdates failed:', err)
      const errorMessage = err.message || err.toString() || 'Update check failed'
      this.broadcast("update-error", errorMessage)
    }
  }

  public downloadUpdate(): void {
    console.log('[AutoUpdater] Starting download...')
    try {
      // Errors during download are surfaced via autoUpdater.on("error") which
      // already broadcasts "update-error". Do not broadcast here to avoid duplicates.
      autoUpdater.downloadUpdate().catch(err => {
        console.error('[AutoUpdater] downloadUpdate failed:', err)
      })
    } catch (err: any) {
      console.error('[AutoUpdater] downloadUpdate exception:', err)
    }
  }

  // New Property for System Audio & Microphone
  private systemAudioCapture: SystemAudioCapture | null = null;
  private microphoneCapture: MicrophoneCapture | null = null;
  private audioTestCapture: MicrophoneCapture | null = null; // For audio settings test
  private audioDebugRecorder: AudioDebugRecorder | null = null;
  private _audioTestStarting = false;               // P2-12: in-flight guard against concurrent calls
  private googleSTT: STTProvider | null = null; // Interviewer
  private googleSTT_User: STTProvider | null = null; // User
  private audioLevelLastLogAt: Record<'interviewer' | 'user', number> = {
    interviewer: 0,
    user: 0,
  };
  private _lastSystemAudioLevel: { rms: number; peak: number } | null = null;
  private _systemAudioSilentWarningActive = false;
  private sttTranscriptLogCounters: Record<string, number> = {};
  private sttTranscriptLastLogAt: Record<string, number> = {};

  // ── Mic Audio Gate ──
  // When system audio is non-silent, the microphone picks up speaker output as
  // room echo and produces duplicate transcripts. We gate quiet mic chunks while
  // system audio plays, but allow strong near-field mic chunks so the user can
  // still interrupt or answer during a call.
  private _micGated = false;
  private _micGateReopenTimer: NodeJS.Timeout | null = null;
  private readonly _MIC_GATE_REOPEN_DELAY_MS = 1200; // reopen mic 1.2s after system silence
  private readonly _MIC_GATE_RMS_THRESHOLD = 50;     // system audio RMS above this → gate mic
  private readonly _MIC_GATE_PEAK_THRESHOLD = 150;    // system audio peak above this → gate mic
  private readonly _MIC_GATE_OVERRIDE_RMS = 900;      // likely direct user speech → let mic through
  private readonly _MIC_GATE_OVERRIDE_PEAK = 3000;
  private readonly _MIC_GATE_DIRECT_SPEECH_RATIO = 1.35; // mic must clearly beat system level while gated
  private readonly _MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO = 2.2;
  private readonly _MIC_GATE_ECHO_HISTORY_MS = 1800;
  private readonly _MIC_GATE_MAX_ECHO_FRAMES = 96;
  private readonly _MIC_GATE_ECHO_CORRELATION_THRESHOLD = 0.78;
  private _micGateActivations = 0;
  private _micGateDeactivations = 0;
  private _micGateDroppedChunks = 0;
  private _micGateAllowedStrongChunks = 0;
  private _micGateDroppedRelativeEchoChunks = 0;
  private _micGateDroppedCorrelatedEchoChunks = 0;
  private _recentSystemEchoFrames: Array<{ timestamp: number; envelope: Float32Array; rms: number; peak: number }> = [];

  // ── Cross-channel transcript deduplication ──
  // When system audio is active, the microphone picks up speaker output as room
  // echo. Both channels produce near-identical transcripts. We keep a rolling
  // buffer of recent final transcripts per channel and suppress duplicates.
  // Priority: Speaker (system audio) is the clean digital source — when both
  // channels produce the same text, suppress the Mic copy.
  private _recentTranscripts: Array<{ channel: 'interviewer' | 'user'; effectiveSpeaker: string; text: string; timestamp: number }> = [];
  private readonly _DEDUP_WINDOW_MS = 12000; // 12-second window (wider to catch delayed mic echoes)
  private readonly _DEDUP_SIMILARITY_THRESHOLD = 0.45; // 45% overlap (more aggressive echo suppression)
  private _dedupSuppressedCount = 0;
  private _dedupPreservedSystemCount = 0;
  private _pendingMicEchoTranscripts: Array<{
    id: number;
    text: string;
    timestamp: number;
    final: boolean;
    provider: string;
    timer: NodeJS.Timeout;
    deliver: () => void;
  }> = [];
  private _pendingMicEchoSeq = 0;
  private _pendingMicHeldCount = 0;
  private _pendingMicDroppedCount = 0;
  private _pendingMicDroppedPartialCount = 0;
  private _pendingMicDroppedAmbiguousCount = 0;
  private _pendingMicAllowedInterventionCount = 0;
  private _pendingMicReleasedCount = 0;
  private _lastSystemAudioNonSilentAt = 0;
  private readonly _MIC_ECHO_GRACE_MS = 2500;
  private readonly _MIC_INTERVENTION_GRACE_MS = 900;
  private readonly _SYSTEM_AUDIO_ACTIVE_WINDOW_MS = 3500;
  private readonly transcriptRouter = new TranscriptRouter();
  private readonly meetingBriefManager = MeetingBriefManager.getInstance();

  /**
   * Normalized similarity between two strings (Dice coefficient on word bigrams).
   * Returns 0..1, where 1 = identical.
   */
  private textSimilarity(a: string, b: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1;
    if (!na || !nb) return 0;
    const wordsA = na.split(' ');
    const wordsB = nb.split(' ');
    const bigramsA = new Set(wordsA.map((w, i) => i < wordsA.length - 1 ? `${w} ${wordsA[i + 1]}` : null).filter(Boolean));
    const bigramsB = new Set(wordsB.map((w, i) => i < wordsB.length - 1 ? `${w} ${wordsB[i + 1]}` : null).filter(Boolean));
    if (bigramsA.size === 0 && bigramsB.size === 0) {
      // Single-word comparison fallback
      const setA = new Set(wordsA);
      const setB = new Set(wordsB);
      const intersection = [...setA].filter(w => setB.has(w)).length;
      return (2 * intersection) / (setA.size + setB.size);
    }
    const intersection = [...bigramsA].filter(b => bigramsB.has(b)).length;
    return (2 * intersection) / (bigramsA.size + bigramsB.size);
  }

  private normalizeForEchoComparison(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getEchoMatch(a: string, b: string): { match: boolean; similarity: number } {
    const similarity = this.textSimilarity(a, b);
    if (similarity >= this._DEDUP_SIMILARITY_THRESHOLD) {
      return { match: true, similarity };
    }

    const left = this.normalizeForEchoComparison(a);
    const right = this.normalizeForEchoComparison(b);
    if (!left || !right) return { match: false, similarity };

    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    const shorterWords = shorter.split(' ').filter(Boolean).length;
    const lengthRatio = shorter.length / Math.max(longer.length, 1);

    return {
      match: shorterWords >= 4 && lengthRatio >= 0.38 && longer.includes(shorter),
      similarity,
    };
  }

  private findRecentSystemEchoMatch(
    text: string,
    timestamp: number,
  ): { match: boolean; similarity: number; text: string; effectiveSpeaker: string } | null {
    const recentSystem = this._recentTranscripts
      .filter(recent =>
        recent.channel === 'interviewer' &&
        timestamp - recent.timestamp <= this._DEDUP_WINDOW_MS
      )
      .sort((a, b) => b.timestamp - a.timestamp);

    for (const recent of recentSystem) {
      const match = this.getEchoMatch(text, recent.text);
      if (match.match) {
        return {
          match: true,
          similarity: match.similarity,
          text: recent.text,
          effectiveSpeaker: recent.effectiveSpeaker,
        };
      }
    }

    return null;
  }

  private looksLikeLocalUserIntervention(text: string): boolean {
    const normalized = this.normalizeForEchoComparison(text);
    if (!normalized) return false;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 3) return false;

    const hasQuestionSignal = /\?$/.test(text.trim()) ||
      /\b(est ce que|est ce qu|pourquoi|comment|quand|qui|quel|quelle|quels|quelles|combien|où|what|why|how|when|where|who|which|can you|could you|do you|does it)\b/i.test(normalized);

    const hasLearnerSignal = /\b(si je comprends|je comprends|si j ai bien compris|j ai bien compris|je ne comprends|je n ai pas compris|je veux comprendre|je voulais demander|je voulais savoir|je veux savoir|j aimerais savoir|ma question|j ai une question|ca veut dire|ça veut dire|donc si|pour mieux comprendre|que dire)\b/i.test(normalized);

    const hasPromptingSignal = /\b(explique|expliquez|precise|précise|clarifie|clarifiez|reprends|reprenez|dis nous|dites nous|dis moi|dites moi|peux tu|pouvez vous|tu peux|vous pouvez|tell me|explain|clarify)\b/i.test(normalized);

    const hasTurnSignal = /\b(ok|okay|d accord|daccord|attends|attendez|pardon|excuse moi|excusez moi|je te suis|je vous suis)\b/i.test(normalized) &&
      words.length >= 5;

    return hasQuestionSignal || hasLearnerSignal || hasPromptingSignal || hasTurnSignal;
  }

  private isSystemAudioRecentlyActive(timestamp: number): boolean {
    if (timestamp - this._lastSystemAudioNonSilentAt <= this._SYSTEM_AUDIO_ACTIVE_WINDOW_MS) {
      return true;
    }
    return this._recentTranscripts.some(
      recent => recent.channel === 'interviewer' && timestamp - recent.timestamp <= this._DEDUP_WINDOW_MS
    );
  }

  private cancelPendingMicEchoMatches(
    systemText: string,
    timestamp: number,
    meta: { provider: string; isFinal: boolean; effectiveSpeaker: string },
  ): number {
    let dropped = 0;
    const remaining: typeof this._pendingMicEchoTranscripts = [];

    for (const pending of this._pendingMicEchoTranscripts) {
      if (timestamp - pending.timestamp > this._DEDUP_WINDOW_MS) {
        remaining.push(pending);
        continue;
      }

      const match = this.getEchoMatch(pending.text, systemText);
      if (!match.match) {
        remaining.push(pending);
        continue;
      }

      clearTimeout(pending.timer);
      dropped++;
      this._pendingMicDroppedCount++;
      if (this._pendingMicDroppedCount <= 12 || this._pendingMicDroppedCount % 25 === 0) {
        console.log(`[STT][echo-delay] drop-pending-mic #${this._pendingMicDroppedCount} provider=${meta.provider} matched=${meta.effectiveSpeaker} sim=${match.similarity.toFixed(2)} final=${meta.isFinal} mic="${pending.text.substring(0, 90)}" system="${systemText.substring(0, 90)}"`);
      }
    }

    this._pendingMicEchoTranscripts = remaining;
    return dropped;
  }

  private queueMicEchoCandidate(
    text: string,
    timestamp: number,
    meta: { provider: string; isFinal: boolean },
    deliver: () => void,
  ): boolean {
    if (text.length < 8) return false;
    if (!this.isSystemAudioRecentlyActive(timestamp)) return false;

    const recentEcho = this.findRecentSystemEchoMatch(text, timestamp);
    if (recentEcho) {
      this._pendingMicDroppedCount++;
      if (this._pendingMicDroppedCount <= 12 || this._pendingMicDroppedCount % 25 === 0) {
        console.log(`[STT][echo-delay] drop-mic-recent-system #${this._pendingMicDroppedCount} provider=${meta.provider} matched=${recentEcho.effectiveSpeaker} sim=${recentEcho.similarity.toFixed(2)} final=${meta.isFinal} mic="${text.substring(0, 90)}" system="${recentEcho.text.substring(0, 90)}"`);
      }
      return true;
    }

    const looksLikeUserIntervention = this.looksLikeLocalUserIntervention(text);

    // Live previews are noisy by nature: when system audio is active, most mic
    // partials are room echo. Keep only partials that already look like the
    // user is interrupting, asking, or clarifying, then delay them long enough
    // for a matching system transcript to cancel the echo.
    if (!meta.isFinal && !looksLikeUserIntervention) {
      this._pendingMicDroppedPartialCount++;
      if (this._pendingMicDroppedPartialCount <= 12 || this._pendingMicDroppedPartialCount % 25 === 0) {
        console.log(`[STT][echo-delay] drop-mic-partial #${this._pendingMicDroppedPartialCount} provider=${meta.provider} text="${text.substring(0, 90)}"`);
      }
      return true;
    }

    if (!looksLikeUserIntervention) {
      this._pendingMicDroppedAmbiguousCount++;
      if (this._pendingMicDroppedAmbiguousCount <= 12 || this._pendingMicDroppedAmbiguousCount % 25 === 0) {
        console.log(`[STT][echo-delay] drop-mic-ambiguous #${this._pendingMicDroppedAmbiguousCount} provider=${meta.provider} final=${meta.isFinal} text="${text.substring(0, 90)}"`);
      }
      return true;
    }

    this._pendingMicAllowedInterventionCount++;
    if (this._pendingMicAllowedInterventionCount <= 12 || this._pendingMicAllowedInterventionCount % 25 === 0) {
      console.log(`[STT][echo-delay] hold-user-intervention #${this._pendingMicAllowedInterventionCount} provider=${meta.provider} grace=${this._MIC_INTERVENTION_GRACE_MS}ms text="${text.substring(0, 90)}"`);
    }

    const id = ++this._pendingMicEchoSeq;
    const timer = setTimeout(() => {
      const index = this._pendingMicEchoTranscripts.findIndex(pending => pending.id === id);
      if (index === -1) return;
      const [pending] = this._pendingMicEchoTranscripts.splice(index, 1);
      this._pendingMicReleasedCount++;
      if (this._pendingMicReleasedCount <= 12 || this._pendingMicReleasedCount % 25 === 0) {
        console.log(`[STT][echo-delay] release-mic #${this._pendingMicReleasedCount} provider=${pending.provider} final=${pending.final} waited=${Date.now() - pending.timestamp}ms text="${pending.text.substring(0, 90)}"`);
      }
      pending.deliver();
    }, this._MIC_INTERVENTION_GRACE_MS);

    this._pendingMicEchoTranscripts.push({
      id,
      text,
      timestamp,
      final: meta.isFinal,
      provider: meta.provider,
      timer,
      deliver,
    });

    this._pendingMicHeldCount++;
    if (this._pendingMicHeldCount <= 12 || this._pendingMicHeldCount % 25 === 0) {
      console.log(`[STT][echo-delay] hold-mic #${this._pendingMicHeldCount} provider=${meta.provider} final=${meta.isFinal} grace=${this._MIC_INTERVENTION_GRACE_MS}ms text="${text.substring(0, 90)}"`);
    }
    return true;
  }

  private clearPendingMicEchoTranscripts(reason: string, flush: boolean): void {
    const pending = this._pendingMicEchoTranscripts.splice(0);
    if (pending.length === 0) return;

    console.log(`[STT][echo-delay] clear pending=${pending.length} reason=${reason} flush=${flush}`);
    for (const item of pending) {
      clearTimeout(item.timer);
      if (flush) {
        item.deliver();
      }
    }
  }

  /**
   * Check if this transcript is a cross-channel duplicate.
   * Returns true if it should be suppressed.
   */
  private isCrossChannelDuplicate(
    channel: 'interviewer' | 'user',
    effectiveSpeaker: string,
    text: string,
    timestamp: number,
    meta: { provider: string; isFinal: boolean; diarized: boolean; speakerId?: number } = {
      provider: 'unknown',
      isFinal: false,
      diarized: false,
    },
  ): boolean {
    // Purge old entries
    this._recentTranscripts = this._recentTranscripts.filter(
      t => timestamp - t.timestamp < this._DEDUP_WINDOW_MS
    );

    // Check against the OTHER channel's recent transcripts
    const otherChannel = channel === 'interviewer' ? 'user' : 'interviewer';
    for (const recent of this._recentTranscripts) {
      if (recent.channel !== otherChannel) continue;
      const match = this.getEchoMatch(text, recent.text);
      if (match.match) {
        // Speaker/system audio is the canonical source for "the other person".
        // If mic echo arrives first, do NOT suppress the later system transcript;
        // preserving system context is more important than avoiding one visible
        // duplicate line.
        if (channel === 'interviewer') {
          this._dedupPreservedSystemCount++;
          if (this._dedupPreservedSystemCount <= 10 || this._dedupPreservedSystemCount % 20 === 0) {
            console.log(`[STT][dedup] preserve-system #${this._dedupPreservedSystemCount} provider=${meta.provider} effective=${effectiveSpeaker} matched=${recent.effectiveSpeaker} sim=${match.similarity.toFixed(2)} final=${meta.isFinal} diarized=${meta.diarized} speakerId=${meta.speakerId ?? 'none'} text="${text.substring(0, 80)}..."`);
          }
          break;
        }

        this._dedupSuppressedCount++;
        if (this._dedupSuppressedCount <= 10 || this._dedupSuppressedCount % 20 === 0) {
          console.log(`[STT][dedup] suppress-mic-echo #${this._dedupSuppressedCount} provider=${meta.provider} effective=${effectiveSpeaker} matched=${recent.effectiveSpeaker} sim=${match.similarity.toFixed(2)} final=${meta.isFinal} text="${text.substring(0, 80)}..."`);
        }
        return true;
      }
    }

    // Record this transcript for future cross-channel checks
    this._recentTranscripts.push({ channel, effectiveSpeaker, text, timestamp });
    return false;
  }

  private shouldLogSttTranscriptTrace(key: string, isFinal: boolean): boolean {
    const now = Date.now();
    const count = (this.sttTranscriptLogCounters[key] || 0) + 1;
    this.sttTranscriptLogCounters[key] = count;

    if (isFinal || count <= 5 || count % 25 === 0) {
      this.sttTranscriptLastLogAt[key] = now;
      return true;
    }

    const last = this.sttTranscriptLastLogAt[key] || 0;
    if (now - last > 5000) {
      this.sttTranscriptLastLogAt[key] = now;
      return true;
    }

    return false;
  }

  private getPcm16Level(chunk: Buffer): { rms: number; peak: number } {
    if (!chunk || chunk.length < 2) return { rms: 0, peak: 0 };

    let sumSquares = 0;
    let peak = 0;
    let count = 0;
    const step = Math.max(2, Math.floor((chunk.length / 2) / 1200) * 2);
    for (let i = 0; i < chunk.length - 1; i += step) {
      const sample = chunk.readInt16LE(i);
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sumSquares += sample * sample;
      count++;
    }

    return {
      rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
      peak,
    };
  }

  private maybeLogAudioLevel(channel: 'interviewer' | 'user', chunk: Buffer): void {
    const now = Date.now();
    if (now - this.audioLevelLastLogAt[channel] < 5000) return;
    this.audioLevelLastLogAt[channel] = now;

    const level = this.getPcm16Level(chunk);
    const label = channel === 'interviewer' ? 'system' : 'mic';
    console.log(`[Main][audio-level] ${label} rms=${level.rms.toFixed(1)} peak=${level.peak}${channel === 'interviewer' ? ` micGated=${this._micGated}` : ''}`);
    MeetingDebugRecorder.getInstance().recordAudioHealth({
      channel: label,
      rms: Number(level.rms.toFixed(1)),
      peak: level.peak,
      micGated: this._micGated,
    });

    // Persist last system audio level for the health check
    if (channel === 'interviewer') {
      this._lastSystemAudioLevel = level;
      if (level.rms > 25 || level.peak > 80) {
        this._lastSystemAudioNonSilentAt = now;
        if (this._systemAudioSilentWarningActive) {
          this._systemAudioSilentWarningActive = false;
          MeetingDebugRecorder.getInstance().recordAudioHealth({
            channel: 'system',
            status: 'recovered_after_silence',
            rms: Number(level.rms.toFixed(1)),
            peak: level.peak,
          });
          this.broadcast('system-audio-active', {
            message: 'System audio is now audible. Speaker separation is active.',
            rms: Number(level.rms.toFixed(1)),
            peak: level.peak,
          });
        }
      }
    }
  }

  private startAudioDebugRecording(metadata?: any): void {
    try {
      this.audioDebugRecorder?.abort();
      const { CredentialsManager } = require('./services/CredentialsManager');
      const sttProvider = CredentialsManager.getInstance().getSttProvider?.();
      this.audioDebugRecorder = new AudioDebugRecorder();
      this.audioDebugRecorder.start({
        debugTracePath: MeetingDebugRecorder.getInstance().getCurrentFilePath(),
        metadata: {
          ...(metadata || {}),
          sttProvider,
        },
      });
    } catch (error: any) {
      this.audioDebugRecorder = null;
      console.warn('[AudioDebugRecorder] Failed to start audio debug recording:', error?.message || error);
    }
  }

  private writeAudioDebugTrack(track: AudioDebugTrackName, chunk: Buffer, sampleRate: number): void {
    this.audioDebugRecorder?.writeTrack(track, chunk, sampleRate || 48000);
  }

  private createPcmEnvelope(chunk: Buffer): Float32Array | null {
    const sampleCount = Math.floor(chunk.length / 2);
    if (sampleCount < 32) return null;

    const bucketCount = 32;
    const sums = new Float64Array(bucketCount);
    const counts = new Uint16Array(bucketCount);

    for (let i = 0; i < sampleCount; i++) {
      const value = chunk.readInt16LE(i * 2);
      const bucket = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / sampleCount));
      sums[bucket] += value * value;
      counts[bucket]++;
    }

    const envelope = new Float32Array(bucketCount);
    for (let i = 0; i < bucketCount; i++) {
      envelope[i] = counts[i] > 0 ? Math.sqrt(sums[i] / counts[i]) : 0;
    }
    return envelope;
  }

  private getEnvelopeCorrelation(a: Float32Array, b: Float32Array): number {
    const n = Math.min(a.length, b.length);
    if (n < 8) return 0;

    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i++) {
      meanA += a[i];
      meanB += b[i];
    }
    meanA /= n;
    meanB /= n;

    let numerator = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      numerator += da * db;
      energyA += da * da;
      energyB += db * db;
    }

    const denominator = Math.sqrt(energyA * energyB);
    return denominator > 1e-6 ? Math.abs(numerator / denominator) : 0;
  }

  private pruneSystemEchoFrames(now: number): void {
    const cutoff = now - this._MIC_GATE_ECHO_HISTORY_MS;
    this._recentSystemEchoFrames = this._recentSystemEchoFrames
      .filter(frame => frame.timestamp >= cutoff)
      .slice(-this._MIC_GATE_MAX_ECHO_FRAMES);
  }

  private rememberSystemEchoFrame(chunk: Buffer, level: { rms: number; peak: number }): void {
    const now = Date.now();
    this.pruneSystemEchoFrames(now);

    const isAudible = level.rms > this._MIC_GATE_RMS_THRESHOLD || level.peak > this._MIC_GATE_PEAK_THRESHOLD;
    if (!isAudible) return;

    const envelope = this.createPcmEnvelope(chunk);
    if (!envelope) return;

    this._recentSystemEchoFrames.push({
      timestamp: now,
      envelope,
      rms: level.rms,
      peak: level.peak,
    });

    if (this._recentSystemEchoFrames.length > this._MIC_GATE_MAX_ECHO_FRAMES) {
      this._recentSystemEchoFrames = this._recentSystemEchoFrames.slice(-this._MIC_GATE_MAX_ECHO_FRAMES);
    }
  }

  private findCorrelatedSystemEcho(chunk: Buffer): { correlation: number; ageMs: number; rms: number; peak: number } | null {
    if (this._recentSystemEchoFrames.length === 0) return null;

    const now = Date.now();
    this.pruneSystemEchoFrames(now);

    const micEnvelope = this.createPcmEnvelope(chunk);
    if (!micEnvelope) return null;

    let best: { correlation: number; ageMs: number; rms: number; peak: number } | null = null;
    for (const frame of this._recentSystemEchoFrames) {
      const correlation = this.getEnvelopeCorrelation(micEnvelope, frame.envelope);
      if (!best || correlation > best.correlation) {
        best = {
          correlation,
          ageMs: now - frame.timestamp,
          rms: frame.rms,
          peak: frame.peak,
        };
      }
    }

    return best && best.correlation >= this._MIC_GATE_ECHO_CORRELATION_THRESHOLD ? best : null;
  }

  /**
   * Update the mic gate state based on system audio levels.
   * Called on every system audio chunk (before the 5s throttle of maybeLogAudioLevel).
   */
  private updateMicGate(chunk: Buffer): void {
    const level = this.getPcm16Level(chunk);
    this._lastSystemAudioLevel = level;
    this.rememberSystemEchoFrame(chunk, level);

    const isLoud = level.rms > this._MIC_GATE_RMS_THRESHOLD || level.peak > this._MIC_GATE_PEAK_THRESHOLD;

    if (isLoud) {
      this._lastSystemAudioNonSilentAt = Date.now();
      // System audio is playing — gate the mic
      if (this._micGateReopenTimer) {
        clearTimeout(this._micGateReopenTimer);
        this._micGateReopenTimer = null;
      }
      if (!this._micGated) {
        this._micGated = true;
        this._micGateActivations++;
        if (this._micGateActivations <= 10 || this._micGateActivations % 50 === 0) {
          console.log(`[Main][mic-gate] CLOSED #${this._micGateActivations} rms=${level.rms.toFixed(1)} peak=${level.peak}`);
        }
      }
    } else if (this._micGated && !this._micGateReopenTimer) {
      // System audio went silent — schedule mic gate reopen
      this._micGateReopenTimer = setTimeout(() => {
        this._micGated = false;
        this._micGateReopenTimer = null;
        this._micGateDeactivations++;
        if (this._micGateDeactivations <= 10 || this._micGateDeactivations % 50 === 0) {
          console.log(`[Main][mic-gate] OPEN #${this._micGateDeactivations} (after ${this._MIC_GATE_REOPEN_DELAY_MS}ms silence)`);
        }
      }, this._MIC_GATE_REOPEN_DELAY_MS);
    }
  }

  private shouldDropMicChunkForEcho(chunk: Buffer): boolean {
    if (!this._micGated) return false;

    const level = this.getPcm16Level(chunk);
    const systemLevel = this._lastSystemAudioLevel;
    const systemRms = systemLevel?.rms ?? 0;
    const systemPeak = systemLevel?.peak ?? 0;
    const looksLikeDirectSpeech =
      (level.rms >= this._MIC_GATE_OVERRIDE_RMS && level.rms >= systemRms * this._MIC_GATE_DIRECT_SPEECH_RATIO) ||
      (level.peak >= this._MIC_GATE_OVERRIDE_PEAK && level.peak >= systemPeak * this._MIC_GATE_DIRECT_SPEECH_RATIO);
    const looksLikeDominantDirectSpeech =
      (systemRms <= 0 || level.rms >= systemRms * this._MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO) ||
      (systemPeak <= 0 || level.peak >= systemPeak * this._MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO);
    const correlatedEcho = this.findCorrelatedSystemEcho(chunk);

    if (correlatedEcho && !looksLikeDominantDirectSpeech) {
      this._micGateDroppedChunks++;
      this._micGateDroppedCorrelatedEchoChunks++;
      if (this._micGateDroppedCorrelatedEchoChunks <= 10 || this._micGateDroppedCorrelatedEchoChunks % 50 === 0) {
        console.log(`[Main][mic-gate] DROP correlated-echo #${this._micGateDroppedCorrelatedEchoChunks} corr=${correlatedEcho.correlation.toFixed(2)} age=${correlatedEcho.ageMs}ms rms=${level.rms.toFixed(1)} peak=${level.peak} systemRms=${systemRms.toFixed(1)} systemPeak=${systemPeak}`);
      }
      if (this._micGateDroppedChunks <= 10 || this._micGateDroppedChunks % 250 === 0) {
        console.log(`[Main][mic-gate] DROP echo-chunk #${this._micGateDroppedChunks} rms=${level.rms.toFixed(1)} peak=${level.peak}`);
      }
      return true;
    }

    if (looksLikeDirectSpeech) {
      this._micGateAllowedStrongChunks++;
      if (this._micGateAllowedStrongChunks <= 10 || this._micGateAllowedStrongChunks % 50 === 0) {
        console.log(`[Main][mic-gate] PASS strong-mic #${this._micGateAllowedStrongChunks} rms=${level.rms.toFixed(1)} peak=${level.peak} systemRms=${systemRms.toFixed(1)} systemPeak=${systemPeak}`);
      }
      return false;
    }

    this._micGateDroppedChunks++;
    const absoluteStrong =
      level.rms >= this._MIC_GATE_OVERRIDE_RMS || level.peak >= this._MIC_GATE_OVERRIDE_PEAK;
    if (absoluteStrong) {
      this._micGateDroppedRelativeEchoChunks++;
      if (this._micGateDroppedRelativeEchoChunks <= 10 || this._micGateDroppedRelativeEchoChunks % 50 === 0) {
        console.log(`[Main][mic-gate] DROP relative-echo #${this._micGateDroppedRelativeEchoChunks} rms=${level.rms.toFixed(1)} peak=${level.peak} systemRms=${systemRms.toFixed(1)} systemPeak=${systemPeak}`);
      }
    }
    if (this._micGateDroppedChunks <= 10 || this._micGateDroppedChunks % 250 === 0) {
      console.log(`[Main][mic-gate] DROP echo-chunk #${this._micGateDroppedChunks} rms=${level.rms.toFixed(1)} peak=${level.peak}`);
    }
    return true;
  }

  private createSTTProvider(speaker: 'interviewer' | 'user'): STTProvider | null {
    const { CredentialsManager } = require('./services/CredentialsManager');
    const sttProvider = CredentialsManager.getInstance().getSttProvider();
    const sttLanguage = CredentialsManager.getInstance().getSttLanguage();

    // 'none' means the user has explicitly disabled STT (no provider selected).
    // Return null so the pipeline skips STT without falling back to Google.
    if (sttProvider === 'none') {
      console.log(`[Main] STT provider is 'none' — audio capture will proceed but transcription is disabled.`);
      return null;
    }

    let stt: STTProvider;

    if (sttProvider === 'natively') {
      const nativelyKey = CredentialsManager.getInstance().getNativelyApiKey();
      if (!nativelyKey) {
        // Natively is Coming Soon — no key means degrade gracefully like every other provider
        console.warn(`[Main] No Natively API Key configured for ${speaker}, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      } else {
        // 'system' for interviewer (system audio), 'mic' for user (microphone).
        // The server uses ${key}:${channel} as the session key so both streams
        // can coexist without triggering concurrent_session_blocked.
        stt = new NativelyProSTT(nativelyKey, speaker === 'interviewer' ? 'system' : 'mic');
      }
    } else if (sttProvider === 'deepgram') {
      const apiKey = CredentialsManager.getInstance().getDeepgramApiKey();
      if (apiKey) {
        console.log(`[Main] Using DeepgramStreamingSTT for ${speaker}`);
        stt = new DeepgramStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Deepgram STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'soniox') {
      const apiKey = CredentialsManager.getInstance().getSonioxApiKey();
      if (apiKey) {
        console.log(`[Main] Using SonioxStreamingSTT for ${speaker}`);
        stt = new SonioxStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Soniox STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'elevenlabs') {
      const apiKey = CredentialsManager.getInstance().getElevenLabsApiKey();
      if (apiKey) {
        console.log(`[Main] Using ElevenLabsStreamingSTT for ${speaker}`);
        stt = new ElevenLabsStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for ElevenLabs STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'openai') {
      // OpenAI: WebSocket Realtime (gpt-4o-transcribe → gpt-4o-mini-transcribe) with whisper-1 REST fallback
      const apiKey = CredentialsManager.getInstance().getOpenAiSttApiKey();
      if (apiKey) {
        console.log(`[Main] Using OpenAIStreamingSTT (WebSocket+REST fallback) for ${speaker}`);
        stt = new OpenAIStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for OpenAI STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'local') {
      const config = CredentialsManager.getInstance().getLocalSttConfig();
      if (config.mode === 'parakeet_stream') {
        console.log(`[Main] Using ParakeetStreamingSTT for ${speaker}`);
        stt = new ParakeetStreamingSTT({
          glossary: config.glossary,
          channel: speaker === 'interviewer' ? 'system' : 'mic',
        });
      } else {
        console.log(`[Main] Using LocalSTT for ${speaker}: ${config.mode}`);
        stt = new LocalSTT(config);
      }
    } else if (sttProvider === 'groq' || sttProvider === 'azure' || sttProvider === 'ibmwatson') {
      let apiKey: string | undefined;
      let region: string | undefined;
      let modelOverride: string | undefined;

      if (sttProvider === 'groq') {
        apiKey = CredentialsManager.getInstance().getGroqSttApiKey();
        modelOverride = CredentialsManager.getInstance().getGroqSttModel();
      } else if (sttProvider === 'azure') {
        apiKey = CredentialsManager.getInstance().getAzureApiKey();
        region = CredentialsManager.getInstance().getAzureRegion();
      } else if (sttProvider === 'ibmwatson') {
        apiKey = CredentialsManager.getInstance().getIbmWatsonApiKey();
        region = CredentialsManager.getInstance().getIbmWatsonRegion();
      }

      if (apiKey) {
        console.log(`[Main] Using RestSTT (${sttProvider}) for ${speaker}`);
        stt = new RestSTT(sttProvider, apiKey, modelOverride, region);
      } else {
        console.warn(`[Main] No API key for ${sttProvider} STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else {
      stt = new GoogleSTT(speaker);
    }

    stt.setRecognitionLanguage(sttLanguage);
    const providerInstanceName = stt.constructor?.name || 'UnknownSTTProvider';
    console.log(`[STT][provider] channel=${speaker} configured=${sttProvider} instance=${providerInstanceName} language=${sttLanguage} diarization=${stt.supportsDiarization ? 'yes' : 'no'}`);

    const broadcastSttStatus = (payload: SttStatusPayload) => {
      MeetingDebugRecorder.getInstance().recordSttStatus({
        ...payload,
        providerInstance: providerInstanceName,
        configuredProvider: sttProvider,
        at: new Date().toISOString(),
      });
      this.broadcast('stt-status', payload);
    };

    // Wire Transcript Events
    stt.on('transcript', (segment: { text: string, isFinal: boolean, confidence: number, speakerId?: number }) => {
      if (!this.isMeetingActive && !this.isMeetingStopping) {
        return;
      }

      // ── Diarization: resolve effective speaker label ──
      // When the provider supports diarization, it emits a numeric speakerId per
      // segment. We map those to human-readable labels: "locuteur_0", "locuteur_1",
      // etc. for the system audio channel.
      // Supported diarization providers:
      //   - Deepgram (cloud, via diarize:true)
      //   - Parakeet (local, via FluidAudio Pyannote + WeSpeaker)
      // The mic channel (user) always stays as "user" regardless of provider.
      let effectiveSpeaker: string = speaker;
      const hasDiarizedSpeaker = speaker === 'interviewer'
        && this.speakerSeparationEnabled
        && stt.supportsDiarization
        && segment.speakerId !== undefined;
      if (hasDiarizedSpeaker) {
        effectiveSpeaker = `locuteur_${segment.speakerId}`;
      }

      // ── Cross-channel deduplication ──
      // For diarized system audio, preserve the system transcript while still
      // recording it so later mic echo can be suppressed. For non-diarized audio,
      // suppress echo duplicates between mic and system audio channels.
      const trimmedText = segment.text.trim();
      const isDiarized = hasDiarizedSpeaker;
      const timestamp = Date.now();
      const traceKey = `${sttProvider}:${speaker}:${effectiveSpeaker}`;

      if (this.shouldLogSttTranscriptTrace(traceKey, segment.isFinal)) {
        console.log(`[STT][map] provider=${sttProvider} instance=${providerInstanceName} channel=${speaker} effective=${effectiveSpeaker} diarized=${isDiarized} speakerId=${segment.speakerId ?? 'none'} final=${segment.isFinal} conf=${Number(segment.confidence ?? 0).toFixed(2)} chars=${trimmedText.length} text="${trimmedText.substring(0, 120)}"`);
      }

      if (speaker === 'interviewer' && trimmedText.length >= 8) {
        this.cancelPendingMicEchoMatches(trimmedText, timestamp, {
          provider: sttProvider,
          isFinal: segment.isFinal,
          effectiveSpeaker,
        });
      }

      if (!isDiarized && trimmedText.length > 30) {
        if (this.isCrossChannelDuplicate(speaker, effectiveSpeaker, trimmedText, timestamp, {
          provider: sttProvider,
          isFinal: segment.isFinal,
          diarized: isDiarized,
          speakerId: segment.speakerId,
        })) {
          return; // Suppress duplicate
        }
      } else if (isDiarized && trimmedText.length > 30) {
        // Do not suppress diarized system audio, but still record it so mic echo
        // arriving later can be identified and dropped.
        this.isCrossChannelDuplicate(speaker, effectiveSpeaker, trimmedText, timestamp, {
          provider: sttProvider,
          isFinal: segment.isFinal,
          diarized: isDiarized,
          speakerId: segment.speakerId,
        });
      }

      const deliverTranscript = () => {
        if (!this.isMeetingActive && !this.isMeetingStopping) return;

        const rawTranscriptSegment: RawTranscriptSegment = {
          channel: speaker === 'user' ? 'mic' : 'system',
          provider: sttProvider,
          speaker: effectiveSpeaker,
          text: segment.text,
          timestamp,
          final: segment.isFinal,
          confidence: segment.confidence,
          speakerId: segment.speakerId,
          diarized: isDiarized,
          systemAudioActive: this.isSystemAudioRecentlyActive(timestamp),
          systemAudioSilent: this._systemAudioSilentWarningActive,
          systemAudioLevel: this._lastSystemAudioLevel,
          micGateActive: this._micGated,
        };

        MeetingDebugRecorder.getInstance().recordRawTranscript({ ...rawTranscriptSegment });
        const route = this.transcriptRouter.route(rawTranscriptSegment);
        MeetingDebugRecorder.getInstance().recordRouteResult({
          raw: rawTranscriptSegment,
          suppressed: route.suppressed,
          reason: route.reason,
          matchedSpeaker: route.matchedSpeaker,
          similarity: route.similarity,
          canonical: route.segment,
        });

        if (route.suppressed || !route.segment) {
          if (segment.isFinal || this.shouldLogSttTranscriptTrace(`${sttProvider}:${speaker}:${effectiveSpeaker}:router`, false)) {
            console.log(`[STT][router] suppress provider=${sttProvider} channel=${speaker} effective=${effectiveSpeaker} reason=${route.reason || 'unknown'} sim=${route.similarity?.toFixed(2) || 'n/a'} text="${trimmedText.substring(0, 100)}"`);
          }
          return;
        }

        const canonical = route.segment;
        MeetingDebugRecorder.getInstance().recordCanonicalTranscript({
          speaker: canonical.speaker,
          role: canonical.role,
          source: canonical.source,
          text: canonical.text,
          final: canonical.final,
          confidence: canonical.confidence,
          qualityFlags: canonical.qualityFlags,
          rawSpeaker: canonical.rawSpeaker,
          provider: canonical.provider,
          speakerId: canonical.speakerId,
        });
        this.lastAcceptedSttTranscriptAt = Date.now();
        const helper = this.getWindowHelper();
        const payload = {
          speaker: canonical.speaker,
          text: canonical.text,
          timestamp,
          final: canonical.final,
          confidence: canonical.confidence,
          canonicalRole: canonical.role,
          source: canonical.source,
          qualityFlags: canonical.qualityFlags,
          rawSpeaker: canonical.rawSpeaker,
          speakerId: canonical.speakerId,
        };
        if (this.isMeetingActive) {
          helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
          helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);
        }

        const transcriptSegment = {
          speaker: canonical.speaker,
          text: canonical.text,
          timestamp: canonical.timestamp,
          final: canonical.final,
          confidence: canonical.confidence,
          canonicalRole: canonical.role,
          source: canonical.source,
          qualityFlags: canonical.qualityFlags,
          rawSpeaker: canonical.rawSpeaker,
          speakerId: canonical.speakerId,
        };

        // Passive meeting intelligence should trust the system-audio channel.
        // Microphone STT is still shown in the UI and used by the explicit Answer
        // recording flow. We still persist final mic transcripts for post-meeting
        // transcript/summary, but keep them out of passive answer context by default.
        // Diarized speakers (locuteur_X) also come from system audio → feed context.
        const includeMicContext = process.env.NATIVELY_INCLUDE_MIC_CONTEXT === '1';
        const isSystemAudio = canonical.source === 'system' || canonical.role === 'interlocutor' || canonical.role.startsWith('speaker_');
        const shouldFeedPassiveContext = isSystemAudio || includeMicContext;
        if (segment.isFinal && this.shouldLogSttTranscriptTrace(`${sttProvider}:${speaker}:${effectiveSpeaker}:context`, true)) {
          console.log(`[STT][context] provider=${sttProvider} channel=${speaker} effective=${effectiveSpeaker} passive=${shouldFeedPassiveContext ? 'feed' : 'record-only'} includeMic=${includeMicContext} text="${trimmedText.substring(0, 100)}"`);
        }
        if (!shouldFeedPassiveContext) {
          this.intelligenceManager.recordTranscriptOnly(transcriptSegment);
          return;
        }

        this.intelligenceManager.handleTranscript(transcriptSegment);

        // Feed final transcript to JIT RAG indexer
        if (segment.isFinal && this.ragManager) {
          this.ragManager.feedLiveTranscript([{
            speaker: canonical.speaker,
            text: canonical.text,
            timestamp: canonical.timestamp
          }]);
        }

        // Feed final recruiter (system audio) transcripts to negotiation tracker
        if (segment.isFinal && isSystemAudio) {
          this.knowledgeOrchestrator?.feedInterviewerUtterance?.(canonical.text);
        }
      };

      if (speaker === 'user' && this.queueMicEchoCandidate(trimmedText, timestamp, {
        provider: sttProvider,
        isFinal: segment.isFinal,
      }, deliverTranscript)) {
        return;
      }

      deliverTranscript();
    });

    // Consecutive failure counter — reset on any successful final transcript
    let _consecutiveErrors = 0;

    // Track state so we broadcast 'connected' on recovery from failed/reconnecting
    let _lastState: 'connected' | 'reconnecting' | 'failed' = 'reconnecting';

    stt.on('error', (err: Error) => {
      console.error(`[Main] STT (${speaker}) Error:`, err);

      // Extract richer error info from Axios errors (RestSTT)
      let errorMessage = err.message;
      const axiosErr = err as any;
      const httpStatus = axiosErr?.response?.status || 0;
      if (axiosErr?.response?.data?.error) {
        const respErr = axiosErr.response.data.error;
        const respMsg = typeof respErr === 'string' ? respErr : (respErr.message || respErr.code || JSON.stringify(respErr));
        errorMessage = httpStatus ? `${httpStatus} ${respMsg}` : respMsg;
      } else if (httpStatus) {
        errorMessage = `${httpStatus} ${axiosErr.response.statusText}`;
      }

      // Immediately fatal: auth/account problems — no amount of retrying helps
      const isAuthError = httpStatus === 401
        || err.message.toLowerCase().includes('auth_timeout')
        || err.message.toLowerCase().includes('invalid_key')
        || err.message.toLowerCase().includes('invalid api')
        || err.message.toLowerCase().includes('authentication');

      const isQuotaError = err.message.toLowerCase().includes('transcription_quota_exceeded')
        || err.message.toLowerCase().includes('quota');

      const loweredError = errorMessage.toLowerCase();
      const isLocalProvider = sttProvider === 'local' || providerInstanceName.toLowerCase().includes('local') || providerInstanceName.toLowerCase().includes('parakeet');
      const isLocalStartupError = isLocalProvider && (
        loweredError.includes('parakeet')
        || loweredError.includes('helper')
        || loweredError.includes('model cache')
        || loweredError.includes('model missing')
        || loweredError.includes('not executable')
        || loweredError.includes('warmup')
        || loweredError.includes('timed out')
        || loweredError.includes('fluid')
      );

      if (isAuthError || isLocalStartupError) {
        _consecutiveErrors = 0;
        _lastState = 'failed';
        broadcastSttStatus({
          state: 'failed',
          provider: sttProvider,
          error: isLocalStartupError
            ? `Local STT startup failed: ${errorMessage}`
            : errorMessage,
          channel: speaker,
        } as SttStatusPayload);
        return;
      }

      // Retryable: network drop, timeout, 5xx, 400, 429, WS drop
      _consecutiveErrors++;
      const maxErrors = 5;

      if (_consecutiveErrors >= maxErrors || isQuotaError) {
        _lastState = 'failed';
        broadcastSttStatus({
          state: 'failed',
          provider: sttProvider,
          error: isQuotaError
            ? errorMessage
            : `STT provider failed (${_consecutiveErrors} consecutive errors): ${errorMessage}`,
          channel: speaker,
          reconnectAttempts: _consecutiveErrors,
        } as SttStatusPayload);
      } else {
        _lastState = 'reconnecting';
        broadcastSttStatus({
          state: 'reconnecting',
          provider: sttProvider,
          error: errorMessage,
          channel: speaker,
          reconnectAttempts: _consecutiveErrors,
        } as SttStatusPayload);
      }
    });

    // Track successful transcripts — resets consecutive error counter
    // Broadcasts 'connected' whenever we recover from reconnecting/failed
    stt.on('transcript', (segment: { text: string, isFinal: boolean, confidence: number }) => {
      if (segment.isFinal) {
        _consecutiveErrors = 0; // Success — reset counter
        if (_lastState !== 'connected') {
          _lastState = 'connected';
          broadcastSttStatus({
            state: 'connected',
            provider: sttProvider,
            channel: speaker,
          } as SttStatusPayload);
        }
      }
    });

    // Auto language detection: NativelyProSTT emits 'languageDetected' when the
    // backend resolves the language from the first audio batch. Notify the renderer
    // so the settings UI can show what was detected.
    if (stt instanceof NativelyProSTT) {
      stt.on('languageDetected', (bcp47: string) => {
        console.log(`[Main] STT language auto-detected (${speaker}): ${bcp47}`);
        const helper = this.getWindowHelper();
        helper.getMainWindow()?.webContents.send('stt-language-auto-detected', bcp47);
        helper.getLauncherWindow()?.webContents.send('stt-language-auto-detected', bcp47);
      });
    }

    return stt;
  }

  private setupSystemAudioPipeline(): void {
    // REMOVED EARLY RETURN: if (this.systemAudioCapture && this.microphoneCapture) return; // Already initialized

    try {
      // 1. Initialize Captures if missing
      // If they already exist (e.g. from reconfigureAudio), they are already wired to write to this.googleSTT/User
      if (!this.systemAudioCapture) {
        this.systemAudioCapture = new SystemAudioCapture();
        // Wire Capture -> STT
        let _sysChunkCount = 0;
        this.systemAudioCapture.on('data', (chunk: Buffer) => {
          _sysChunkCount++;
          if (_sysChunkCount <= 3 || _sysChunkCount % 500 === 0) {
            console.log(`[Main] SystemAudio->STT: chunk #${_sysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
          }
          this.writeAudioDebugTrack('system', chunk, this.systemAudioCapture?.getSampleRate() || 48000);
          this.updateMicGate(chunk);
          this.maybeLogAudioLevel('interviewer', chunk);
          this.googleSTT?.write(chunk);
        });
        this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] SystemAudioCapture rate updated dynamically to ${rate}Hz`);
          // Forward to ALL active STT providers — STTProvider union includes setSampleRate
          this.googleSTT?.setSampleRate(rate);
        });
        this.systemAudioCapture.on('speech_ended', () => {
          this.googleSTT?.notifySpeechEnded?.();
        });
        // PR #173: Wire audio recovery handler — handles both logging and auto-restart.
        // NOTE: Do NOT add a separate 'error' listener here; setupAudioRecoveryHandler
        // registers its own which logs + recovers. Dual listeners would double-fire.
        this.setupAudioRecoveryHandler();
      }

      if (!this.microphoneCapture) {
        this.microphoneCapture = new MicrophoneCapture();
        this.microphoneCapture.on('data', (chunk: Buffer) => {
          this.writeAudioDebugTrack('mic', chunk, this.microphoneCapture?.getSampleRate() || 48000);
          if (this.shouldDropMicChunkForEcho(chunk)) return;
          this.maybeLogAudioLevel('user', chunk);
          this.googleSTT_User?.write(chunk);
        });
        this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] MicrophoneCapture rate updated dynamically to ${rate}Hz`);
          // Forward to ALL active STT providers — STTProvider union includes setSampleRate
          this.googleSTT_User?.setSampleRate(rate);
        });
        this.microphoneCapture.on('speech_ended', () => {
          this.googleSTT_User?.notifySpeechEnded?.();
        });
        this.microphoneCapture.on('error', (err: Error) => {
          console.error('[Main] MicrophoneCapture Error:', err);
        });
      }

      // 2. Initialize STT Services if missing
      if (!this.googleSTT) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const sttProv = CredentialsManager.getInstance().getSttProvider();
        console.log(`[Main] Creating interviewer STT provider: ${sttProv}`);
        this.googleSTT = this.createSTTProvider('interviewer');
      }

      if (!this.googleSTT_User) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const sttProv = CredentialsManager.getInstance().getSttProvider();
        console.log(`[Main] Creating user STT provider: ${sttProv}`);
        this.googleSTT_User = this.createSTTProvider('user');
      }

      // --- CRITICAL FIX: SYNC SAMPLE RATES ---
      // Always sync rates, even if just initialized, to ensure consistency

      // 1. Sync System Audio Rate
      const sysRate = this.systemAudioCapture?.getSampleRate() || 48000;
      if (this._verboseLogging) console.log(`[Main] Configuring Interviewer STT to ${sysRate}Hz`);
      this.googleSTT?.setSampleRate(sysRate);
      this.googleSTT?.setAudioChannelCount?.(1);

      // 2. Sync Mic Rate
      const micRate = this.microphoneCapture?.getSampleRate() || 48000;
      if (this._verboseLogging) console.log(`[Main] Configuring User STT to ${micRate}Hz`);
      this.googleSTT_User?.setSampleRate(micRate);
      this.googleSTT_User?.setAudioChannelCount?.(1);

      if (this._verboseLogging) console.log('[Main] Full Audio Pipeline (System + Mic) Initialized (Ready)');

    } catch (err) {
      console.error('[Main] Failed to setup System Audio Pipeline:', err);
    }
  }

  private async reconfigureAudio(inputDeviceId?: string, outputDeviceId?: string): Promise<void> {
    console.log(`[Main] Reconfiguring Audio: Input=${inputDeviceId}, Output=${outputDeviceId}`);

    // 1. System Audio (Output Capture)
    if (this.systemAudioCapture) {
      // destroy() calls stop() AND removeAllListeners(), preventing EventEmitter listener leaks.
      // Using stop()+null would orphan all 'data', 'speech_ended', 'sample_rate_changed'
      // closures (they still hold a ref to `this`) and trigger them on the next meeting.
      this.systemAudioCapture.destroy();
      this.systemAudioCapture = null;
    }

    try {
      console.log('[Main] Initializing SystemAudioCapture...');
      this.systemAudioCapture = new SystemAudioCapture(outputDeviceId || undefined);
      const rate = this.systemAudioCapture.getSampleRate();
      console.log(`[Main] SystemAudioCapture rate: ${rate}Hz`);
      this.googleSTT?.setSampleRate(rate);

      let _rcfgSysChunkCount = 0;
      this.systemAudioCapture.on('data', (chunk: Buffer) => {
        _rcfgSysChunkCount++;
        if (_rcfgSysChunkCount <= 3 || _rcfgSysChunkCount % 500 === 0) {
          console.log(`[Main] (Reconfigured) SystemAudio->STT: chunk #${_rcfgSysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
        }
        this.writeAudioDebugTrack('system', chunk, this.systemAudioCapture?.getSampleRate() || 48000);
        this.updateMicGate(chunk);
        this.maybeLogAudioLevel('interviewer', chunk);
        this.googleSTT?.write(chunk);
      });
      this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
        console.log(`[Main] (Reconfigured) SystemAudioCapture rate updated dynamically to ${rate}Hz`);
        this.googleSTT?.setSampleRate(rate);
      });
      this.systemAudioCapture.on('speech_ended', () => {
        this.googleSTT?.notifySpeechEnded?.();
      });
      // PR #173: Re-wire recovery handler on the new capture instance after device reconfigure.
      // Without this, audio recovery is lost whenever the user changes their output device.
      this.setupAudioRecoveryHandler();
      console.log('[Main] SystemAudioCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize SystemAudioCapture with preferred ID. Falling back to default.', err);
      try {
        this.systemAudioCapture = new SystemAudioCapture(); // Default
        const rate = this.systemAudioCapture.getSampleRate();
        console.log(`[Main] SystemAudioCapture (Default) rate: ${rate}Hz`);
        this.googleSTT?.setSampleRate(rate);

        let _dfltSysChunkCount = 0;
        this.systemAudioCapture.on('data', (chunk: Buffer) => {
          _dfltSysChunkCount++;
          if (_dfltSysChunkCount <= 3 || _dfltSysChunkCount % 500 === 0) {
            console.log(`[Main] (Default) SystemAudio->STT: chunk #${_dfltSysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
          }
          this.writeAudioDebugTrack('system', chunk, this.systemAudioCapture?.getSampleRate() || 48000);
          this.updateMicGate(chunk);
          this.maybeLogAudioLevel('interviewer', chunk);
          this.googleSTT?.write(chunk);
        });
        this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] (Reconfigured Default) SystemAudioCapture rate updated dynamically to ${rate}Hz`);
          this.googleSTT?.setSampleRate(rate);
        });
        this.systemAudioCapture.on('speech_ended', () => {
          this.googleSTT?.notifySpeechEnded?.();
        });
        // PR #173: Recovery handler on fallback path too
        this.setupAudioRecoveryHandler();
      } catch (err2) {
        console.error('[Main] Failed to initialize SystemAudioCapture (Default):', err2);
      }
    }

    // 2. Microphone (Input Capture)
    if (this.microphoneCapture) {
      // destroy() calls stop() AND removeAllListeners(), preventing EventEmitter listener leaks.
      this.microphoneCapture.destroy();
      this.microphoneCapture = null;
    }

    try {
      console.log('[Main] Initializing MicrophoneCapture...');
      this.microphoneCapture = new MicrophoneCapture(inputDeviceId || undefined);
      const rate = this.microphoneCapture.getSampleRate();
      console.log(`[Main] MicrophoneCapture rate: ${rate}Hz`);
      this.googleSTT_User?.setSampleRate(rate);

      this.microphoneCapture.on('data', (chunk: Buffer) => {
        this.writeAudioDebugTrack('mic', chunk, this.microphoneCapture?.getSampleRate() || 48000);
        if (this.shouldDropMicChunkForEcho(chunk)) return;
        this.maybeLogAudioLevel('user', chunk);
        this.googleSTT_User?.write(chunk);
      });
      this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
        console.log(`[Main] (Reconfigured) MicrophoneCapture rate updated dynamically to ${rate}Hz`);
        this.googleSTT_User?.setSampleRate(rate);
      });
      this.microphoneCapture.on('speech_ended', () => {
        this.googleSTT_User?.notifySpeechEnded?.();
      });
      this.microphoneCapture.on('error', (err: Error) => {
        console.error('[Main] MicrophoneCapture Error:', err);
      });
      console.log('[Main] MicrophoneCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize MicrophoneCapture with preferred ID. Falling back to default.', err);
      try {
        this.microphoneCapture = new MicrophoneCapture(); // Default
        const rate = this.microphoneCapture.getSampleRate();
        console.log(`[Main] MicrophoneCapture (Default) rate: ${rate}Hz`);
        this.googleSTT_User?.setSampleRate(rate);

        this.microphoneCapture.on('data', (chunk: Buffer) => {
          this.writeAudioDebugTrack('mic', chunk, this.microphoneCapture?.getSampleRate() || 48000);
          if (this.shouldDropMicChunkForEcho(chunk)) return;
          this.maybeLogAudioLevel('user', chunk);
          this.googleSTT_User?.write(chunk);
        });
        this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] (Reconfigured Default) MicrophoneCapture rate updated dynamically to ${rate}Hz`);
          this.googleSTT_User?.setSampleRate(rate);
        });
        this.microphoneCapture.on('speech_ended', () => {
          this.googleSTT_User?.notifySpeechEnded?.();
        });
        this.microphoneCapture.on('error', (err: Error) => {
          console.error('[Main] MicrophoneCapture (Default) Error:', err);
        });
      } catch (err2) {
        console.error('[Main] Failed to initialize MicrophoneCapture (Default):', err2);
      }
    }
  }

  /**
   * Reconfigure STT provider mid-session (called from IPC when user changes provider)
   * Destroys existing STT instances and recreates them with the new provider
   */
  public async reconfigureSttProvider(): Promise<void> {
    console.log('[Main] Reconfiguring STT Provider...');
    this.clearPendingMicEchoTranscripts('stt_reconfigure', false);
    this.transcriptRouter.reset();
    this._recentTranscripts = [];

    // RC-01 fix: pause audio captures FIRST so their EventEmitter queues drain
    // before we null-out the STT instances. Without this, buffered 'data' events
    // still in-flight call this.googleSTT?.write() while googleSTT is already null.
    if (this.isMeetingActive) {
      this.systemAudioCapture?.stop();
      this.microphoneCapture?.stop();
    }

    // Now safe to destroy STT instances — no more audio events incoming
    if (this.googleSTT) {
      this.googleSTT.stop();
      this.googleSTT.removeAllListeners();
      this.googleSTT = null;
    }
    if (this.googleSTT_User) {
      this.googleSTT_User.stop();
      this.googleSTT_User.removeAllListeners();
      this.googleSTT_User = null;
    }

    // Only reinitialize the pipeline when a meeting is already active.
    // Outside a meeting, defer pipeline creation to startMeeting() so we never
    // eagerly construct a MicrophoneCapture (which calls build_input_stream on
    // macOS and immediately triggers the orange mic indicator even without .play()).
    if (this.isMeetingActive) {
      this.setupSystemAudioPipeline();
      this.systemAudioCapture?.start();
      this.microphoneCapture?.start();
      this.googleSTT?.start();
      this.googleSTT_User?.start();
    }

    console.log('[Main] STT Provider reconfigured');

    // Broadcast the new STT config state to all windows so they can update banners / warnings
    const { CredentialsManager: CM } = require('./services/CredentialsManager');
    const newProvider = CM.getInstance().getSttProvider();
    this.broadcast('stt-config-changed', { configured: newProvider !== 'none', provider: newProvider });
  }

  /**
   * PR #173: Audio Recovery Handler
   *
   * Listens for 'audio-capture-failed' emit from SystemAudioCapture and
   * transparently restarts the full capture + STT pipeline without ending the
   * meeting session. Prevents silent audio loss when macOS CoreAudio or SCK
   * drops the capture stream mid-session (e.g. device re-plug, Display Sleep).
   */
  private _systemAudioRecoveryInProgress = false;
  private _systemAudioRecoveryAttempts = 0;
  private _systemAudioRecoveryTimer: NodeJS.Timeout | null = null;
  private _systemAudioLastFailureAt: number | null = null;
  private _systemAudioSuccessfulRestarts = 0;
  private _systemAudioConsecutiveFailures = 0;

  private setupAudioRecoveryHandler(): void {
    if (!this.systemAudioCapture) return;

    this.systemAudioCapture.on('error', async (err: Error) => {
      if (!this.isMeetingActive) return; // Only attempt recovery during active meetings

      const now = Date.now();
      this._systemAudioLastFailureAt = now;
      this._systemAudioConsecutiveFailures++;

      // Cap at 3 consecutive recovery attempts to avoid infinite restart loops
      if (this._systemAudioRecoveryInProgress || this._systemAudioRecoveryAttempts >= 3) {
        console.warn(
          `[AudioRecovery] Skipping recovery — already in progress or max attempts (${this._systemAudioRecoveryAttempts}/3) reached.`,
        );
        return;
      }

      this._systemAudioRecoveryInProgress = true;
      this._systemAudioRecoveryAttempts++;
      console.warn(
        `[AudioRecovery] SystemAudioCapture error — attempting recovery #${this._systemAudioRecoveryAttempts}: ${err.message}`,
      );

      try {
        // Brief delay so the OS can release the device before re-acquisition
        await new Promise<void>(resolve => {
          this._systemAudioRecoveryTimer = setTimeout(resolve, 1500);
        });
        this._systemAudioRecoveryTimer = null;

        // Restart the audio captures without disturbing the STT provider or the session
        this.systemAudioCapture?.stop();
        this.systemAudioCapture?.start();

        this._systemAudioSuccessfulRestarts++;
        this._systemAudioConsecutiveFailures = 0;
        console.log(
          `[AudioRecovery] SystemAudioCapture restarted successfully (total restarts: ${this._systemAudioSuccessfulRestarts}).`,
        );
      } catch (recoveryErr: any) {
        console.error(`[AudioRecovery] Recovery attempt #${this._systemAudioRecoveryAttempts} failed:`, recoveryErr);
      } finally {
        this._systemAudioRecoveryInProgress = false;
      }
    });
  }


  public async startAudioTest(deviceId?: string): Promise<void> {
    // P2-12: guard against two concurrent calls both passing the async permission check
    // before either has created a capture — the second call would orphan the first capture.
    if (this._audioTestStarting) return;
    this._audioTestStarting = true;
    try {
      await this._startAudioTestImpl(deviceId);
    } finally {
      this._audioTestStarting = false;
    }
  }

  private async _startAudioTestImpl(deviceId?: string): Promise<void> {
    console.log(`[Main] Starting Audio Test on device: ${deviceId || 'default'}`);
    this.stopAudioTest(); // Stop any existing test

    if (!(await ensureMacMicrophoneAccess('audio test'))) {
      throw new Error('Microphone access denied. Please allow microphone access in System Settings and try again.');
    }

    const attachAudioTestListeners = (capture: MicrophoneCapture) => {
      capture.on('data', (chunk: Buffer) => {
        const targets = [
          this.settingsWindowHelper.getSettingsWindow(),
          this.getWindowHelper().getLauncherWindow(),
          this.getWindowHelper().getOverlayWindow(),
        ].filter((win): win is BrowserWindow => !!win && !win.isDestroyed());

        if (targets.length === 0) return;

        let sum = 0;
        const step = 10;
        const len = chunk.length;

        for (let i = 0; i < len; i += 2 * step) {
          const val = chunk.readInt16LE(i);
          sum += val * val;
        }

        const count = len / (2 * step);
        if (count > 0) {
          const rms = Math.sqrt(sum / count);
          const level = Math.min(rms / 10000, 1.0);
          for (const target of targets) {
            target.webContents.send('audio-test-level', level);
          }
        }
      });

      capture.on('error', (err: Error) => {
        console.error('[Main] AudioTest Error:', err);
      });
    };

    try {
      this.audioTestCapture = new MicrophoneCapture(deviceId || undefined);
      attachAudioTestListeners(this.audioTestCapture);
      this.audioTestCapture.start();
    } catch (err) {
      console.warn('[Main] Failed to start audio test on preferred device. Falling back to default.', err);
      // RC-02 fix: explicitly stop and null the failed capture before creating
      // the fallback to prevent a brief double-microphone-capture window.
      try { this.audioTestCapture?.stop(); } catch { /* ignore errors on already-failed capture */ }
      this.audioTestCapture = null;
      try {
        this.audioTestCapture = new MicrophoneCapture();
        attachAudioTestListeners(this.audioTestCapture);
        this.audioTestCapture.start();
      } catch (fallbackErr) {
        console.error('[Main] Failed to start audio test:', fallbackErr);
        throw fallbackErr;
      }
    }
  }

  public stopAudioTest(): void {
    if (this.audioTestCapture) {
      console.log('[Main] Stopping Audio Test');
      this.audioTestCapture.stop();
      this.audioTestCapture = null;
    }
  }

  public finalizeMicSTT(): void {
    // We only want to finalize the user microphone, because the context is Manual Answer
    if (this.googleSTT_User?.finalize) {
      console.log('[Main] Finalizing STT');
      this.googleSTT_User.finalize();
    }
  }

  public async flushPendingSttTranscripts(reason: string = 'manual'): Promise<void> {
    const flushProvider = (provider: STTProvider | null, label: string) => {
      if (!provider) return;
      try {
        if (provider.flushPendingTranscript) {
          console.log(`[Main] Flushing pending STT transcript for ${label} (${reason})`);
          provider.flushPendingTranscript();
          return;
        }
        if (provider.finalize) {
          console.log(`[Main] Finalizing STT provider for ${label} (${reason})`);
          provider.finalize();
        }
      } catch (err) {
        console.warn(`[Main] Failed to flush pending STT transcript for ${label}:`, err);
      }
    };

    flushProvider(this.googleSTT, 'interviewer');
    flushProvider(this.googleSTT_User, 'user');

    // Give synchronous EventEmitter listeners and very fast provider finalizers a tick
    // before the caller reads context or marks the meeting inactive.
    await new Promise(resolve => setTimeout(resolve, 120));
    if (this._pendingMicEchoTranscripts.length > 0) {
      await new Promise(resolve => setTimeout(resolve, this._MIC_ECHO_GRACE_MS));
      this.clearPendingMicEchoTranscripts(`flush:${reason}`, true);
    }
  }

  public async startMeeting(metadata?: any): Promise<void> {
    console.log('[Main] Starting Meeting...', metadata);
    if (this.meetingFinalizationPromise) {
      console.log('[Main] Waiting for previous meeting finalization before starting a new session...');
      await this.meetingFinalizationPromise.catch(error => {
        console.warn('[Main] Previous meeting finalization failed before new start:', error);
      });
    }
    this.clearPendingMicEchoTranscripts('new_meeting', false);
    this.transcriptRouter.reset();
    this._recentTranscripts = [];
    this._lastSystemAudioLevel = null;
    this._systemAudioSilentWarningActive = false;
    this._lastSystemAudioNonSilentAt = 0;
    const activeBrief = this.meetingBriefManager.activateForMeeting(metadata?.meetingBrief, { title: metadata?.title });
    if (activeBrief) {
      metadata = { ...(metadata || {}), meetingBrief: activeBrief };
    }
    const credentialsManager = CredentialsManager.getInstance();
    const debugSttProvider = credentialsManager.getSttProvider();
    const debugLocalSttConfig = debugSttProvider === 'local'
      ? credentialsManager.getLocalSttConfig()
      : null;
    MeetingDebugRecorder.getInstance().startSession({
      ...(metadata || {}),
      stt: {
        provider: debugSttProvider,
        language: credentialsManager.getSttLanguage(),
        localMode: debugLocalSttConfig?.mode,
      },
      startedAt: new Date().toISOString(),
    });

    // PR #173: Reset audio recovery state for fresh session
    this._systemAudioRecoveryInProgress = false;
    this._systemAudioRecoveryAttempts = 0;
    this._systemAudioConsecutiveFailures = 0;
    if (this._systemAudioRecoveryTimer) {
      clearTimeout(this._systemAudioRecoveryTimer);
      this._systemAudioRecoveryTimer = null;
    }

    if (!(await ensureMacMicrophoneAccess('meeting start'))) {
      const message = 'Microphone access denied. Please allow microphone access in System Settings.';
      this.broadcast('meeting-audio-error', message);
      throw new Error(message);
    }

    // Check Screen Recording permission required for system audio capture
    // (CoreAudio Global Process Tap + ScreenCaptureKit both need this).
    // NOTE: The 'not-determined' TCC dialog is triggered once at app startup
    // (in initializeApp) so it never pops up mid-meeting here. We only act on
    // explicit 'denied' — in that case warn the user but let the meeting continue
    // with microphone-only transcription.
    if (process.platform === 'darwin') {
      const screenStatus = getMacScreenCaptureStatus();
      console.log(`[Main] macOS screen recording permission status: ${screenStatus}`);
      if (screenStatus === 'denied') {
        // Permission was explicitly denied — warn the user via the UI but do NOT
        // continue in microphone-only mode. For meeting/call use cases that creates
        // misleading transcripts where every voice is labeled as Mic, which then
        // pollutes summaries and AI answers. Allow an explicit escape hatch only
        // for local mic-only debugging.
        const message = 'Screen Recording permission denied. Natively cannot separate Speaker from Mic until this is enabled. To fix: System Settings → Privacy & Security → Screen Recording → enable Natively, then quit and relaunch Natively.';
        console.warn('[Main]', message);
        this.broadcast('system-audio-permission-denied', message);
        const allowMicOnly =
          process.env.NATIVELY_ALLOW_MIC_ONLY === '1' ||
          metadata?.allowMicOnly === true ||
          metadata?.audio?.allowMicOnly === true;

        if (!allowMicOnly) {
          throw new Error(message);
        }
        console.warn('[Main] Continuing in explicit microphone-only mode. Speaker separation and system audio transcription are disabled for this session.');
      }
      // 'not-determined': Handled at startup. SCK/CoreAudio will trigger the TCC
      // dialog itself when it first attempts to access screen content.
    }

    const forceAudioDebugRecording = process.env.NATIVELY_FORCE_AUDIO_DEBUG === '1';
    if (metadata?.debugAudioRecording === true || forceAudioDebugRecording) {
      if (forceAudioDebugRecording && metadata?.debugAudioRecording !== true) {
        console.log('[AudioDebugRecorder] Enabled by NATIVELY_FORCE_AUDIO_DEBUG=1.');
      }
      this.startAudioDebugRecording({
        ...(metadata || {}),
        debugAudioRecording: true,
        debugAudioRecordingForced: forceAudioDebugRecording || undefined,
      });
    } else {
      this.audioDebugRecorder?.abort();
      this.audioDebugRecorder = null;
    }

    this.isMeetingActive = true;
    this.broadcastMeetingState()
    if (metadata) {
      this.intelligenceManager.setMeetingMetadata(metadata);
    }

    // Reset overlay position to default center so each new meeting starts
    // with the overlay in a predictable centered position, regardless of where
    // the user moved it during the previous meeting session.
    this.windowHelper.resetOverlayPosition();

    // Emit session reset to clear UI state immediately
    this.getWindowHelper().getOverlayWindow()?.webContents.send('session-reset');
    this.getWindowHelper().getLauncherWindow()?.webContents.send('session-reset');

    // ★ ASYNC AUDIO INIT: Return INSTANTLY so the IPC response goes back
    // to the renderer immediately, allowing the UI to switch to overlay
    // without waiting for SCK/audio initialization (which takes 5-7 seconds).
    // setTimeout(0) ensures setWindowMode IPC is processed first.
    setTimeout(async () => {
      // BUG-02 fix: a fast start→stop sequence can call endMeeting() before
      // this callback fires, leaving isMeetingActive=false. If that happened,
      // do NOT boot the audio pipeline — it would run forever with no stop signal.
      if (!this.isMeetingActive) {
        console.warn('[Main] Meeting was cancelled before audio pipeline could start — aborting init.');
        return;
      }
      try {
        // Check for audio configuration preference
        if (metadata?.audio) {
          await this.reconfigureAudio(metadata.audio.inputDeviceId, metadata.audio.outputDeviceId);
        }

        // LAZY INIT: Ensure pipeline is ready (if not reconfigured above)
        this.setupSystemAudioPipeline();

        // Start System Audio
        this.systemAudioCapture?.start();
        this.googleSTT?.start();

        // Start Microphone
        this.microphoneCapture?.start();
        this.googleSTT_User?.start();

        // Start JIT RAG live indexing
        if (this.ragManager) {
          this.ragManager.startLiveIndexing('live-meeting-current');
        }

        if (this._verboseLogging) {
          const requestedInput = metadata?.audio?.inputDeviceId || 'default';
          const requestedOutput = metadata?.audio?.outputDeviceId || 'default';
          const backend = requestedOutput === 'sck' ? 'sck' : 'coreaudio';
          const sysRate = this.systemAudioCapture?.getSampleRate() || 48000;
          const micRate = this.microphoneCapture?.getSampleRate() || 48000;
          console.log(`[Main][debug] Audio pipeline: input=${requestedInput} output=${requestedOutput} backend=${backend} sysRate=${sysRate}Hz micRate=${micRate}Hz`);
        }
        console.log('[Main] Audio pipeline started successfully.');

        // ── System Audio Health Check ──
        // After 7 seconds, verify the system audio stream is actually
        // delivering non-zero samples. If silent, the Rust DSP loop will
        // have already logged a warning, but we also notify the UI so the
        // user knows Speaker separation is broken before they waste a meeting.
        setTimeout(() => {
          if (!this.isMeetingActive) return; // Meeting already ended
          const level = this._lastSystemAudioLevel;
          if (level && level.rms === 0 && level.peak === 0) {
            console.warn('[Main] ⚠️  System audio health check: SILENT after 7s. Speaker channel will not work.');
            MeetingDebugRecorder.getInstance().recordAudioHealth({
              channel: 'system',
              status: 'silent_after_7s',
              rms: level.rms,
              peak: level.peak,
            });
            this._systemAudioSilentWarningActive = true;
            this.broadcast('system-audio-silent', {
              message: 'System audio is silent — other participants will not be captured until system audio is restored. Check Screen Recording permission and the output device.',
              rms: level.rms,
              peak: level.peak,
            });
          }
        }, 7000);
      } catch (err) {
        console.error('[Main] Error initializing audio pipeline:', err);
        // Notify UI so user knows microphone/audio failed to start
        this.broadcast('meeting-audio-error', (err as Error).message || 'Audio pipeline failed to start');
      }
    }, 0); // Defer to next event loop tick — ensures IPC response reaches renderer before audio init
  }

  public async endMeeting(): Promise<void> {
    console.log('[Main] Ending Meeting...');
    if (!this.isMeetingActive && this.isMeetingStopping) {
      console.log('[Main] Meeting is already finalizing.');
      return;
    }
    if (!this.isMeetingActive) {
      console.log('[Main] No active meeting to end.');
      return;
    }

    this.isMeetingStopping = true;
    await this.flushPendingSttTranscripts('meeting_end');
    this.isMeetingActive = false;
    this.broadcastMeetingState();

    // Reset Mouse Passthrough so the next meeting overlay starts fresh and focusable
    if (this.overlayMousePassthrough) {
      this.setOverlayMousePassthrough(false);
    }

    // Stop audio captures synchronously — these are fire-and-forget internally
    this.systemAudioCapture?.stop();
    this.googleSTT?.stop();
    this.microphoneCapture?.stop();
    this.googleSTT_User?.stop();

    const audioDebugManifestPath = this.audioDebugRecorder?.getManifestPath() || null;
    const audioDebugDirectory = this.audioDebugRecorder?.getSessionDir() || null;
    const recorder = this.audioDebugRecorder;
    this.audioDebugRecorder = null;

    this.meetingFinalizationPromise = this.finalizeStoppedMeeting({
      recorder,
      audioDebugManifestPath,
      audioDebugDirectory,
    }).finally(() => {
      this.isMeetingStopping = false;
      this.meetingFinalizationPromise = null;
    });
  }

  private async finalizeStoppedMeeting(options: {
    recorder: AudioDebugRecorder | null;
    audioDebugManifestPath: string | null;
    audioDebugDirectory: string | null;
  }): Promise<void> {
    let meetingId: string | null = null;

    try {
      await this.waitForPostStopSttTranscripts();

      // Save session state after late local STT finals have had a chance to land.
      // MeetingPersistence.stopMeeting() then resets the session and queues summary generation.
      meetingId = await this.intelligenceManager.stopMeeting();

      try {
        await options.recorder?.stop({ meetingId });
      } catch (error: any) {
        console.warn('[AudioDebugRecorder] Failed to finalize audio debug recording:', error?.message || error);
      }

      MeetingDebugRecorder.getInstance().finishSession({
        meetingId,
        endedAt: new Date().toISOString(),
        audioDebugManifestPath: options.audioDebugManifestPath,
        audioDebugDirectory: options.audioDebugDirectory,
      });

      this.revertToDefaultModel();
      await this.runPostMeetingRagProcessing(meetingId);
    } catch (error) {
      console.error('[Main] Meeting finalization failed:', error);
      try {
        await options.recorder?.stop({ meetingId });
      } catch {
        // Best effort only.
      }
      MeetingDebugRecorder.getInstance().finishSession({
        meetingId,
        endedAt: new Date().toISOString(),
        audioDebugManifestPath: options.audioDebugManifestPath,
        audioDebugDirectory: options.audioDebugDirectory,
        finalizationError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForPostStopSttTranscripts(): Promise<void> {
    const usesSlowLocalFinals =
      this.googleSTT instanceof ParakeetStreamingSTT ||
      this.googleSTT_User instanceof ParakeetStreamingSTT;
    const maxWaitMs = usesSlowLocalFinals ? this.POST_STOP_STT_WAIT_MS : this.POST_STOP_STT_MIN_WAIT_MS;
    const startedAt = Date.now();
    const waitUntilAt = startedAt + maxWaitMs;
    let lastObserved = this.lastAcceptedSttTranscriptAt || startedAt;

    console.log(`[Main] Waiting for post-stop STT finals (${maxWaitMs}ms budget, parakeet=${usesSlowLocalFinals})...`);
    while (Date.now() < waitUntilAt) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const now = Date.now();
      if (this.lastAcceptedSttTranscriptAt > lastObserved) {
        lastObserved = this.lastAcceptedSttTranscriptAt;
        continue;
      }
      const waited = now - startedAt;
      if (!usesSlowLocalFinals && waited >= this.POST_STOP_STT_MIN_WAIT_MS) break;
    }
    console.log(`[Main] Post-stop STT finalization wait complete after ${Date.now() - startedAt}ms.`);
  }

  private revertToDefaultModel(): void {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const storedDefaultModel = cm.getDefaultModel();
      const codexPreferredModel = cm.getCodexPreferredModel?.() || 'codex:gpt-5.5';
      const isSupportedDefault =
        storedDefaultModel.startsWith('codex:') ||
        storedDefaultModel.startsWith('gemini-') ||
        storedDefaultModel.startsWith('models/');
      const defaultModel = isSupportedDefault ? storedDefaultModel : codexPreferredModel;
      if (storedDefaultModel !== defaultModel) {
        cm.setDefaultModel(defaultModel);
      }
      const all = [...(cm.getCurlProviders() || []), ...(cm.getCustomProviders() || [])];
      console.log(`[Main] Reverting model to default: ${defaultModel}`);
      this.processingHelper.getLLMHelper().setModel(defaultModel, all);
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-changed', defaultModel);
      });
    } catch (e) {
      console.error('[Main] Failed to revert model:', e);
    }
  }

  private async runPostMeetingRagProcessing(meetingId: string | null): Promise<void> {
    const ragManager = this.ragManager;
    if (meetingId) {
      try {
        if (ragManager) {
          await ragManager.stopLiveIndexing();
          console.log('[Main] Live RAG indexing stopped.');
        }
        await this.processCompletedMeetingForRAG(meetingId);
        if (ragManager && !this.isMeetingActive) {
          ragManager.deleteMeetingData('live-meeting-current');
          console.log('[Main] JIT RAG provisional chunks cleaned up.');
        } else if (this.isMeetingActive) {
          console.log('[Main] New meeting started during cleanup — skipping live-meeting-current deletion.');
        }
      } catch (err) {
        console.error('[Main] Background post-meeting RAG processing failed:', err);
      }
      return;
    }

    if (ragManager) {
      await ragManager.stopLiveIndexing().catch(() => {});
      if (!this.isMeetingActive) ragManager.deleteMeetingData('live-meeting-current');
    }
  }

  private async processCompletedMeetingForRAG(meetingId: string): Promise<void> {
    if (!this.ragManager) return;

    try {
      // Use the explicit meetingId passed from endMeeting() — deterministic, never
      // picks up a concurrently started meeting the way getRecentMeetings(1) could.
      const meeting = DatabaseManager.getInstance().getMeetingDetails(meetingId);
      if (!meeting || !meeting.transcript || meeting.transcript.length === 0) return;

      // Convert transcript to RAG format
      const segments = meeting.transcript.map(t => ({
        speaker: t.speaker,
        text: t.text,
        timestamp: t.timestamp
      }));

      // Generate summary from detailedSummary if available
      let summary: string | undefined;
      if (meeting.detailedSummary) {
        summary = [
          ...(meeting.detailedSummary.keyPoints || []),
          ...(meeting.detailedSummary.actionItems || []).map(a => `Action: ${a}`)
        ].join('. ');
      }

      const result = await this.ragManager.processMeeting(meeting.id, segments, summary);
      console.log(`[AppState] RAG processed meeting ${meeting.id}: ${result.chunkCount} chunks`);

    } catch (error) {
      console.error('[AppState] Failed to process meeting for RAG:', error);
    }
  }

  private setupIntelligenceEvents(): void {
    const sendToRenderers = (channel: string, payload?: any) => {
      const helper = this.getWindowHelper();
      const sent = new Set<number>();
      for (const win of [helper.getLauncherWindow(), helper.getOverlayWindow()]) {
        if (!win || win.isDestroyed() || sent.has(win.id)) continue;
        win.webContents.send(channel, payload);
        sent.add(win.id);
      }
    };

    // Forward intelligence events to renderer
    this.intelligenceManager.on('assist_update', (insight: string) => {
      sendToRenderers('intelligence-assist-update', { insight });
    })

    this.intelligenceManager.on('suggested_answer', (answer: string, question: string, confidence: number) => {
      sendToRenderers('intelligence-suggested-answer', { answer, question, confidence });
    })

    this.intelligenceManager.on('suggested_answer_token', (token: string, question: string, confidence: number) => {
      sendToRenderers('intelligence-suggested-answer-token', { token, question, confidence });
    })

    this.intelligenceManager.on('refined_answer_token', (token: string, intent: string) => {
      sendToRenderers('intelligence-refined-answer-token', { token, intent });
    })

    this.intelligenceManager.on('refined_answer', (answer: string, intent: string) => {
      sendToRenderers('intelligence-refined-answer', { answer, intent });
    })

    this.intelligenceManager.on('recap', (summary: string) => {
      sendToRenderers('intelligence-recap', { summary });
    })

    this.intelligenceManager.on('recap_token', (token: string) => {
      sendToRenderers('intelligence-recap-token', { token });
    })

    this.intelligenceManager.on('clarify', (clarification: string) => {
      sendToRenderers('intelligence-clarify', { clarification });
    })

    this.intelligenceManager.on('clarify_token', (token: string) => {
      sendToRenderers('intelligence-clarify-token', { token });
    })

    this.intelligenceManager.on('follow_up_questions_update', (questions: string) => {
      sendToRenderers('intelligence-follow-up-questions-update', { questions });
    })

    this.intelligenceManager.on('follow_up_questions_token', (token: string) => {
      sendToRenderers('intelligence-follow-up-questions-token', { token });
    })

    this.intelligenceManager.on('manual_answer_started', () => {
      sendToRenderers('intelligence-manual-started');
    })

    this.intelligenceManager.on('manual_answer_result', (answer: string, question: string) => {
      sendToRenderers('intelligence-manual-result', { answer, question });
    })

    this.intelligenceManager.on('mode_changed', (mode: string) => {
      sendToRenderers('intelligence-mode-changed', { mode });
    })

    this.intelligenceManager.on('error', (error: Error, mode: string) => {
      console.error(`[IntelligenceManager] Error in ${mode}:`, error)
      sendToRenderers('intelligence-error', { error: error.message, mode });
    })

    this.intelligenceManager.on('copilot_suggestion', (decision: any) => {
      const helper = this.getWindowHelper();
      helper.getLauncherWindow()?.webContents.send('copilot-suggestion', decision);
      helper.getOverlayWindow()?.webContents.send('copilot-suggestion', decision);
    })

    this.intelligenceManager.on('copilot_decision', (decision: any) => {
      sendToRenderers('copilot-decision', decision);
    })

    this.intelligenceManager.on('copilot_error', (error: Error) => {
      console.warn('[CopilotDecisionEngine] Error:', error.message)
      const helper = this.getWindowHelper();
      const payload = { error: error.message };
      helper.getLauncherWindow()?.webContents.send('copilot-error', payload);
      helper.getOverlayWindow()?.webContents.send('copilot-error', payload);
    })
  }





  public updateGoogleCredentials(keyPath: string): void {
    console.log(`[AppState] Updating Google Credentials to: ${keyPath}`);
    // Set global environment variable so new instances pick it up
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

    this.googleSTT?.setCredentials?.(keyPath);
    this.googleSTT_User?.setCredentials?.(keyPath);
  }

  public setRecognitionLanguage(key: string): void {
    console.log(`[AppState] Setting recognition language to: ${key}`);
    const { CredentialsManager } = require('./services/CredentialsManager');
    CredentialsManager.getInstance().setSttLanguage(key);

    // 'auto' is only meaningful for NativelyProSTT — other providers fall back to en-US.
    const sttProvider = CredentialsManager.getInstance().getSttProvider();
    const effectiveKey = (key === 'auto' && sttProvider !== 'natively') ? 'english-us' : key;

    this.googleSTT?.setRecognitionLanguage(effectiveKey);
    this.googleSTT_User?.setRecognitionLanguage(effectiveKey);
    this.processingHelper.getLLMHelper().setSttLanguage(effectiveKey);
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // Getters and Setters
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getWindowHelper(): WindowHelper {
    return this.windowHelper
  }

  public getIntelligenceManager(): IntelligenceManager {
    return this.intelligenceManager
  }

  public async regenerateMeetingSummary(
    meetingId: string,
    options: { useAudioReplay?: boolean } = {},
  ): Promise<{ success: boolean; detailedSummary?: any; error?: string }> {
    try {
      const meeting = DatabaseManager.getInstance().getMeetingDetails(meetingId);
      if (!meeting) {
        return { success: false, error: 'Meeting not found' };
      }

      const agent = new MeetingSummaryAgent(this.processingHelper.getLLMHelper());
      const detailedSummary = await agent.generateFromMeeting(meeting, {
        useAudioReplay: options.useAudioReplay === true,
      });
      const saved = DatabaseManager.getInstance().updateMeetingSummary(meetingId, detailedSummary);
      if (!saved) {
        return { success: false, error: 'Failed to save regenerated summary' };
      }

      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('meetings-updated');
      });

      return { success: true, detailedSummary };
    } catch (error: any) {
      console.error('[AppState] Failed to regenerate meeting summary:', error);
      return { success: false, error: error?.message || String(error) };
    }
  }

  public getThemeManager(): ThemeManager {
    return this.themeManager
  }

  public getRAGManager(): RAGManager | null {
    return this.ragManager;
  }

  public getKnowledgeOrchestrator(): any {
    return this.knowledgeOrchestrator;
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Window management methods
  public setupOllamaIpcHandlers(): void {
    ipcMain.handle('get-ollama-models', async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout for detection

        const response = await fetch('http://localhost:11434/api/tags', {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          // data.models is an array of objects: { name: "llama3:latest", ... }
          return data.models.map((m: any) => m.name);
        }
        return [];
      } catch (error) {
        // console.warn("Ollama detection failed:", error);
        return [];
      }
    });
  }

  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(inactive?: boolean): void {
    if (this.windowHelper) {
      this.windowHelper.showMainWindow(inactive)
    }
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    
    const mode = this.windowHelper.getCurrentWindowMode();
    
    if (mode === 'launcher') {
      // In launcher mode, just physically hide/show the window
      this.windowHelper.toggleMainWindow();
    } else {
      // In overlay mode, send toggle-expand IPC to expand/collapse the UI
      const targetWindow = this.windowHelper.getOverlayWindow();
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('toggle-expand');
      }
    }
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  private createScreenshotCaptureSession(
    captureKind: ScreenshotCaptureKind,
    restoreFocus: boolean
  ): ScreenshotCaptureSession {
    const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
    const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();

    return {
      captureKind,
      wasMainWindowVisible: this.windowHelper.isVisible(),
      windowMode: this.windowHelper.getCurrentWindowMode(),
      wasSettingsVisible: !!settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible(),
      wasModelSelectorVisible: !!modelSelectorWindow && !modelSelectorWindow.isDestroyed() && modelSelectorWindow.isVisible(),
      overlayBounds: this.windowHelper.getLastOverlayBounds(),
      overlayDisplayId: this.windowHelper.getLastOverlayDisplayId(),
      restoreWithoutFocus: process.platform === 'darwin' || !restoreFocus
    };
  }

  private getDisplayById(displayId: number | null): Electron.Display | undefined {
    if (displayId === null) return undefined;
    return screen.getAllDisplays().find(display => display.id === displayId);
  }

  private getTargetDisplayForFullScreenshot(session: ScreenshotCaptureSession): Electron.Display {
    if (session.windowMode === 'overlay' && session.overlayBounds) {
      return screen.getDisplayMatching(session.overlayBounds);
    }

    const lastOverlayDisplay = this.getDisplayById(session.overlayDisplayId);
    if (lastOverlayDisplay) {
      return lastOverlayDisplay;
    }

    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  private hideWindowsForScreenshot(session: ScreenshotCaptureSession): void {
    if (session.wasModelSelectorVisible) {
      this.modelSelectorWindowHelper.hideWindow();
    }

    if (session.wasSettingsVisible) {
      this.settingsWindowHelper.closeWindow();
    }

    if (session.wasMainWindowVisible) {
      this.hideMainWindow();
    }
  }

  private restoreWindowsAfterScreenshot(session: ScreenshotCaptureSession): void {
    const activate = !session.restoreWithoutFocus;
    const shouldRestoreMainWindow = session.wasMainWindowVisible;

    if (shouldRestoreMainWindow) {
      if (session.windowMode === 'overlay') {
        this.windowHelper.switchToOverlay(!activate);
      } else {
        this.windowHelper.switchToLauncher(!activate);
      }
    }

    if (session.wasSettingsVisible) {
      const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        const { x, y } = settingsWindow.getBounds();
        this.settingsWindowHelper.showWindow(x, y, { activate });
      }
    }

    if (session.wasModelSelectorVisible) {
      const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
      if (modelSelectorWindow && !modelSelectorWindow.isDestroyed()) {
        const { x, y } = modelSelectorWindow.getBounds();
        this.modelSelectorWindowHelper.showWindow(x, y, { activate });
      }
    }
  }

  private async withScreenshotCaptureSession<T>(
    captureKind: ScreenshotCaptureKind,
    restoreFocus: boolean,
    capture: (session: ScreenshotCaptureSession) => Promise<T>
  ): Promise<T> {
    if (!this.getMainWindow()) {
      throw new Error("No main window available");
    }

    if (this.screenshotCaptureInProgress) {
      throw new Error("Screenshot capture already in progress");
    }

    const session = this.createScreenshotCaptureSession(captureKind, restoreFocus);
    this.screenshotCaptureInProgress = true;

    try {
      this.hideWindowsForScreenshot(session);
      // setOpacity(0) makes the window invisible to the compositor immediately
      // (within the current frame). hide() removes it from the event dispatch
      // tree synchronously. One compositor frame flush (~16ms) is enough for
      // macOS to stop including the window in the next capture frame. We wait
      // 80ms to give the GPU render server one full v-sync cycle + overhead,
      // which consistently avoids the black-frame artifact without the
      // excessive 150ms latency the old value imposed.
      await new Promise(resolve => setTimeout(resolve, process.platform === 'darwin' ? 80 : 40));
      return await capture(session);
    } finally {
      try {
        this.restoreWindowsAfterScreenshot(session);
      } finally {
        this.screenshotCaptureInProgress = false;
      }
    }
  }

  // Screenshot management methods
  public async takeScreenshot(restoreFocus: boolean = true): Promise<string> {
    return this.withScreenshotCaptureSession('full', restoreFocus, (session) =>
      this.screenshotHelper.takeScreenshot(this.getTargetDisplayForFullScreenshot(session))
    )
  }

  public async takeSelectiveScreenshot(restoreFocus: boolean = true): Promise<string> {
    return this.withScreenshotCaptureSession('selective', restoreFocus, async () => {
      let captureArea: Electron.Rectangle | undefined;

      if (process.platform === 'win32' || process.platform === 'darwin') {
        captureArea = await this.cropperWindowHelper.showCropper();

        if (!captureArea) {
          throw new Error("Selection cancelled");
        }
      }

      return this.screenshotHelper.takeSelectiveScreenshot(captureArea)
    })
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }
  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }
  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  public createTray(): void {
    this.showTray();
  }

  public showTray(): void {
    if (this.tray) return;

    // Try to find a template image first for macOS
    const resourcesPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

    // Potential paths for tray icon
    const templatePath = path.join(resourcesPath, 'assets', 'iconTemplate.png');
    const defaultIconPath = app.isPackaged
      ? path.join(resourcesPath, 'src/components/icon.png')
      : path.join(app.getAppPath(), 'src/components/icon.png');

    let iconToUse = defaultIconPath;

    // Check if template exists (sync check is fine for startup/rare toggle)
    try {
      if (require('fs').existsSync(templatePath)) {
        iconToUse = templatePath;
        console.log('[Tray] Using template icon:', templatePath);
      } else {
        // Also check src/components for dev
        const devTemplatePath = path.join(app.getAppPath(), 'src/components/iconTemplate.png');
        if (require('fs').existsSync(devTemplatePath)) {
          iconToUse = devTemplatePath;
          console.log('[Tray] Using dev template icon:', devTemplatePath);
        } else {
          console.log('[Tray] Template icon not found, using default:', defaultIconPath);
        }
      }
    } catch (e) {
      console.error('[Tray] Error checking for icon:', e);
    }

    const trayIcon = nativeImage.createFromPath(iconToUse).resize({ width: 16, height: 16 });
    // IMPORTANT: specific template settings for macOS if needed, but 'Template' in name usually suffices
    trayIcon.setTemplateImage(iconToUse.endsWith('Template.png'));

    this.tray = new Tray(trayIcon)
    this.tray.setToolTip('Natively') // This tooltip might also need update if we change global shortcut, but global shortcut is removed.
    this.updateTrayMenu();

    // Double-click to show window
    this.tray.on('double-click', () => {
      this.centerAndShowWindow()
    })
  }

  public updateTrayMenu() {
    if (!this.tray) return;

    const keybindManager = KeybindManager.getInstance();
    const screenshotAccel = keybindManager.getKeybind('general:take-screenshot') || 'CommandOrControl+H';

    console.log('[Main] updateTrayMenu called. Screenshot Accelerator:', screenshotAccel);

    // Update tooltip for verification
    this.tray.setToolTip('Natively');

    // Helper to format accelerator for display (e.g. CommandOrControl+H -> Cmd+H)
    const formatAccel = (accel: string) => {
      return accel
        .replace('CommandOrControl', 'Cmd')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl')
        .replace('OrControl', '') // Cleanup just in case
        .replace(/\+/g, '+');
    };

    const displayScreenshot = formatAccel(screenshotAccel);
    // We can also get the toggle visibility shortcut if desired
    const toggleKb = keybindManager.getKeybind('general:toggle-visibility');
    const toggleAccel = toggleKb || 'CommandOrControl+B';
    const displayToggle = formatAccel(toggleAccel);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Natively',
        click: () => {
          this.centerAndShowWindow()
        }
      },
      {
        label: `Toggle Window (${displayToggle})`,
        click: () => {
          this.toggleMainWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: `Take Screenshot (${displayScreenshot})`,
        accelerator: screenshotAccel,
        click: async () => {
          try {
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  public hideTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  public setUndetectable(state: boolean): void {
    // Guard: skip if state hasn't actually changed to prevent
    // duplicate dock hide/show cycles from renderer feedback loops
    if (this.isUndetectable === state) return;

    console.log(`[Stealth] setUndetectable(${state}) called`);

    this.isUndetectable = state
    this.windowHelper.setContentProtection(state)
    this.settingsWindowHelper.setContentProtection(state)
    this.modelSelectorWindowHelper.setContentProtection(state)
    this.cropperWindowHelper.setContentProtection(state)

    // Persist state via SettingsManager
    SettingsManager.getInstance().set('isUndetectable', state);

    // Cancel all pending disguise timers to prevent their app.setName() calls
    // from re-registering the dock icon after we hide it
    if (state) {
      for (const timer of this._disguiseTimers) {
        clearTimeout(timer);
      }
      this._disguiseTimers = [];
    }

    // Broadcast state change to all relevant windows
    this._broadcastToAllWindows('undetectable-changed', state);

    // --- STEALTH MODE LOGIC ---
    // The dock hide/show is debounced: rapid toggles update isUndetectable immediately
    // (so content protection, IPC broadcasts and the guard above are always current),
    // but the actual macOS dock/tray/focus operation only fires once the user stops
    // toggling. This eliminates the race where dock.show() + NSApp.activate() lingers
    // after a subsequent dock.hide() call.
    if (process.platform === 'darwin') {
      if (this._dockDebounceTimer) {
        clearTimeout(this._dockDebounceTimer);
        this._dockDebounceTimer = null;
      }

      this._dockDebounceTimer = setTimeout(() => {
        this._dockDebounceTimer = null;

        // Read the settled state — may differ from the `state` captured above
        // if the user toggled again before the timer fired.
        const settled = this.isUndetectable;

        const activeWindow = this.windowHelper.getMainWindow();
        const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
        let targetFocusWindow = activeWindow;
        if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
          targetFocusWindow = settingsWindow;
        }

        const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
        const isModelSelectorVisible = modelSelectorWindow && !modelSelectorWindow.isDestroyed() && modelSelectorWindow.isVisible();

        if (targetFocusWindow && targetFocusWindow === settingsWindow) {
          this.settingsWindowHelper.setIgnoreBlur(true);
        }
        if (isModelSelectorVisible) {
          this.modelSelectorWindowHelper.setIgnoreBlur(true);
        }

        if (settled) {
          // Capture whether Natively is currently the frontmost app BEFORE
          // dock.hide() — that call triggers an implicit macOS app-deactivation
          // which shifts keyboard focus to the next frontmost app (Chrome, etc.).
          const nativelyWasFocused =
            targetFocusWindow != null &&
            !targetFocusWindow.isDestroyed() &&
            targetFocusWindow.isFocused();

          console.log('[Stealth] Calling app.dock.hide()');
          app.dock.hide();
          this.hideTray();

          // If Natively was the focused window when the user toggled stealth,
          // restore focus to our window after dock.hide() so macOS does not
          // hand control to Chrome / whatever is behind us.
          // We use win.focus() (not app.focus()) to avoid the heavy-handed
          // [NSApp activateIgnoringOtherApps:YES] side-effect.
          if (nativelyWasFocused && targetFocusWindow && !targetFocusWindow.isDestroyed()) {
            targetFocusWindow.focus();
          }
        } else {
          console.log('[Stealth] Calling app.dock.show()');
          app.dock.show();
          this.showTray();
          // Do NOT call focus() — let the user's current app retain focus
        }

        if (targetFocusWindow && targetFocusWindow === settingsWindow) {
          setTimeout(() => { this.settingsWindowHelper.setIgnoreBlur(false); }, 500);
        }
        if (isModelSelectorVisible) {
          setTimeout(() => { this.modelSelectorWindowHelper.setIgnoreBlur(false); }, 500);
        }
      }, 150);
    }
  }

  public getUndetectable(): boolean {
    return this.isUndetectable
  }

  // --- Mouse Passthrough (Adapted from public PR #113 — verify premium interaction) ---
  private overlayMousePassthrough: boolean = false;

  public setOverlayMousePassthrough(state: boolean): void {
    if (this.overlayMousePassthrough === state) return;

    console.log(`[Overlay] setOverlayMousePassthrough(${state}) called`);

    this.overlayMousePassthrough = state;
    this.windowHelper.syncOverlayInteractionPolicy();

    // Immediately revalidate global shortcuts after the window interaction-policy
    // changes.  The OS can silently drop Carbon/IOKit hotkey registrations when
    // window focusability or visibility changes; revalidating surgically
    // re-registers any that were lost without clobbering the others.
    KeybindManager.getInstance().revalidateShortcuts();

    this._broadcastToAllWindows('overlay-mouse-passthrough-changed', state);
  }

  public toggleOverlayMousePassthrough(): boolean {
    const next = !this.overlayMousePassthrough;
    this.setOverlayMousePassthrough(next);
    return next;
  }

  public getOverlayMousePassthrough(): boolean {
    return this.overlayMousePassthrough;
  }

  public getVerboseLogging(): boolean {
    return this._verboseLogging;
  }

  public setVerboseLogging(enabled: boolean): void {
    this._verboseLogging = enabled;
    setVerboseLoggingFlag(enabled);
    SettingsManager.getInstance().set('verboseLogging', enabled);
    console.log(`[AppState] verboseLogging set to ${enabled}`);
    // Notify all renderer windows so they can start/stop forwarding their console output
    this.broadcast('verbose-logging-changed', enabled);
  }

  public setDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    this.disguiseMode = mode;
    SettingsManager.getInstance().set('disguiseMode', mode);

    // Apply the disguise regardless of undetectable state
    // (disguise affects Activity Monitor name via process.title,
    //  dock icon only updates when NOT in stealth)
    this._applyDisguise(mode);
  }

  public applyInitialDisguise(): void {
    this._applyDisguise(this.disguiseMode);
  }

  private _applyDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    let appName = "Natively";
    let iconPath = "";

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    switch (mode) {
      case 'terminal':
        appName = isWin ? "Command Prompt " : "Terminal ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/terminal.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/terminal.png");
        }
        break;
      case 'settings':
        appName = isWin ? "Settings " : "System Settings ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/settings.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/settings.png");
        }
        break;
      case 'activity':
        appName = isWin ? "Task Manager " : "Activity Monitor ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/activity.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/activity.png");
        }
        break;
      case 'none':
        appName = "Natively";
        if (isMac) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "natively.icns")
            : path.join(app.getAppPath(), "assets/natively.icns");
        } else if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/icons/win/icon.ico")
            : path.join(app.getAppPath(), "assets/icons/win/icon.ico");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "icon.png")
            : path.join(app.getAppPath(), "assets/icon.png");
        }
        break;
    }

    console.log(`[AppState] Applying disguise: ${mode} (${appName}) on ${process.platform}`);

    // 1. Update process title (affects Activity Monitor / Task Manager)
    process.title = appName;

    // 2. Update app name (affects macOS Menu / Dock)
    // Skip when undetectable — app.setName() causes macOS to re-register
    // the app and re-show the dock icon even after dock.hide()
    if (!this.isUndetectable) {
      app.setName(appName);
    }

    if (isMac) {
      process.env.CFBundleName = appName.trim();
    }

    // 3. Update App User Model ID (Windows Taskbar grouping)
    if (isWin) {
      // Use unique AUMID per disguise to avoid grouping with the real app
      app.setAppUserModelId(`com.natively.assistant.${mode}`);
    }

    // 4. Update Icons
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);

      if (isMac) {
        // Skip dock icon update when dock is hidden to avoid potential flicker
        if (!this.isUndetectable) {
          app.dock.setIcon(image);
        }
      } else {
        // Windows/Linux: Update all window icons
        this.windowHelper.getLauncherWindow()?.setIcon(image);
        this.windowHelper.getOverlayWindow()?.setIcon(image);
        this.settingsWindowHelper.getSettingsWindow()?.setIcon(image);
      }
    } else {
      console.warn(`[AppState] Disguise icon not found: ${iconPath}`);
    }

    // 5. Update Window Titles
    const launcher = this.windowHelper.getLauncherWindow();
    if (launcher && !launcher.isDestroyed()) {
      launcher.setTitle(appName.trim());
      launcher.webContents.send('disguise-changed', mode);
    }

    const overlay = this.windowHelper.getOverlayWindow();
    if (overlay && !overlay.isDestroyed()) {
      overlay.setTitle(appName.trim());
      overlay.webContents.send('disguise-changed', mode);
    }

    const settingsWin = this.settingsWindowHelper.getSettingsWindow();
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.setTitle(appName.trim());
      settingsWin.webContents.send('disguise-changed', mode);
    }

    // Cancel any stale forceUpdate timeouts from previous disguise changes
    for (const timer of this._disguiseTimers) {
      clearTimeout(timer);
    }
    this._disguiseTimers = [];

    // Periodically re-assert process.title only — it can drift on some systems.
    // NOTE: We intentionally do NOT call app.setName() here — it was already called
    // synchronously above, and repeated calls on macOS cause the system to briefly
    // show a second dock tile while re-registering the app identity.
    const scheduleUpdate = (ms: number) => {
      const ts = setTimeout(() => {
        process.title = appName;
        this._disguiseTimers = this._disguiseTimers.filter(t => t !== ts);
      }, ms);
      this._disguiseTimers.push(ts);
    };

    scheduleUpdate(200);
    scheduleUpdate(1000);
    scheduleUpdate(5000);
  }

  // Helper: broadcast an IPC event to all windows
  private _broadcastToAllWindows(channel: string, ...args: any[]): void {
    const windows = [
      this.windowHelper.getMainWindow(),
      this.windowHelper.getLauncherWindow(),
      this.windowHelper.getOverlayWindow(),
      this.settingsWindowHelper.getSettingsWindow(),
      this.modelSelectorWindowHelper.getWindow(),
    ];
    const sent = new Set<number>();
    for (const win of windows) {
      if (win && !win.isDestroyed() && !sent.has(win.id)) {
        sent.add(win.id);
        win.webContents.send(channel, ...args);
      }
    }
  }

  public getDisguise(): string {
    return this.disguiseMode;
  }
}

// Application initialization

function getOneShotSummaryRegenerationJob(): {
  meetingId: string;
  model: string;
  useAudioReplay: boolean;
  outputPath?: string;
} | null {
  const meetingId = String(process.env.NATIVELY_REGENERATE_MEETING_ID || '').trim();
  if (!meetingId) return null;

  return {
    meetingId,
    model: String(process.env.NATIVELY_REGENERATE_MODEL || 'codex:gpt-5.6-terra').trim() || 'codex:gpt-5.6-terra',
    useAudioReplay: /^(1|true|yes)$/i.test(String(process.env.NATIVELY_REGENERATE_USE_AUDIO_REPLAY || '')),
    outputPath: String(process.env.NATIVELY_REGENERATE_OUTPUT_PATH || '').trim() || undefined,
  };
}

async function maybeRunOneShotSummaryRegeneration(appState: AppState): Promise<boolean> {
  const job = getOneShotSummaryRegenerationJob();
  if (!job) return false;

  const { CredentialsManager } = require('./services/CredentialsManager');
  const credManager = CredentialsManager.getInstance();
  const providers = [
    ...(credManager.getCurlProviders() || []),
    ...(credManager.getCustomProviders() || []),
  ];

  const llmHelper = appState.processingHelper.getLLMHelper();
  llmHelper.setModel(job.model, providers);

  console.log(
    `[OneShotSummaryRegen] Starting regeneration for meeting ${job.meetingId} ` +
    `with model=${job.model} useAudioReplay=${job.useAudioReplay}`
  );

  const result = await appState.regenerateMeetingSummary(job.meetingId, {
    useAudioReplay: job.useAudioReplay,
  });
  const meeting = DatabaseManager.getInstance().getMeetingDetails(job.meetingId);
  const payload = {
    success: result.success,
    error: result.error,
    meetingId: job.meetingId,
    requestedModel: job.model,
    runtimeProvider: llmHelper.getCurrentProvider(),
    runtimeModel: llmHelper.getCurrentModel(),
    generationRoute: llmHelper.getLastMeetingSummaryRoute(),
    useAudioReplay: job.useAudioReplay,
    overview: result.detailedSummary?.overview || meeting?.detailedSummary?.overview || '',
    quality: result.detailedSummary?.quality || meeting?.detailedSummary?.quality || null,
    sections: result.detailedSummary?.sections || meeting?.detailedSummary?.sections || [],
    actionItems: result.detailedSummary?.actionItems || meeting?.detailedSummary?.actionItems || [],
    keyPoints: result.detailedSummary?.keyPoints || meeting?.detailedSummary?.keyPoints || [],
  };

  if (job.outputPath) {
    fs.writeFileSync(job.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[OneShotSummaryRegen] Wrote output to ${job.outputPath}`);
  }

  console.log(JSON.stringify(payload, null, 2));
  app.exit(result.success ? 0 : 1);
  return true;
}

async function initializeApp() {
  // 1. Enforce single instance — prevent duplicate dock icons from leftover processes.
  // In development mode with hot-reload this is still safe because electron is restarted
  // by the build step, not re-launched by concurrently while the old process is alive.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log('[Main] Another instance is already running. Quitting this instance.');
    app.quit();
    return;
  }

  // 2. Wait for app to be ready
  await app.whenReady()

  // 2a. PRE-EMPTIVE dock hide: must happen before ANY operation that causes macOS to
  // register a dock entry (app.setName, BrowserWindow creation, etc.).
  // We read isUndetectable directly from settings here — AppState singleton isn't
  // constructed yet, so we cannot call appState.getUndetectable().
  if (process.platform === 'darwin') {
    // SettingsManager is already statically imported — no require() needed.
    const isUndetectableOnStartup = SettingsManager.getInstance().get('isUndetectable') ?? false;
    if (isUndetectableOnStartup) {
      app.dock.hide();
    }
  }

  // 3. Initialize Managers
  // Initialize CredentialsManager and load keys explicitly
  // This fixes the issue where keys (especially in production) aren't loaded in time for RAG/LLM
  const { CredentialsManager } = require('./services/CredentialsManager');
  CredentialsManager.getInstance().init();

  // 4. Initialize State
  const appState = AppState.getInstance()

  // Explicitly load credentials into helpers
  appState.processingHelper.loadStoredCredentials();

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  if (await maybeRunOneShotSummaryRegeneration(appState)) {
    return;
  }

  // Apply the full disguise payload (names, dock icon, AUMID) early
  appState.applyInitialDisguise();

  // Start the Ollama lifecycle manager
  OllamaManager.getInstance().init().catch(console.error);

  // NOTE: CredentialsManager.init() and loadStoredCredentials() are already called
  // above before this block — do NOT call them again here to avoid double key-load.

  // Anonymous install ping - one-time, non-blocking
  // See electron/services/InstallPingManager.ts for privacy details
  const { sendAnonymousInstallPing } = require('./services/InstallPingManager');
  sendAnonymousInstallPing();

  // Load stored Google Service Account path (for Speech-to-Text)
  // Fall back to GOOGLE_APPLICATION_CREDENTIALS env var (set in terminal but not Spotlight)
  const storedServiceAccountPath = CredentialsManager.getInstance().getGoogleServiceAccountPath()
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (storedServiceAccountPath) {
    console.log("[Init] Loading stored Google Service Account path");
    appState.updateGoogleCredentials(storedServiceAccountPath);
    // Persist env-var path so Spotlight launches also work going forward
    if (!CredentialsManager.getInstance().getGoogleServiceAccountPath()) {
      CredentialsManager.getInstance().setGoogleServiceAccountPath(storedServiceAccountPath);
    }
  }

  console.log("App is ready")

  appState.createWindow()

  // Apply initial stealth state based on isUndetectable setting.
  // NOTE: app.dock.hide() was already called pre-emptively before createWindow()
  // when isUndetectable=true. Here we only need to initialize the tray for non-stealth mode.
  if (!appState.getUndetectable()) {
    // Normal mode: show tray (dock is already showing — no need to call dock.show() again)
    appState.showTray();
  }
  // Stealth mode: dock is already hidden, tray stays hidden, no action needed here.
  // Register global shortcuts using KeybindManager
  KeybindManager.getInstance().registerGlobalShortcuts()

  // Pre-create settings window in background for faster first open
  appState.settingsWindowHelper.preloadWindow()

  // One-time macOS screen recording permission prompt.
  //
  // We must fire this AFTER createWindow() so that:
  //   1. The Natively launcher window is visible and focused when the TCC dialog
  //      appears — macOS anchors the dialog to the frontmost app window on Ventura+.
  //      Without a visible window the dialog can appear behind other apps (Sequoia).
  //   2. In stealth/undetectable mode the dock icon is hidden, but the window is
  //      still visible — the dialog still has a surface to attach to.
  //
  // The 800ms delay lets the launcher's ready-to-show animation complete so the
  // window is fully composited before the system sheet appears above it.
  //
  // TCC caches the decision permanently after the first response — this block
  // runs exactly ONCE on the first launch of each unique packaged binary.
  // On every subsequent launch the status is 'granted' or 'denied', and we skip.
  if (process.platform === 'darwin') {
    setTimeout(async () => {
      try {
        const screenStatus = systemPreferences.getMediaAccessStatus('screen');
        console.log(`[Init] Screen recording permission status at startup: ${screenStatus}`);

        if (!app.isPackaged) {
          console.log('[Init] Ignoring screen recording permission check in development mode');
          return;
        }

        if (screenStatus === 'not-determined') {
          // First launch: trigger the one-time TCC dialog by making a minimal
          // desktopCapturer call. macOS will show the permission sheet anchored
          // to our window. The user's response is stored permanently in the TCC
          // database — we do NOT check status immediately after because the dialog
          // is still open; the status will be read correctly next time `startMeeting`
          // is called (which is the correct gate for system audio access).
          console.log('[Init] Screen recording not-determined — showing one-time TCC dialog...');
          try {
            await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
          } catch (e) {
            // On some Electron builds getSources throws when permission is pending —
            // that's fine; the TCC dialog has still been triggered.
            console.log('[Init] getSources threw (expected during TCC pending state):', (e as Error).message);
          }
          // NOTE: Do NOT read afterStatus here — TCC response is async (dialog still open).
          // startMeeting() reads the status when the user actually tries to use audio.

        } else if (screenStatus === 'denied') {
          // Returning user who previously denied — show the banner immediately at startup
          // so they know system audio won't work before they even start a meeting.
          console.warn('[Init] Screen recording was previously denied — notifying UI banner.');
          const { BrowserWindow } = require('electron');
          BrowserWindow.getAllWindows().forEach((win: Electron.BrowserWindow) => {
            if (!win.isDestroyed()) {
              win.webContents.send(
                'system-audio-permission-denied',
                'Screen Recording is disabled. System audio capture will not work. Click "Open Settings" to enable it, then restart Natively.'
              );
            }
          });
        } else {
          // 'granted' or 'restricted' — nothing to do.
          console.log(`[Init] Screen recording permission already resolved: ${screenStatus}`);
        }
      } catch (e) {
        console.warn('[Init] Startup screen recording permission check failed:', e);
      }
    }, 800);
  }

  // Initialize CalendarManager
  try {
    const { CalendarManager } = require('./services/CalendarManager');
    const calMgr = CalendarManager.getInstance();
    calMgr.init();

    calMgr.on('start-meeting-requested', (event: any) => {
      console.log('[Main] Start meeting requested from calendar notification', event);
      appState.centerAndShowWindow();
      appState.startMeeting({
        title: event.title,
        calendarEventId: event.id,
        source: 'calendar'
      });
    });

    calMgr.on('open-requested', () => {
      appState.centerAndShowWindow();
    });

    console.log('[Main] CalendarManager initialized');
  } catch (e) {
    console.error('[Main] Failed to initialize CalendarManager:', e);
  }

  // Recover unprocessed meetings (persistence check)
  appState.getIntelligenceManager().recoverUnprocessedMeetings().catch(err => {
    console.error('[Main] Failed to recover unprocessed meetings:', err);
  });

  // Note: We do NOT force dock show here anymore, respecting stealth mode.

  app.on("activate", () => {
    console.log("App activated")
    if (process.platform === 'darwin') {
      // Do NOT call dock.show() while a meeting is running — the dock icon
      // appearing mid-meeting is a critical stealth failure.
      if (!appState.getUndetectable() && !appState.getIsMeetingActive()) {
        app.dock.show();
      }
    }
    
    // If no window exists, create it
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    } else {
      // If the window exists but is hidden, clicking the dock icon should restore it
      if (!appState.isVisible()) {
        appState.toggleMainWindow();
      }
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Scrub API keys from memory on quit to minimize exposure window
  app.on("before-quit", (event) => {
    console.log("App is quitting, cleaning up resources...");
    appState.setQuitting(true);

    // Dispose CropperWindowHelper to clean up IPC listeners and prevent memory leaks
    // This is critical to prevent resource leaks and ensure proper cleanup
    if (appState?.cropperWindowHelper) {
      appState.cropperWindowHelper.dispose();
    }

    // Kill Ollama if we started it
    OllamaManager.getInstance().stop();

    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().scrubMemory();
      appState.processingHelper.getLLMHelper().scrubKeys();
      console.log('[Main] Credentials scrubbed from memory on quit');
    } catch (e) {
      console.error('[Main] Failed to scrub credentials on quit:', e);
    }
  })



  // app.dock?.hide() // REMOVED: User wants Dock icon visible
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
