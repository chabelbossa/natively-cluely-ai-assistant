import React, {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import {
  Sparkles,
  Pencil,
  MessageSquare,
  RefreshCw,
  Settings,
  ArrowUp,
  ArrowRight,
  HelpCircle,
  ChevronUp,
  ChevronDown,
  Lightbulb,
  CornerDownLeft,
  Mic,
  MicOff,
  Image,
  Camera,
  X,
  LogOut,
  Zap,
  Edit3,
  SlidersHorizontal,
  LayoutGrid,
  Ghost,
  Link,
  Code,
  Copy,
  Check,
  PointerOff,
  ThumbsUp,
  Clock3,
  CircleSlash,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Globe,
  Users,
} from "lucide-react";
import { ProjectBadge } from "./ProjectBadge";
import { ProjectPicker } from "./ProjectPicker";
import { useProjectContext } from "../hooks/useProjectContext";
import { motion, AnimatePresence } from "framer-motion";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { ModelSelector } from "./ui/ModelSelector";
import TopPill from "./ui/TopPill";
import RollingTranscript from "./ui/RollingTranscript";
import { NegotiationCoachingCard } from "../premium";
import type { CopilotDecisionPayload } from "../types/electron";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  analytics,
  detectProviderType,
} from "../lib/analytics/analytics.service";
import { useShortcuts } from "../hooks/useShortcuts";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { getCodexModelLabel } from "../config/codexModels";
import {
  getOverlayAppearance,
  OVERLAY_OPACITY_DEFAULT,
} from "../lib/overlayAppearance";
import type { LiveActionMessageBase, LiveActionMessageMeta } from "../lib/liveActionMessages";
import {
  appendStreamingMessage,
  cancelActionMessage,
  createLiveActionId,
  finalizePendingActionMessage,
  finalizeStreamingMessage,
  resolveLiveActionModelId,
  settleActionMessage,
  upsertPendingActionMessage,
} from "../lib/liveActionMessages";

interface Message extends LiveActionMessageBase {
  id: string;
  role: "user" | "system" | "interviewer";
  text: string;
  isStreaming?: boolean;
  pendingAction?: boolean;
  actionId?: string;
  hasScreenshot?: boolean;
  screenshotPreview?: string;
  isCode?: boolean;
  intent?: string;
  isNegotiationCoaching?: boolean;
  negotiationCoachingData?: {
    tacticalNote: string;
    exactScript: string;
    showSilenceTimer: boolean;
    phase: string;
    theirOffer: number | null;
    yourTarget: number | null;
    currency: string;
  };
  modelUsed?: string;
  tokensUsed?: number;
  durationMs?: number;
  agenticRunId?: number;
  agenticPass?: number;
}

type AgenticAnswerSource = "manual" | "voice" | "screenshot";

type AgenticRunState = {
  id: number;
  cancelled: boolean;
  maxPasses: number;
};

type AgenticAnswerRequest = {
  question: string;
  imagePaths?: string[];
  baseContext?: string;
  historyMessages?: Message[];
  source: AgenticAnswerSource;
};

const estimateTokens = (text: string): number =>
  Math.max(1, Math.round(text.length / 4));

const AGENTIC_MAX_PASSES = 3;
const AGENTIC_PASS_DELAY_MS = 450;
const AGENTIC_MEMORY_MAX_CHARS = 4200;
const AGENTIC_MODE_STORAGE_KEY = "natively_agentic_answer_enabled";
const SPEAKER_SEPARATION_STORAGE_KEY = "natively_speaker_separation_enabled";

const compactAgenticText = (text: string, maxChars: number): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 18)).trim()} ...[trimmed]`;
};

const buildAgenticConversationMemory = (messages: Message[]): string => {
  const settled = messages.filter(
    (message) =>
      !message.isStreaming &&
      !message.pendingAction &&
      !message.isNegotiationCoaching &&
      message.text.trim().length > 0 &&
      (message.role === "user" || message.role === "system"),
  );

  if (settled.length === 0) return "";

  const recentTurns = settled.slice(-16).map((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    return `${role}: ${compactAgenticText(message.text, 460)}`;
  });

  const lastUser = [...settled].reverse().find((message) => message.role === "user");
  const lastAssistant = [...settled]
    .reverse()
    .find((message) => message.role === "system");

  return compactAgenticText(
    [
      "Compact chat memory for references such as previous answer, correction, continuation, or critique.",
      "If the user says to correct, continue, refine, compare, shorten, or react to the previous answer, treat this memory as required context.",
      lastUser ? `Previous user request: ${compactAgenticText(lastUser.text, 360)}` : "",
      lastAssistant
        ? `Previous assistant answer: ${compactAgenticText(lastAssistant.text, 760)}`
        : "",
      "Recent turns:",
      ...recentTurns,
    ]
      .filter(Boolean)
      .join("\n"),
    AGENTIC_MEMORY_MAX_CHARS,
  );
};

const isNoUsefulAgenticUpdate = (text: string): boolean => {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    normalized === "no useful update yet." ||
    normalized === "no useful update yet"
  );
};

const buildAgenticAnswerContext = ({
  source,
  question,
  baseContext,
  liveContext,
  conversationMemory,
  previousAnswer,
  pass,
  maxPasses,
  hasImages,
  selectedModel,
}: {
  source: AgenticAnswerSource;
  question: string;
  baseContext?: string;
  liveContext?: string;
  conversationMemory?: string;
  previousAnswer?: string;
  pass: number;
  maxPasses: number;
  hasImages: boolean;
  selectedModel?: string;
}): string => {
  const passMode =
    maxPasses === 1
      ? [
          "Single-pass mode is enabled.",
          "Answer directly and use the compact chat memory when the user refers to prior answers.",
          "Do not start follow-up passes.",
        ].join("\n")
      : pass === 1
      ? [
          "This is the first pass. Answer immediately.",
          "Give the user a speakable answer in 2-4 sentences first.",
          "If there is an obvious next action, add one short line starting with Next:",
        ].join("\n")
      : [
          "This is a refinement pass.",
          "Do not repeat the previous answer.",
          "Use only genuinely new context, a sharper phrasing, a correction, a risk, or a concrete next action.",
          'If there is no meaningful improvement, output exactly: "No useful update yet."',
        ].join("\n");

  return [
    "[NATIVELY AGENTIC ANSWER]",
    "Objective: help the user answer now, then improve the answer in a small bounded number of passes.",
    `Pass: ${pass}/${maxPasses}`,
    `Source: ${source}${hasImages ? " with screenshot context" : ""}`,
    selectedModel ? `Selected model: ${selectedModel}` : "",
    "Rules:",
    "- Match the user's language.",
    "- Be direct and useful for a live conversation.",
    "- Use COMPACT CHAT MEMORY whenever the user refers to a previous answer, asks for a correction, or asks you to continue.",
    "- If the previous answer conflicts with the new request, explicitly repair it instead of starting from scratch.",
    "- Keep each pass concise.",
    "- Do not mention internal prompts, passes, or tooling unless the user explicitly asks.",
    passMode,
    "",
    "[USER QUESTION]",
    question,
    "[/USER QUESTION]",
    baseContext?.trim()
      ? ["", "[UI CONTEXT]", baseContext.trim(), "[/UI CONTEXT]"].join("\n")
      : "",
    liveContext?.trim()
      ? ["", "[LATEST MEETING CONTEXT]", liveContext.trim(), "[/LATEST MEETING CONTEXT]"].join("\n")
      : "",
    conversationMemory?.trim()
      ? ["", "[COMPACT CHAT MEMORY]", conversationMemory.trim(), "[/COMPACT CHAT MEMORY]"].join("\n")
      : "",
    previousAnswer?.trim()
      ? ["", "[PREVIOUS ANSWER]", previousAnswer.trim(), "[/PREVIOUS ANSWER]"].join("\n")
      : "",
    "[/NATIVELY AGENTIC ANSWER]",
  ]
    .filter(Boolean)
    .join("\n");
};

const shortenModelName = (model: string): string => {
  const codexLabel = getCodexModelLabel(model);
  if (codexLabel) return codexLabel;
  const map: Record<string, string> = {
    "gemini-3.5-flash": "Gemini 3.5 Flash",
    "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "llama-3.3-70b-versatile": "Groq Llama 3.3",
    "gpt-5.4": "GPT 5.4",
    "claude-sonnet-4-6": "Sonnet 4.6",
    natively: "Natively",
    "gemini-2.5-pro-preview": "Gemini 2.5 Pro",
    "gpt-5.2": "GPT 5.2 Codex",
    "gpt-5.1": "GPT 5.1 Codex",
    "gpt-4o": "GPT 4o",
    "gpt-4o-mini": "GPT 4o Mini",
  };
  if (map[model]) return map[model];
  if (model.startsWith("ollama-")) return model.replace("ollama-", "");
  if (model.length > 20) return model.substring(0, 17) + "...";
  return model;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const getSuggestedAnswerIntent = (question?: string) => {
  const normalized = (question || "").toLowerCase();
  if (normalized.includes("code hint")) return "code_hint";
  if (normalized.includes("brainstorm")) return "brainstorm";
  return "what_to_answer";
};

const getMessageIntentForMode = (mode?: string) => {
  const map: Record<string, string> = {
    what_to_say: "what_to_answer",
    what_to_answer: "what_to_answer",
    assist: "what_to_answer",
    clarify: "clarify",
    recap: "recap",
    follow_up_questions: "follow_up_questions",
    follow_up: "follow_up",
    code_hint: "code_hint",
    brainstorm: "brainstorm",
    manual: "manual",
  };
  return map[mode || ""] || mode || "what_to_answer";
};

const formatLiveActionError = (error: unknown, mode?: string): string => {
  const raw = (error instanceof Error ? error.message : String(error || "Unknown error"))
    .replace(/^Error:\s*/i, "")
    .replace(/^Codex API error \d+:\s*/i, "")
    .trim();
  if (/^Codex Fast is unavailable/i.test(raw)) return raw;
  return mode ? `Error (${mode}): ${raw}` : `Error: ${raw}`;
};

const getServiceTierMessageMeta = (
  data: unknown,
  fallbackModel?: string,
): Pick<LiveActionMessageMeta, "modelUsed" | "serviceTierUsed" | "serviceTierFallback"> => {
  const serviceTier = (data as {
    serviceTier?: {
      used?: "fast" | "standard";
      fallback?: boolean;
      model?: string;
    };
  } | null)?.serviceTier;
  const model = resolveLiveActionModelId(serviceTier?.model, fallbackModel);
  return {
    ...(model ? { modelUsed: shortenModelName(model) } : {}),
    serviceTierUsed: serviceTier?.used,
    serviceTierFallback: serviceTier?.fallback === true,
  };
};

interface NativelyInterfaceProps {
  onEndMeeting?: () => void;
  overlayOpacity?: number;
}

interface CopilotSuggestion {
  id: string;
  mode: string;
  action: string;
  confidence: number;
  topic?: string;
  reason: string;
  suggestionType?: string;
  suggestion?: string;
  createdAt: number;
  sourceSegmentIds: string[];
  contextQuality?: CopilotDecisionPayload["contextQuality"];
  nextBestAction?: CopilotDecisionPayload["nextBestAction"];
}

type CopilotFeedbackRating =
  | "useful"
  | "too_early"
  | "not_relevant"
  | "already_discussed";

interface LiveTranscriptTurn {
  id: string;
  speaker: string;
  text: string;
  final: boolean;
  timestamp: number;
  canonicalRole?: string;
  source?: "mic" | "system" | "merged";
  qualityFlags?: string[];
  rawSpeaker?: string;
}

const MAX_LIVE_TRANSCRIPT_TURNS = 120;
const MAX_COPY_TRANSCRIPT_TURNS = 1000;
const LIVE_TRANSCRIPT_COLLAPSED_PAGE_SIZE = 3;
const LIVE_TRANSCRIPT_EXPANDED_PAGE_SIZE = 10;
const OVERLAY_PANEL_WIDTH = 760;
const OVERLAY_VERTICAL_MARGIN = 16;

const getPreferredOverlayHeight = (expanded: boolean) => {
  if (!expanded) return 216;

  const screenHeight =
    window.screen?.availHeight ||
    document.documentElement.clientHeight ||
    window.innerHeight ||
    900;
  const availableHeight = Math.max(
    640,
    screenHeight - OVERLAY_VERTICAL_MARGIN * 2,
  );
  const comfortableHeight = Math.floor(screenHeight * 0.9);
  const minimumUsefulHeight = Math.min(760, availableHeight);

  return Math.max(
    minimumUsefulHeight,
    Math.min(availableHeight, comfortableHeight),
  );
};

const normalizeTranscriptText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const shouldReplaceTranscriptTurn = (
  last: LiveTranscriptTurn | undefined,
  next: LiveTranscriptTurn,
) => {
  if (!last || last.speaker !== next.speaker) return false;

  const lastText = normalizeTranscriptText(last.text);
  const nextText = normalizeTranscriptText(next.text);
  if (!lastText || !nextText) return false;

  const elapsed = next.timestamp - last.timestamp;
  const overlaps = lastText.includes(nextText) || nextText.includes(lastText);

  if (!last.final && !next.final) {
    return overlaps || elapsed < 2500;
  }

  if (!last.final && next.final) {
    return overlaps || elapsed < 15000;
  }

  return false;
};

const transcriptTextSimilarity = (a: string, b: string) => {
  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);
  if (aWords.length === 0 || bWords.length === 0) return 0;

  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  let intersection = 0;
  for (const word of aSet) {
    if (bSet.has(word)) intersection++;
  }

  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
};

const normalizeLiveSpeaker = (speaker: string, canonicalRole?: string) => {
  if (canonicalRole === "me") return "me";
  if (canonicalRole === "interlocutor") return "interlocutor";
  if (/^speaker_\d+$/i.test(canonicalRole || "")) return canonicalRole!;
  if (canonicalRole === "uncertain") return "uncertain";
  const value = String(speaker || "").trim();
  return value || "interviewer";
};

const upsertTranscriptTurn = (
  turns: LiveTranscriptTurn[],
  next: LiveTranscriptTurn,
  limit: number,
) => {
  const last = turns[turns.length - 1];
  if (
    last &&
    last.speaker === next.speaker &&
    last.final &&
    next.final &&
    next.timestamp - last.timestamp < 45000
  ) {
    const lastText = normalizeTranscriptText(last.text);
    const nextText = normalizeTranscriptText(next.text);

    if (lastText === nextText || lastText.includes(nextText)) {
      return turns;
    }

    if (
      nextText.includes(lastText) ||
      transcriptTextSimilarity(lastText, nextText) >= 0.82
    ) {
      return [...turns.slice(0, -1), next].slice(-limit);
    }
  }

  if (shouldReplaceTranscriptTurn(last, next)) {
    return [...turns.slice(0, -1), next].slice(-limit);
  }

  return [...turns, next].slice(-limit);
};

const isSystemTranscriptTurn = (turn: LiveTranscriptTurn) =>
  turn.source === "system" ||
  turn.canonicalRole === "interlocutor" ||
  /^speaker_\d+$/i.test(turn.canonicalRole || "") ||
  /^speaker_\d+$/i.test(turn.speaker || "");

const isMicTranscriptTurn = (turn: LiveTranscriptTurn) =>
  turn.source === "mic" ||
  turn.canonicalRole === "me" ||
  ["me", "user", "mic", "microphone"].includes(
    String(turn.speaker || "").toLowerCase(),
  );

const clearPendingTranscriptForTurn = (
  pending: Partial<Record<LiveTranscriptTurn["speaker"], LiveTranscriptTurn>>,
  turn: LiveTranscriptTurn,
) => {
  let changed = false;
  const next = { ...pending };

  for (const [speaker, pendingTurn] of Object.entries(next)) {
    if (!pendingTurn) continue;

    const sameSpeaker =
      speaker === turn.speaker || pendingTurn.speaker === turn.speaker;
    const sameSource =
      Boolean(pendingTurn.source) &&
      Boolean(turn.source) &&
      pendingTurn.source === turn.source;
    const sameSystemFamily =
      isSystemTranscriptTurn(pendingTurn) && isSystemTranscriptTurn(turn);
    const sameMicFamily =
      isMicTranscriptTurn(pendingTurn) && isMicTranscriptTurn(turn);

    if (sameSpeaker || sameSource || sameSystemFamily || sameMicFamily) {
      delete next[speaker];
      changed = true;
    }
  }

  return changed ? next : pending;
};

const shouldShowPendingTranscriptTurn = (turn: LiveTranscriptTurn) => {
  if (turn.final) return true;
  if (!isMicTranscriptTurn(turn)) return true;

  const flags = new Set(turn.qualityFlags || []);
  return !(
    flags.has("possible_overlap") ||
    flags.has("mic_gate_held") ||
    flags.has("echo_suspect")
  );
};

const NativelyInterface: React.FC<NativelyInterfaceProps> = ({
  onEndMeeting,
  overlayOpacity = OVERLAY_OPACITY_DEFAULT,
}) => {
  const isLightTheme = useResolvedTheme() === "light";
  const [isExpanded, setIsExpanded] = useState(true);
  const preferredOverlayHeight = useMemo(
    () => getPreferredOverlayHeight(isExpanded),
    [isExpanded],
  );
  const [inputValue, setInputValue] = useState("");
  const { shortcuts, isShortcutPressed } = useShortcuts();
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [copilotSuggestion, setCopilotSuggestion] =
    useState<CopilotSuggestion | null>(null);
  const [copilotStatus, setCopilotStatus] =
    useState<CopilotDecisionPayload | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [sttUserStatus, setSttUserStatus] = useState<
    "connected" | "reconnecting" | "failed"
  >("connected");
  const [sttUserError, setSttUserError] = useState<string>("");
  const [sttUserProvider, setSttUserProvider] = useState<string>("");
  const [sttInterviewerStatus, setSttInterviewerStatus] = useState<
    "connected" | "reconnecting" | "failed"
  >("connected");
  const [sttInterviewerError, setSttInterviewerError] = useState<string>("");
  const [sttInterviewerProvider, setSttInterviewerProvider] =
    useState<string>("");
  const [pendingCount, setPendingCount] = useState(0);
  const incrementPending = () => setPendingCount((c) => c + 1);
  const decrementPending = () => setPendingCount((c) => Math.max(0, c - 1));
  const isProcessing = pendingCount > 0;
  const activeAgenticRunRef = useRef<AgenticRunState | null>(null);
  const geminiStreamBufferRef = useRef("");
  const [isAgenticModeEnabled, setIsAgenticModeEnabled] = useState(() => {
    return localStorage.getItem(AGENTIC_MODE_STORAGE_KEY) !== "false";
  });
  const [isSpeakerSeparationEnabled, setIsSpeakerSeparationEnabled] = useState(() => {
    return localStorage.getItem(SPEAKER_SEPARATION_STORAGE_KEY) !== "false";
  });
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const activeActionIdsRef = useRef<Record<string, string>>({});
  const streamStartTimesRef = useRef<Record<string, number>>({});
  const actionModelIdsRef = useRef<Record<string, string>>({});
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [conversationContext, setConversationContext] = useState<string>("");
  const [isManualRecording, setIsManualRecording] = useState(false);
  const isRecordingRef = useRef(false); // Ref to track recording state (avoids stale closure)
  const [manualTranscript, setManualTranscript] = useState("");
  const manualTranscriptRef = useRef<string>("");
  const [showTranscript, setShowTranscript] = useState(() => {
    const stored = localStorage.getItem("natively_interviewer_transcript");
    return stored !== "false";
  });

  // Analytics State
  const requestStartTimeRef = useRef<number | null>(null);

  // Sync transcript setting
  useEffect(() => {
    const handleStorage = () => {
      const stored = localStorage.getItem("natively_interviewer_transcript");
      setShowTranscript(stored !== "false");
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const [rollingTranscript, setRollingTranscript] = useState(""); // For interviewer rolling text bar
  const [liveTranscriptTurns, setLiveTranscriptTurns] = useState<
    LiveTranscriptTurn[]
  >([]);
  const [copyTranscriptTurns, setCopyTranscriptTurns] = useState<
    LiveTranscriptTurn[]
  >([]);
  const [pendingLiveTranscript, setPendingLiveTranscript] = useState<
    Partial<Record<LiveTranscriptTurn["speaker"], LiveTranscriptTurn>>
  >({});
  const [copiedTranscriptId, setCopiedTranscriptId] = useState<string | null>(
    null,
  );
  const [isTranscriptExpanded, setIsTranscriptExpanded] = useState(false);
  const [isCommandToolsOpen, setIsCommandToolsOpen] = useState(false);
  const [transcriptPage, setTranscriptPage] = useState(0);
  const [isInterviewerSpeaking, setIsInterviewerSpeaking] = useState(false); // Track if actively speaking
  const [voiceInput, setVoiceInput] = useState(""); // Accumulated user voice input
  const voiceInputRef = useRef<string>(""); // Ref for capturing in async handlers
  const textInputRef = useRef<HTMLInputElement>(null); // Ref for input focus
  const isStealthRef = useRef<boolean>(false); // Tracks if the next expansion should be stealthy
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const liveTranscriptScrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Captures data from onCaptureAndProcess before the React state flush so
  // handleWhatToSay() can access it even in React 18 concurrent mode (where
  // a plain setTimeout(0) may fire before setAttachedContext flushes).
  const pendingCaptureRef = useRef<{ path: string; preview: string } | null>(
    null,
  );

  const pushOverlayDimensions = useCallback(() => {
    if (!contentRef.current) return;

    const rect = contentRef.current.getBoundingClientRect();
    const measuredWidth = Math.ceil(rect.width);

    window.electronAPI?.updateContentDimensions({
      width: Math.max(measuredWidth, OVERLAY_PANEL_WIDTH),
      height: preferredOverlayHeight,
    });
  }, [preferredOverlayHeight]);

  const scrollMessagesToBottom = (
    behavior: ScrollBehavior = "smooth",
    force = true,
  ) => {
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      if (!force) {
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom > 180) return;
      }
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });
    });
  };

  const queueActionMessage = (intent: string, text: string, loadingKey?: string): string => {
    const actionId = createLiveActionId();
    streamStartTimesRef.current[actionId] = Date.now();
    actionModelIdsRef.current[actionId] = currentModelRef.current;
    if (loadingKey) {
      activeActionIdsRef.current[loadingKey] = actionId;
      setActionLoading((prev) => ({ ...prev, [loadingKey]: true }));
    }
    setMessages((prev) => upsertPendingActionMessage(prev, actionId, intent, text));
    scrollMessagesToBottom("smooth");
    return actionId;
  };

  const finishActionLoading = (loadingKey: string, actionId?: string) => {
    if (actionId && activeActionIdsRef.current[loadingKey] !== actionId) return;
    delete activeActionIdsRef.current[loadingKey];
    setActionLoading((prev) => ({ ...prev, [loadingKey]: false }));
  };

  // Latent Context State (Screenshots attached but not sent)
  const [attachedContext, setAttachedContext] = useState<
    Array<{ path: string; preview: string }>
  >([]);

  // Settings State with Persistence
  const [isUndetectable, setIsUndetectable] = useState(false);
  const [hideChatHidesWidget, setHideChatHidesWidget] = useState(() => {
    const stored = localStorage.getItem("natively_hideChatHidesWidget");
    return stored ? stored === "true" : true;
  });

  // Active mode name (shown as a badge near the Modes button)
  const [activeModeLabel, setActiveModeLabel] = useState<string | null>(null);
  const [availableModes, setAvailableModes] = useState<
    Array<{ id: string; name: string; templateType: string }>
  >([]);
  const [isModeOpen, setIsModeOpen] = useState(false);
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [aiLang, setAiLang] = useState<string>("auto");
  const modeRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);

  // Active project context (orthogonal to mode). Selecting a project
  // makes its metadata (stack, description, topics) available to the LLM.
  const { active: activeProject, setActive: setActiveProject } = useProjectContext();
  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);

  useEffect(() => {
    // Load initial active mode name
    window.electronAPI
      ?.modesGetActive?.()
      .then((mode: { name: string } | null) =>
        setActiveModeLabel(mode?.name ?? null),
      )
      .catch(() => {});
    window.electronAPI
      ?.modesGetAll?.()
      .then((list) => setAvailableModes(list))
      .catch(() => {});
    // AI response language
    window.electronAPI
      ?.getAiResponseLanguage?.()
      .then((r: any) => {
        const language = typeof r === "string" ? r : r?.language;
        if (language) setAiLang(language);
      })
      .catch(() => {});
    // Live-update whenever mode is activated/deactivated
    const unsub = window.electronAPI?.onModeChanged?.(
      (data: { id: string | null; name: string | null }) => {
        setActiveModeLabel(data.name);
      },
    );
    return () => unsub?.();
  }, []);

  // Close mode/lang dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node))
        setIsModeOpen(false);
      if (langRef.current && !langRef.current.contains(e.target as Node))
        setIsLangOpen(false);
    };
    if (isModeOpen || isLangOpen)
      document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isModeOpen, isLangOpen]);

  // Model Selection State
  const [currentModel, setCurrentModel] = useState<string>(
    "gemini-3-flash-preview",
  );
  const currentModelRef = useRef(currentModel);
  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);

  const getActionMessageMeta = (
    actionId: string,
    data?: unknown,
  ): Pick<LiveActionMessageMeta, "modelUsed" | "serviceTierUsed" | "serviceTierFallback"> =>
    getServiceTierMessageMeta(
      data,
      actionModelIdsRef.current[actionId] || currentModelRef.current,
    );

  // Dynamic Action Button Mode (Recap vs Brainstorm)
  const [actionButtonMode, setActionButtonMode] = useState<
    "recap" | "brainstorm"
  >("recap");

  useEffect(() => {
    // Load persisted mode
    window.electronAPI
      ?.getActionButtonMode?.()
      ?.then((mode: "recap" | "brainstorm") => {
        if (mode) setActionButtonMode(mode);
      })
      .catch(() => {});

    // Listen for live changes from SettingsPopup / IPC
    const unsubscribe = window.electronAPI?.onActionButtonModeChanged?.(
      (mode: "recap" | "brainstorm") => {
        setActionButtonMode(mode);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, []);

  const codeTheme = isLightTheme ? oneLight : vscDarkPlus;
  const codeLineNumberColor = isLightTheme
    ? "rgba(15,23,42,0.35)"
    : "rgba(255,255,255,0.2)";
  const appearance = useMemo(
    () => getOverlayAppearance(overlayOpacity, isLightTheme ? "light" : "dark"),
    [overlayOpacity, isLightTheme],
  );
  const overlayPanelClass = "overlay-text-primary";
  const subtleSurfaceClass = "overlay-subtle-surface";
  const codeBlockClass = "overlay-code-block-surface";
  const codeHeaderClass = "overlay-code-header-surface";
  const codeHeaderTextClass = "overlay-text-muted";
  const quickActionClass = "overlay-chip-surface overlay-text-interactive";
  const inputClass = `${isLightTheme ? "focus:ring-black/10" : "focus:ring-white/10"} overlay-input-surface overlay-input-text`;
  const controlSurfaceClass =
    "overlay-control-surface overlay-text-interactive";
  const visibleCopilotDecision = copilotSuggestion ?? copilotStatus;
  const copilotQuality = visibleCopilotDecision?.contextQuality ?? null;
  const copilotQualityScore = copilotQuality
    ? Math.round(copilotQuality.score * 100)
    : 0;
  const isConversationFocusMode =
    messages.length > 0 ||
    isManualRecording ||
    isProcessing;
  const hasActionConversation =
    isConversationFocusMode ||
    Boolean(copilotSuggestion);
  const topSectionMaxHeight = isConversationFocusMode
    ? "min(12vh, 96px)"
    : copilotSuggestion
      ? "min(15vh, 144px)"
    : "min(30vh, 260px)";

  useEffect(() => {
    if (!isConversationFocusMode && isCommandToolsOpen) {
      setIsCommandToolsOpen(false);
    }
  }, [isConversationFocusMode, isCommandToolsOpen]);

  useEffect(() => {
    localStorage.setItem(
      AGENTIC_MODE_STORAGE_KEY,
      String(isAgenticModeEnabled),
    );
  }, [isAgenticModeEnabled]);

  useEffect(() => {
    localStorage.setItem(
      SPEAKER_SEPARATION_STORAGE_KEY,
      String(isSpeakerSeparationEnabled),
    );
  }, [isSpeakerSeparationEnabled]);

  useEffect(() => {
    let mounted = true;
    window.electronAPI
      ?.getSpeakerSeparationEnabled?.()
      .then((result) => {
        if (!mounted || typeof result?.enabled !== "boolean") return;
        setIsSpeakerSeparationEnabled(result.enabled);
      })
      .catch(() => {});

    const unsubscribe = window.electronAPI?.onSpeakerSeparationChanged?.(
      (data: { enabled: boolean }) => {
        setIsSpeakerSeparationEnabled(data.enabled === true);
      },
    );

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    // Load the persisted default model (not the runtime model)
    // Each new meeting starts with the default from settings
    if (window.electronAPI?.getDefaultModel) {
      window.electronAPI
        .getDefaultModel()
        .then((result: any) => {
          if (result && result.model) {
            setCurrentModel(result.model);
            // Also set the runtime model to the default
            window.electronAPI.setModel(result.model).catch(() => {});
          }
        })
        .catch((err: any) =>
          console.error("Failed to fetch default model:", err),
        );
    }
  }, []);

  const handleModelSelect = (modelId: string) => {
    setCurrentModel(modelId);
    // Session-only: update runtime but don't persist as default
    window.electronAPI
      .setModel(modelId)
      .catch((err: any) => console.error("Failed to set model:", err));
  };

  const handleCopilotFeedback = (rating: CopilotFeedbackRating) => {
    const current = copilotSuggestion;
    if (!current) return;

    setCopilotSuggestion(null);
    window.electronAPI
      ?.submitCopilotFeedback?.({
        decisionId: current.id,
        rating,
        mode: current.mode,
      })
      .catch((err: any) =>
        console.warn("[Copilot] Failed to submit feedback:", err),
      );
  };

  // Listen for default model changes from Settings
  useEffect(() => {
    if (!window.electronAPI?.onModelChanged) return;
    const unsubscribe = window.electronAPI.onModelChanged((modelId: string) => {
      setCurrentModel((prev) => (prev === modelId ? prev : modelId));
    });
    return () => unsubscribe();
  }, []);

  // Global State Sync
  useEffect(() => {
    // Fetch initial state
    if (window.electronAPI?.getUndetectable) {
      window.electronAPI.getUndetectable().then(setIsUndetectable);
    }

    if (window.electronAPI?.onUndetectableChanged) {
      const unsubscribe = window.electronAPI.onUndetectableChanged((state) => {
        setIsUndetectable(state);
      });
      return () => unsubscribe();
    }
  }, []);

  // Persist Settings
  useEffect(() => {
    localStorage.setItem("natively_undetectable", String(isUndetectable));
    localStorage.setItem(
      "natively_hideChatHidesWidget",
      String(hideChatHidesWidget),
    );
  }, [isUndetectable, hideChatHidesWidget]);

  // Mouse Passthrough State
  const [isMousePassthrough, setIsMousePassthrough] = useState(false);
  useEffect(() => {
    window.electronAPI
      ?.getOverlayMousePassthrough?.()
      .then(setIsMousePassthrough)
      .catch(() => {});
    const unsub = window.electronAPI?.onOverlayMousePassthroughChanged?.((v) =>
      setIsMousePassthrough(v),
    );
    return () => unsub?.();
  }, []);

  // Screen Recording Permission Warning Banner
  const [systemAudioWarning, setSystemAudioWarning] = useState<string | null>(
    null,
  );
  const [systemAudioWarningTitle, setSystemAudioWarningTitle] = useState(
    "Speaker Capture Warning",
  );
  useEffect(() => {
    const unsubPermission = window.electronAPI?.onSystemAudioPermissionDenied?.(
      (message: string) => {
        setSystemAudioWarningTitle("Screen Recording Permission Denied");
        setSystemAudioWarning(message);
        setIsExpanded(true); // Force overlay open so user sees the warning
      },
    );
    const unsubSilent = window.electronAPI?.onSystemAudioSilent?.(() => {
      setSystemAudioWarningTitle("Speaker Audio Is Silent");
      setSystemAudioWarning(
        "System audio is silent. Other participants will not be captured until macOS Screen/System Audio Recording permission and the output device are working.",
      );
      setIsExpanded(true);
    });
    const unsubActive = window.electronAPI?.onSystemAudioActive?.(() => {
      setSystemAudioWarningTitle("Speaker Capture Warning");
      setSystemAudioWarning(null);
    });
    return () => {
      unsubPermission?.();
      unsubSilent?.();
      unsubActive?.();
    };
  }, []);

  // PR #173: STT not configured warning — shown when provider is 'none' during a meeting
  const [sttNotConfigured, setSttNotConfigured] = useState(false);
  useEffect(() => {
    let mounted = true;
    // Check current STT config on mount
    window.electronAPI
      ?.getSttProvider?.()
      .then((provider: string) => {
        if (mounted) setSttNotConfigured(provider === "none");
      })
      .catch(() => {});

    // Listen for live config changes (e.g. user saves a key in Settings while meeting is active)
    const unsub = window.electronAPI?.onSttConfigChanged?.(
      (data: { configured: boolean; provider: string }) => {
        if (mounted) setSttNotConfigured(!data.configured);
      },
    );
    return () => {
      mounted = false;
      unsub?.();
    };
  }, []);

  // Auto-resize Window
  useLayoutEffect(() => {
    if (!contentRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use getBoundingClientRect to get the exact rendered size including padding
        const rect = entry.target.getBoundingClientRect();
        const height = preferredOverlayHeight;

        // Send exact dimensions to Electron
        console.log(
          "[NativelyInterface] ResizeObserver:",
          Math.ceil(rect.width),
          height,
        );
        window.electronAPI?.updateContentDimensions({
          width: Math.max(Math.ceil(rect.width), OVERLAY_PANEL_WIDTH),
          height,
        });
      }
    });

    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [preferredOverlayHeight]);

  // Force resize when attachedContext changes (screenshots added/removed)
  useEffect(() => {
    // Let the DOM settle, then measure and push new dimensions
    requestAnimationFrame(pushOverlayDimensions);
  }, [
    attachedContext,
    copilotSuggestion,
    isTranscriptExpanded,
    liveTranscriptTurns.length,
    messages.length,
    pendingLiveTranscript,
    pushOverlayDimensions,
    showTranscript,
  ]);

  // Force initial sizing safety check
  useEffect(() => {
    const timer = setTimeout(() => {
      pushOverlayDimensions();
    }, 600);
    return () => clearTimeout(timer);
  }, [pushOverlayDimensions]);

  // Build conversation context from messages
  useEffect(() => {
    const context = messages
      .filter((m) => m.role !== "user" || !m.hasScreenshot)
      .map(
        (m) =>
          `${m.role === "interviewer" ? "Interviewer" : m.role === "user" ? "User" : "Assistant"}: ${m.text}`,
      )
      .slice(-20)
      .join("\n");
    setConversationContext(context);
  }, [messages]);

  // Listen for settings window visibility changes
  useEffect(() => {
    if (!window.electronAPI?.onSettingsVisibilityChange) return;
    const unsubscribe = window.electronAPI.onSettingsVisibilityChange(
      (isVisible) => {
        setIsSettingsOpen(isVisible);
      },
    );
    return () => unsubscribe();
  }, []);

  // Sync Window Visibility with Expanded State
  useEffect(() => {
    if (isExpanded) {
      window.electronAPI.showWindow(isStealthRef.current);
      isStealthRef.current = false; // Reset back to default
    } else {
      // Slight delay to allow animation to clean up if needed, though immediate is safer for click-through
      // Using setTimeout to ensure the render cycle completes first
      // Increased to 400ms to allow "contract to bottom" exit animation to finish
      setTimeout(() => window.electronAPI.hideWindow(), 400);
    }
  }, [isExpanded]);

  // Keyboard shortcut to toggle expanded state (via Main Process)
  useEffect(() => {
    if (!window.electronAPI?.onToggleExpand) return;
    const unsubscribe = window.electronAPI.onToggleExpand(() => {
      setIsExpanded((prev) => !prev);
    });
    return () => unsubscribe();
  }, []);

  // Ensure overlay is expanded when requested by main process (e.g. after switching to overlay mode).
  // IMPORTANT: set isStealthRef before setIsExpanded so that if isExpanded was false, the
  // isExpanded effect fires showWindow(true) instead of showWindow(false). Without this,
  // ensure-expanded on a collapsed overlay would trigger show()+focus(), breaking stealth.
  useEffect(() => {
    if (!window.electronAPI?.onEnsureExpanded) return;
    const unsubscribe = window.electronAPI.onEnsureExpanded(() => {
      isStealthRef.current = true;
      setIsExpanded(true);
    });
    return () => unsubscribe();
  }, []);

  // Session Reset Listener - Clears UI when a NEW meeting starts
  useEffect(() => {
    if (!window.electronAPI?.onSessionReset) return;
    const unsubscribe = window.electronAPI.onSessionReset(() => {
      console.log("[NativelyInterface] Resetting session state...");
      setMessages([]);
      setInputValue("");
      setAttachedContext([]);
      setCopilotSuggestion(null);
      setManualTranscript("");
      setLiveTranscriptTurns([]);
      setCopyTranscriptTurns([]);
      setPendingLiveTranscript({});
      setIsTranscriptExpanded(false);
      setTranscriptPage(0);
      setRollingTranscript("");
      setVoiceInput("");
      setSttUserStatus("connected");
      setSttUserError("");
      setSttInterviewerStatus("connected");
      setSttInterviewerError("");
      decrementPending();
      // Optionally reset connection status if needed, but connection persists

      // Track new conversation/session if applicable?
      // Actually 'app_opened' is global, 'assistant_started' is overlay.
      // Maybe 'conversation_started' event?
      analytics.trackConversationStarted();
    });
    return () => unsubscribe();
  }, []);

  const handleScreenshotAttach = (data: { path: string; preview: string }) => {
    setIsExpanded(true);
    setAttachedContext((prev) => {
      // Prevent duplicates and cap at 5
      if (prev.some((s) => s.path === data.path)) return prev;
      const updated = [...prev, data];
      return updated.slice(-5); // Keep last 5
    });
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
    });
  };

  const recordLiveTranscript = (transcript: {
    speaker: string;
    text: string;
    final: boolean;
    canonicalRole?: string;
    source?: "mic" | "system" | "merged";
    qualityFlags?: string[];
    rawSpeaker?: string;
  }) => {
    const text = transcript.text?.trim();
    if (!text) return;

    // A stale hidden-transcript preference can make live STT look broken while
    // final persistence still works. Any incoming segment should surface the
    // live panel again so the user can verify capture in real time.
    setShowTranscript(true);
    localStorage.setItem("natively_interviewer_transcript", "true");

    const speaker = normalizeLiveSpeaker(transcript.speaker, transcript.canonicalRole);
    const timestamp = Date.now();
    const turn: LiveTranscriptTurn = {
      id: `${transcript.final ? "final" : "partial"}-${speaker}-${timestamp}-${Math.random().toString(16).slice(2)}`,
      speaker,
      text,
      final: transcript.final,
      timestamp,
      canonicalRole: transcript.canonicalRole,
      source: transcript.source,
      qualityFlags: transcript.qualityFlags,
      rawSpeaker: transcript.rawSpeaker,
    };

    if (!transcript.final) {
      if (!shouldShowPendingTranscriptTurn(turn)) {
        setPendingLiveTranscript((prev) =>
          clearPendingTranscriptForTurn(prev, turn),
        );
        return;
      }

      setPendingLiveTranscript((prev) => ({
        ...prev,
        [speaker]: {
          id: `pending-${speaker}`,
          speaker,
          text,
          final: false,
          timestamp,
          canonicalRole: transcript.canonicalRole,
          source: transcript.source,
          qualityFlags: transcript.qualityFlags,
          rawSpeaker: transcript.rawSpeaker,
        },
      }));
      return;
    }

    setPendingLiveTranscript((prev) => clearPendingTranscriptForTurn(prev, turn));

    setLiveTranscriptTurns((prev) =>
      upsertTranscriptTurn(prev, turn, MAX_LIVE_TRANSCRIPT_TURNS),
    );
    setCopyTranscriptTurns((prev) =>
      upsertTranscriptTurn(prev, turn, MAX_COPY_TRANSCRIPT_TURNS),
    );
  };

  useEffect(() => {
    if (transcriptPage !== 0) return;
    requestAnimationFrame(() => {
      const container = liveTranscriptScrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
  }, [liveTranscriptTurns, pendingLiveTranscript, transcriptPage]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const lastMessage = messages[messages.length - 1];
    const shouldKeepLatestVisible =
      lastMessage?.role === "user" ||
      lastMessage?.isStreaming ||
      Boolean(lastMessage?.intent);
    scrollMessagesToBottom(
      shouldKeepLatestVisible ? "auto" : "smooth",
      shouldKeepLatestVisible,
    );
  }, [messages]);

  // STT Status listener — must survive isExpanded changes.
  // If registered inside the [isExpanded] effect, events are dropped during cleanup.
  useEffect(() => {
    return window.electronAPI.onSttStatusChanged((data) => {
      if (data.channel === "user") {
        setSttUserStatus(data.state);
        setSttUserProvider(data.provider);
        if (data.error) setSttUserError(data.error);
        if (data.state === "connected") setSttUserError("");
      } else if (data.channel === "interviewer") {
        setSttInterviewerStatus(data.state);
        setSttInterviewerProvider(data.provider);
        if (data.error) setSttInterviewerError(data.error);
        if (data.state === "connected") setSttInterviewerError("");
      }
    });
  }, []);

  // Connect to Native Audio Backend
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Connection Status
    window.electronAPI
      .getNativeAudioStatus()
      .then((status) => {
        setIsConnected(status.connected);
      })
      .catch(() => setIsConnected(false));

    cleanups.push(
      window.electronAPI.onNativeAudioConnected(() => {
        setIsConnected(true);
      }),
    );
    cleanups.push(
      window.electronAPI.onNativeAudioDisconnected(() => {
        setIsConnected(false);
      }),
    );

    // Real-time Transcripts
    cleanups.push(
      window.electronAPI.onNativeAudioTranscript((transcript) => {
        recordLiveTranscript(transcript);

        // When Answer button is active, capture USER transcripts for voice input
        // Use ref to avoid stale closure issue
        const isLocalMicTranscript =
          transcript.canonicalRole === "me" ||
          transcript.source === "mic" ||
          transcript.speaker === "user" ||
          transcript.speaker === "me";

        if (isRecordingRef.current && isLocalMicTranscript) {
          if (transcript.final) {
            // Accumulate final transcripts
            setVoiceInput((prev) => {
              const updated = prev + (prev ? " " : "") + transcript.text;
              voiceInputRef.current = updated;
              return updated;
            });
            setManualTranscript(""); // Clear partial preview
            manualTranscriptRef.current = "";
          } else {
            // Show live partial transcript
            setManualTranscript(transcript.text);
            manualTranscriptRef.current = transcript.text;
          }
          return; // Don't add to messages while recording
        }

        // User mic transcripts are shown in the live transcript feed above.
        // They stay out of the chat unless the user is explicitly dictating an answer.
        if (isLocalMicTranscript) {
          return; // Skip user mic input - only relevant when Answer button is active
        }

        // Only show interviewer (system audio) transcripts in rolling bar
        if (isLocalMicTranscript) {
          return; // User mic is already visible in the live transcript panel.
        }

        // Route to rolling transcript bar - accumulate text continuously
        setIsInterviewerSpeaking(!transcript.final);

        if (transcript.final) {
          // Append finalized text to accumulated transcript
          setRollingTranscript((prev) => {
            const separator = prev ? "  ·  " : "";
            return prev + separator + transcript.text;
          });

          // Clear speaking indicator after pause
          setTimeout(() => {
            setIsInterviewerSpeaking(false);
          }, 3000);
        } else {
          // For partial transcripts, show current segment appended to accumulated
          setRollingTranscript((prev) => {
            // Find where previous finalized content ends (look for last separator)
            const lastSeparator = prev.lastIndexOf("  ·  ");
            const accumulated =
              lastSeparator >= 0 ? prev.substring(0, lastSeparator + 5) : "";
            return accumulated + transcript.text;
          });
        }
      }),
    );

    // AI Suggestions from native audio (legacy)
    cleanups.push(
      window.electronAPI.onSuggestionProcessingStart(() => {
        incrementPending();
        setIsExpanded(true);
      }),
    );

    cleanups.push(
      window.electronAPI.onSuggestionGenerated((data) => {
        decrementPending();
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "system",
            text: data.suggestion,
          },
        ]);
      }),
    );

    cleanups.push(
      window.electronAPI.onSuggestionError((err) => {
        decrementPending();
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "system",
            text: `Error: ${err.error}`,
          },
        ]);
      }),
    );

    const cleanupCopilotSuggestion = window.electronAPI.onCopilotSuggestion?.(
      (data) => {
        if (!data?.suggestion) return;
        setCopilotStatus(data);
        setCopilotSuggestion(data);
        setIsExpanded(true);
      },
    );
    if (cleanupCopilotSuggestion) cleanups.push(cleanupCopilotSuggestion);

    const cleanupCopilotDecision = window.electronAPI.onCopilotDecision?.(
      (data) => {
        if (!data) return;
        setCopilotStatus(data);
      },
    );
    if (cleanupCopilotDecision) cleanups.push(cleanupCopilotDecision);

    const cleanupCopilotError = window.electronAPI.onCopilotError?.((data) => {
      console.warn("[Copilot] Error:", data.error);
    });
    if (cleanupCopilotError) cleanups.push(cleanupCopilotError);

    cleanups.push(
      window.electronAPI.onIntelligenceSuggestedAnswerToken((data) => {
        const intent = getSuggestedAnswerIntent(data.question);
        const actionId = data.actionId || createLiveActionId();
        if (!streamStartTimesRef.current[actionId]) {
          streamStartTimesRef.current[actionId] = Date.now();
        }
        setMessages((prev) => appendStreamingMessage(prev, actionId, intent, data.token));
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceSuggestedAnswer((data) => {
        const intent = getSuggestedAnswerIntent(data.question);
        const actionId = data.actionId || createLiveActionId();
        const loadingKey = intent === "code_hint"
          ? "codeHint"
          : intent === "brainstorm"
            ? "brainstorm"
            : "whatToSay";
        finishActionLoading(loadingKey, actionId);
        const durationMs =
          Date.now() - (streamStartTimesRef.current[actionId] || Date.now());
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          finalizeStreamingMessage(prev, actionId, intent, data.answer, {
            tokensUsed: estimateTokens(data.answer),
            durationMs,
            ...getActionMessageMeta(actionId, data),
          }),
        );
      }),
    );

    // STREAMING: Refinement
    cleanups.push(
      window.electronAPI.onIntelligenceRefinedAnswerToken((data) => {
        const actionId = data.actionId || createLiveActionId();
        if (!streamStartTimesRef.current[actionId]) {
          streamStartTimesRef.current[actionId] = Date.now();
        }
        setMessages((prev) =>
          appendStreamingMessage(prev, actionId, data.intent, data.token),
        );
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceRefinedAnswer((data) => {
        const actionId = data.actionId || createLiveActionId();
        const durationMs =
          Date.now() - (streamStartTimesRef.current[actionId] || Date.now());
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          finalizeStreamingMessage(prev, actionId, data.intent, data.answer, {
            tokensUsed: estimateTokens(data.answer),
            durationMs,
            ...getActionMessageMeta(actionId, data),
          }),
        );
      }),
    );

    // STREAMING: Recap
    cleanups.push(
      window.electronAPI.onIntelligenceRecapToken((data) => {
        const actionId = data.actionId || createLiveActionId();
        if (!streamStartTimesRef.current[actionId]) {
          streamStartTimesRef.current[actionId] = Date.now();
        }
        setMessages((prev) =>
          appendStreamingMessage(prev, actionId, "recap", data.token),
        );
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceRecap((data) => {
        const actionId = data.actionId || createLiveActionId();
        finishActionLoading("recap", actionId);
        const durationMs =
          Date.now() - (streamStartTimesRef.current[actionId] || Date.now());
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          finalizeStreamingMessage(prev, actionId, "recap", data.summary, {
            tokensUsed: estimateTokens(data.summary),
            durationMs,
            ...getActionMessageMeta(actionId, data),
          }),
        );
      }),
    );

    // STREAMING: Follow-Up Questions (Rendered as message? Or specific UI?)
    // Currently interface typically renders follow-up Qs as a message or button update.
    // Let's assume message for now based on existing 'follow_up_questions_update' handling
    // But wait, existing handle just sets state?
    // Let's check how 'follow_up_questions_update' was handled.
    // It was handled separate locally in this component maybe?
    // Ah, I need to see the existing listener for 'onIntelligenceFollowUpQuestionsUpdate'

    // Let's implemented token streaming for it anyway, likely it updates a message bubble
    // OR it might update a specialized "Suggested Questions" area.
    // Assuming it's a message for consistency with "Copilot" approach.

    cleanups.push(
      window.electronAPI.onIntelligenceFollowUpQuestionsToken((data) => {
        const actionId = data.actionId || createLiveActionId();
        if (!streamStartTimesRef.current[actionId]) {
          streamStartTimesRef.current[actionId] = Date.now();
        }
        setMessages((prev) =>
          appendStreamingMessage(prev, actionId, "follow_up_questions", data.token),
        );
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceFollowUpQuestionsUpdate((data) => {
        const actionId = data.actionId || createLiveActionId();
        finishActionLoading("followUpQuestions", actionId);
        const text =
          typeof data.questions === "string"
            ? data.questions
            : JSON.stringify(data.questions);
        const durationMs =
          Date.now() -
          (streamStartTimesRef.current[actionId] || Date.now());
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          finalizeStreamingMessage(
            prev,
            actionId,
            "follow_up_questions",
            data.questions,
            {
              tokensUsed: estimateTokens(text),
              durationMs,
              ...getActionMessageMeta(actionId, data),
            },
          ),
        );
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceManualStarted(() => {
        actionModelIdsRef.current.manual = currentModelRef.current;
        streamStartTimesRef.current.manual = Date.now();
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceManualResult((data) => {
        decrementPending();
        const actionId = activeActionIdsRef.current.manual || "manual";
        const durationMs =
          Date.now() - (streamStartTimesRef.current[actionId] || Date.now());
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          settleActionMessage(prev, actionId, "manual", data.answer, {
            tokensUsed: estimateTokens(data.answer),
            durationMs,
            ...getActionMessageMeta(actionId, data),
          }),
        );
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceActionCancelled((data) => {
        const intent = getMessageIntentForMode(data.mode);
        const modeToKey: Record<string, string> = {
          what_to_say: "whatToSay",
          follow_up: "followUp",
          recap: "recap",
          clarify: "clarify",
          follow_up_questions: "followUpQuestions",
          code_hint: "codeHint",
          brainstorm: "brainstorm",
        };
        const loadingKey = modeToKey[data.mode];
        if (loadingKey) finishActionLoading(loadingKey, data.actionId);
        delete streamStartTimesRef.current[data.actionId];
        setMessages((prev) => cancelActionMessage(prev, data.actionId, intent));
      }),
    );

    cleanups.push(
      window.electronAPI.onIntelligenceError((data) => {
        // Only clear the loading state for the specific mode that failed
        const modeToKey: Record<string, string> = {
          what_to_say: 'whatToSay',
          follow_up: 'followUp',
          recap: 'recap',
          clarify: 'clarify',
          follow_up_questions: 'followUpQuestions',
          code_hint: 'codeHint',
          brainstorm: 'brainstorm',
          manual: 'manual',
          assist: 'assist',
        };
        const key = modeToKey[data.mode];
        if (key) {
          finishActionLoading(key, data.actionId);
        }
        const intent = getMessageIntentForMode(data.mode);
        const actionId = data.actionId || activeActionIdsRef.current[key || intent] || createLiveActionId();
        delete streamStartTimesRef.current[actionId];
        setMessages((prev) =>
          settleActionMessage(prev, actionId, intent, formatLiveActionError(data.error, data.mode), undefined, "failed"),
        );
      }),
    );
    return () => cleanups.forEach((fn) => fn());
    // These listeners must survive Hide/Show while an action is in flight.
    // Re-registering them on isExpanded changes can orphan final events and
    // leave buttons visually stuck even though the backend completed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable mount-only effect for screenshot listeners.
  // These MUST NOT be inside the [isExpanded] effect — when a screenshot is
  // taken, `switchToOverlay` fires `ensure-expanded` which can flip isExpanded
  // from false→true, triggering the [isExpanded] effect cleanup. If `screenshot-taken`
  // arrives during that teardown gap the event is silently dropped (same issue
  // as clarify streaming listeners below). handleScreenshotAttach only uses stable
  // useState setters so a mount-only closure is safe here.
  useEffect(() => {
    const cleanupTaken = window.electronAPI.onScreenshotTaken(
      handleScreenshotAttach,
    );
    const cleanupAttached = window.electronAPI.onScreenshotAttached?.(
      handleScreenshotAttach,
    );
    return () => {
      cleanupTaken?.();
      cleanupAttached?.();
    };
  }, []);

  // Stable mount-only effect for clarify streaming listeners.
  // These MUST NOT be inside the [isExpanded] effect — if the user
  // expands/collapses the panel while a clarify stream is in-flight,
  // the [isExpanded] effect would tear down and re-register listeners,
  // orphaning the final 'clarify' event and leaving isProcessing=true forever.
  useEffect(() => {
    const cleanupToken = window.electronAPI.onIntelligenceClarifyToken(
      (data) => {
        const actionId = data.actionId || createLiveActionId();
        if (!streamStartTimesRef.current[actionId]) {
          streamStartTimesRef.current[actionId] = Date.now();
        }
        setMessages((prev) =>
          appendStreamingMessage(prev, actionId, "clarify", data.token),
        );
      },
    );

    const cleanupFinal = window.electronAPI.onIntelligenceClarify((data) => {
      const actionId = data.actionId || createLiveActionId();
      finishActionLoading("clarify", actionId);
      const durationMs =
        Date.now() - (streamStartTimesRef.current[actionId] || Date.now());
      delete streamStartTimesRef.current[actionId];
      setMessages((prev) =>
        finalizeStreamingMessage(prev, actionId, "clarify", data.clarification, {
          tokensUsed: estimateTokens(data.clarification),
          durationMs,
          ...getActionMessageMeta(actionId, data),
        }),
      );
    });

    return () => {
      cleanupToken();
      cleanupFinal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — these listeners must survive isExpanded changes

  // Quick Actions - Updated to use new Intelligence APIs

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    analytics.trackCopyAnswer();
    // Optional: Trigger a small toast or state change for visual feedback
  };

  const handleWhatToSay = async () => {
    const intent = "what_to_answer";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Preparing what you can say...", "whatToSay");
    incrementPending();
    analytics.trackCommandExecuted("what_to_say");

    // Capture and clear attached image context.
    // Also merge in any screenshot from the capture-and-process shortcut that
    // arrived via pendingCaptureRef before the React state flush (React 18 fix).
    const pending = pendingCaptureRef.current;
    let currentAttachments = attachedContext;
    if (pending && !currentAttachments.some((s) => s.path === pending.path)) {
      currentAttachments = [...currentAttachments, pending].slice(-5);
    }

    if (currentAttachments.length > 0) {
      setAttachedContext([]);
      // Show the attached image in chat
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          text: "What should I say about this?",
          hasScreenshot: true,
          screenshotPreview: currentAttachments[0].preview,
        },
      ]);
      setTimeout(() => scrollMessagesToBottom("smooth"), 50);
    }

    try {
      // Pass imagePath if attached
      const result = await window.electronAPI.generateWhatToSay({
        actionId,
        imagePaths: currentAttachments.length > 0
          ? currentAttachments.map((s) => s.path)
          : undefined,
      });
      if (result?.error) throw new Error(result.error);
      const answer = result?.answer || "";
      if (answer) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, answer, {
            tokensUsed: estimateTokens(answer),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("whatToSay", actionId);
      decrementPending();
    }
  };

  const handleFollowUp = async (intent: string = "rephrase") => {
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Refining the previous answer...", "followUp");
    incrementPending();
    analytics.trackCommandExecuted("follow_up_" + intent);

    try {
      const result = await window.electronAPI.generateFollowUp({ actionId, intent });
      const refined = result?.refined || "";
      if (refined) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, refined, {
            tokensUsed: estimateTokens(refined),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) => settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"));
    } finally {
      finishActionLoading("followUp", actionId);
      decrementPending();
    }
  };

  const handleRecap = async () => {
    const intent = "recap";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Preparing a short recap...", "recap");
    incrementPending();
    analytics.trackCommandExecuted("recap");

    try {
      const result = await window.electronAPI.generateRecap({ actionId });
      const summary = result?.summary;
      if (summary) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, summary, {
            tokensUsed: estimateTokens(summary),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("recap", actionId);
      decrementPending();
    }
  };

  const handleFollowUpQuestions = async () => {
    const intent = "follow_up_questions";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Finding a useful follow-up question...", "followUpQuestions");
    incrementPending();
    analytics.trackCommandExecuted("suggest_questions");

    try {
      const result = await window.electronAPI.generateFollowUpQuestions({ actionId });
      const questions =
        typeof result?.questions === "string"
          ? result.questions
          : result?.questions
            ? JSON.stringify(result.questions)
            : "";
      if (questions) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, questions, {
            tokensUsed: estimateTokens(questions),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("followUpQuestions", actionId);
      decrementPending();
    }
  };

  const handleClarify = async () => {
    const intent = "clarify";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Preparing one clarifying question...", "clarify");
    incrementPending();
    analytics.trackCommandExecuted("clarify");

    try {
      const result = await window.electronAPI.generateClarify({ actionId });
      const clarification = result?.clarification || "";
      if (clarification) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, clarification, {
            tokensUsed: estimateTokens(clarification),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("clarify", actionId);
      decrementPending();
    }
  };

  const handleCodeHint = async () => {
    const intent = "code_hint";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Preparing a concise code hint...", "codeHint");
    incrementPending();
    analytics.trackCommandExecuted("code_hint");

    const currentAttachments = attachedContext;
    if (currentAttachments.length > 0) {
      setAttachedContext([]);
      // Show the attached image in chat
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          text: "Give me a code hint for this",
          hasScreenshot: true,
          screenshotPreview: currentAttachments[0].preview,
        },
      ]);
      setTimeout(() => scrollMessagesToBottom("smooth"), 50);
    }

    try {
      const result = await window.electronAPI.generateCodeHint({
        actionId,
        imagePaths: currentAttachments.length > 0
          ? currentAttachments.map((s) => s.path)
          : undefined,
      });
      const hint = result?.hint || "";
      if (hint) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, hint, {
            tokensUsed: estimateTokens(hint),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("codeHint", actionId);
      decrementPending();
    }
  };

  const handleBrainstorm = async () => {
    const intent = "brainstorm";
    setIsExpanded(true);
    const actionId = queueActionMessage(intent, "Preparing useful options...", "brainstorm");
    incrementPending();
    analytics.trackCommandExecuted("brainstorm");

    const currentAttachments = attachedContext;
    if (currentAttachments.length > 0) {
      setAttachedContext([]);
      // Show the attached image in chat
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          text: "Brainstorm with this context",
          hasScreenshot: true,
          screenshotPreview: currentAttachments[0].preview,
        },
      ]);
      setTimeout(() => scrollMessagesToBottom("smooth"), 50);
    }

    try {
      const result = await window.electronAPI.generateBrainstorm({
        actionId,
        imagePaths: currentAttachments.length > 0
          ? currentAttachments.map((s) => s.path)
          : undefined,
      });
      const script = result?.script || "";
      if (script) {
        setMessages((prev) =>
          finalizePendingActionMessage(prev, actionId, intent, script, {
            tokensUsed: estimateTokens(script),
            ...getActionMessageMeta(actionId, result),
          }),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        settleActionMessage(prev, actionId, intent, formatLiveActionError(err), undefined, "failed"),
      );
    } finally {
      finishActionLoading("brainstorm", actionId);
      decrementPending();
    }
  };

  // ── Mode & Language handlers ──
  const handleSetActiveMode = async (modeId: string | null) => {
    try {
      await window.electronAPI?.modesSetActive(modeId);
      setIsModeOpen(false);
    } catch (e) {
      console.error("Failed to set mode:", e);
    }
  };

  const handleSetLanguage = async (code: string) => {
    try {
      await window.electronAPI?.setAiResponseLanguage(code);
      setAiLang(code);
      setIsLangOpen(false);
    } catch (e) {
      console.error("Failed to set language:", e);
    }
  };

  const LANG_OPTIONS = [
    { code: "auto", label: "Auto" },
    { code: "English", label: "English" },
    { code: "French", label: "Français" },
    { code: "Spanish", label: "Español" },
    { code: "German", label: "Deutsch" },
    { code: "Chinese", label: "中文" },
    { code: "Japanese", label: "日本語" },
  ];

  // Setup Streaming Listeners
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Stream Token
    cleanups.push(
      window.electronAPI.onGeminiStreamToken((token) => {
        // Guard: if this token is the negotiation coaching JSON sentinel, accumulate it
        // silently. The JSON is always emitted as a single complete `yield JSON.stringify(...)`
        // call, so one parse attempt is sufficient. The onGeminiStreamDone handler will
        // detect the accumulated JSON and render the proper card UI — we just prevent the
        // raw JSON characters from ever appearing in the chat bubble.
        try {
          const parsed = JSON.parse(token);
          if (parsed?.__negotiationCoaching) {
            // Store the raw JSON text (Done handler needs it) but don't show it.
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.isStreaming && lastMsg.role === "system") {
                const updated = [...prev];
                updated[prev.length - 1] = { ...lastMsg, text: token };
                return updated;
              }
              return prev;
            });
            return; // Skip the normal append below
          }
        } catch {
          // Not JSON — normal text token, fall through to the standard append.
        }

        geminiStreamBufferRef.current += token;

        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.isStreaming && lastMsg.role === "system") {
            const updated = [...prev];
            updated[prev.length - 1] = {
              ...lastMsg,
              text: lastMsg.text + token,
              // re-check code status on every token? Expensive but needed for progressive highlighting
              isCode:
                (lastMsg.text + token).includes("```") ||
                (lastMsg.text + token).includes("def ") ||
                (lastMsg.text + token).includes("function "),
            };
            return updated;
          }
          return prev;
        });
      }),
    );

    // Stream Done
    cleanups.push(
      window.electronAPI.onGeminiStreamDone(() => {
        decrementPending();

        // Calculate latency if we have a start time
        let latency = 0;
        if (requestStartTimeRef.current) {
          latency = Date.now() - requestStartTimeRef.current;
          requestStartTimeRef.current = null;
        }

        // Track Usage
        analytics.trackModelUsed({
          model_name: currentModel,
          provider_type: detectProviderType(currentModel),
          latency_ms: latency,
        });

        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.isStreaming && lastMsg.role === "system") {
            // Detect negotiation coaching response
            try {
              const parsed = JSON.parse(lastMsg.text);
              if (parsed?.__negotiationCoaching) {
                const coaching = parsed.__negotiationCoaching;
                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMsg,
                    isStreaming: false,
                    isNegotiationCoaching: true,
                    negotiationCoachingData: coaching,
                    text: "",
                    modelUsed: shortenModelName(currentModel),
                    tokensUsed: 0,
                    durationMs: latency,
                  },
                ];
              }
            } catch {}
            // Normal completion — attach metadata
            return [
              ...prev.slice(0, -1),
              {
                ...lastMsg,
                isStreaming: false,
                modelUsed: shortenModelName(currentModel),
                tokensUsed: estimateTokens(lastMsg.text),
                durationMs: latency,
              },
            ];
          }
          return prev;
        });
      }),
    );

    // Stream Error
    cleanups.push(
      window.electronAPI.onGeminiStreamError((error) => {
        decrementPending();
        requestStartTimeRef.current = null; // Clear timer on error
        setMessages((prev) => {
          // Append error to the current message or add new one?
          // Let's add a new error block if the previous one confusing,
          // or just update status.
          // Ideally we want to show the partial response AND the error.
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.isStreaming) {
            const updated = [...prev];
            updated[prev.length - 1] = {
              ...lastMsg,
              isStreaming: false,
              text: lastMsg.text + `\n\n[Error: ${error}]`,
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: Date.now().toString(),
              role: "system",
              text: `❌ Error: ${error}`,
            },
          ];
        });
      }),
    );

    // JIT RAG Stream listeners (for live meeting RAG responses)
    if (window.electronAPI.onRAGStreamChunk) {
      cleanups.push(
        window.electronAPI.onRAGStreamChunk((data: { chunk: string }) => {
          // Same guard as onGeminiStreamToken: suppress raw JSON if this chunk is
          // the negotiation coaching sentinel. The onRAGStreamComplete handler will
          // convert it to the proper card UI.
          try {
            const parsed = JSON.parse(data.chunk);
            if (parsed?.__negotiationCoaching) {
              setMessages((prev) => {
                const lastMsg = prev[prev.length - 1];
                if (
                  lastMsg &&
                  lastMsg.isStreaming &&
                  lastMsg.role === "system"
                ) {
                  const updated = [...prev];
                  updated[prev.length - 1] = { ...lastMsg, text: data.chunk };
                  return updated;
                }
                return prev;
              });
              return; // Skip normal append
            }
          } catch {
            // Normal text chunk — fall through.
          }

          setMessages((prev) => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.isStreaming && lastMsg.role === "system") {
              const updated = [...prev];
              updated[prev.length - 1] = {
                ...lastMsg,
                text: lastMsg.text + data.chunk,
                isCode: (lastMsg.text + data.chunk).includes("```"),
              };
              return updated;
            }
            return prev;
          });
        }),
      );
    }

    if (window.electronAPI.onRAGStreamComplete) {
      cleanups.push(
        window.electronAPI.onRAGStreamComplete(() => {
          decrementPending();
          requestStartTimeRef.current = null;
          setMessages((prev) => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.isStreaming && lastMsg.role === "system") {
              // Detect negotiation coaching response
              try {
                const parsed = JSON.parse(lastMsg.text);
                if (parsed?.__negotiationCoaching) {
                  const coaching = parsed.__negotiationCoaching;
                  return [
                    ...prev.slice(0, -1),
                    {
                      ...lastMsg,
                      isStreaming: false,
                      isNegotiationCoaching: true,
                      negotiationCoachingData: coaching,
                      text: "",
                    },
                  ];
                }
              } catch {}
              // Normal completion
              return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
            }
            if (lastMsg && lastMsg.isStreaming) {
              const updated = [...prev];
              updated[prev.length - 1] = { ...lastMsg, isStreaming: false };
              return updated;
            }
            return prev;
          });
        }),
      );
    }

    if (window.electronAPI.onRAGStreamError) {
      cleanups.push(
        window.electronAPI.onRAGStreamError((data: { error: string }) => {
          decrementPending();
          requestStartTimeRef.current = null;
          setMessages((prev) => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.isStreaming) {
              const updated = [...prev];
              updated[prev.length - 1] = {
                ...lastMsg,
                isStreaming: false,
                text: lastMsg.text + `\n\n[RAG Error: ${data.error}]`,
              };
              return updated;
            }
            return prev;
          });
        }),
      );
    }

    return () => cleanups.forEach((fn) => fn());
  }, [currentModel]); // Ensure tracking captures correct model

  const cancelActiveWork = async () => {
    const activeRun = activeAgenticRunRef.current;
    if (activeRun) {
      activeRun.cancelled = true;
    }

    setPendingCount(0);
    setActionLoading({});
    activeActionIdsRef.current = {};
    requestStartTimeRef.current = null;
    streamStartTimesRef.current = {};
    actionModelIdsRef.current = {};
    geminiStreamBufferRef.current = "";

    try {
      await window.electronAPI.cancelGeminiStream?.();
    } catch (err) {
      console.warn("[NativelyInterface] Failed to cancel Gemini stream:", err);
    }

    try {
      await window.electronAPI.resetIntelligence?.();
    } catch (err) {
      console.warn("[NativelyInterface] Failed to reset intelligence:", err);
    }

    setMessages((prev) => {
      let changed = false;
      const stopped = prev.map((msg) => {
        if (!msg.isStreaming) return msg;
        changed = true;
        const existing = msg.text.trim();
        return {
          ...msg,
          isStreaming: false,
          text: existing ? `${existing}\n\nStopped.` : "Stopped.",
        };
      });
      return changed ? stopped : prev;
    });
  };

  const handleAgenticModeToggle = async () => {
    const nextEnabled = !isAgenticModeEnabled;
    setIsAgenticModeEnabled(nextEnabled);

    if (!nextEnabled && isProcessing) {
      await cancelActiveWork();
    }
  };

  const handleSpeakerSeparationToggle = async () => {
    const nextEnabled = !isSpeakerSeparationEnabled;
    setIsSpeakerSeparationEnabled(nextEnabled);
    localStorage.setItem(SPEAKER_SEPARATION_STORAGE_KEY, String(nextEnabled));

    try {
      const result = await window.electronAPI?.setSpeakerSeparationEnabled?.(
        nextEnabled,
      );
      if (typeof result?.enabled === "boolean") {
        setIsSpeakerSeparationEnabled(result.enabled);
      }
    } catch (err) {
      console.warn("[NativelyInterface] Failed to toggle speaker separation:", err);
      const rollback = !nextEnabled;
      setIsSpeakerSeparationEnabled(rollback);
      localStorage.setItem(SPEAKER_SEPARATION_STORAGE_KEY, String(rollback));
    }
  };

  const runAgenticResponse = async ({
    question,
    imagePaths,
    baseContext,
    historyMessages,
    source,
  }: AgenticAnswerRequest) => {
    const normalizedQuestion =
      question.trim() || (imagePaths?.length ? "Analyze this screenshot" : "");
    if (!normalizedQuestion) return;

    const run: AgenticRunState = {
      id: Date.now(),
      cancelled: false,
      maxPasses: isAgenticModeEnabled ? AGENTIC_MAX_PASSES : 1,
    };
    activeAgenticRunRef.current = run;

    let previousAnswer = "";
    const conversationMemory = buildAgenticConversationMemory(
      historyMessages ?? messagesRef.current,
    );

    for (let pass = 1; pass <= run.maxPasses; pass += 1) {
      if (run.cancelled || activeAgenticRunRef.current?.id !== run.id) break;
      if (pass > 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, AGENTIC_PASS_DELAY_MS),
        );
      }
      if (run.cancelled || activeAgenticRunRef.current?.id !== run.id) break;

      let liveContext = "";
      try {
        const contextResult = await window.electronAPI.getIntelligenceContext?.();
        liveContext = contextResult?.context || "";
      } catch (err) {
        console.warn("[NativelyInterface] Failed to refresh live context:", err);
      }

      const context = buildAgenticAnswerContext({
        source,
        question: normalizedQuestion,
        baseContext,
        liveContext,
        conversationMemory,
        previousAnswer,
        pass,
        maxPasses: run.maxPasses,
        hasImages: Boolean(imagePaths?.length),
        selectedModel: currentModelRef.current,
      });

      const streamMessage =
        pass === 1
          ? normalizedQuestion
          : `Refine the answer to this live question without repeating yourself: ${normalizedQuestion}`;

      geminiStreamBufferRef.current = "";
      requestStartTimeRef.current = Date.now();
      incrementPending();

      setMessages((prev) => [
        ...prev,
        {
          id: `${run.id}-${pass}`,
          role: "system",
          text: "",
          isStreaming: true,
          intent: "agentic",
          agenticRunId: run.id,
          agenticPass: pass,
        },
      ]);

      try {
        await window.electronAPI.streamGeminiChat(
          streamMessage,
          imagePaths,
          context,
          pass > 1 ? { skipTranscript: true } : undefined,
        );
      } catch (err) {
        decrementPending();
        requestStartTimeRef.current = null;
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (
            last?.isStreaming &&
            last.agenticRunId === run.id &&
            last.agenticPass === pass
          ) {
            return prev.slice(0, -1).concat({
              ...last,
              isStreaming: false,
              text: last.text.trim()
                ? `${last.text}\n\nError: ${message}`
                : `Error starting stream: ${message}`,
            });
          }
          return [
            ...prev,
            {
              id: `${Date.now()}-agentic-error`,
              role: "system",
              text: `Error: ${message}`,
            },
          ];
        });
        break;
      }

      const passAnswer = geminiStreamBufferRef.current.trim();
      if (run.cancelled || activeAgenticRunRef.current?.id !== run.id) break;

      if (!passAnswer) break;
      if (pass > 1 && isNoUsefulAgenticUpdate(passAnswer)) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.agenticRunId === run.id && last.agenticPass === pass) {
            return prev.slice(0, -1);
          }
          return prev;
        });
        break;
      }

      previousAnswer = [previousAnswer, passAnswer].filter(Boolean).join("\n\n");
    }

    if (activeAgenticRunRef.current?.id === run.id) {
      activeAgenticRunRef.current = null;
    }
  };

  const handleAnswerNow = async () => {
    if (isManualRecording) {
      // Stop recording - send accumulated voice input to Gemini
      isRecordingRef.current = false; // Update ref immediately
      setIsManualRecording(false);
      setManualTranscript(""); // Clear live preview

      // Send manual finalization signal to STT Providers
      window.electronAPI
        .finalizeMicSTT()
        .catch((err) =>
          console.error(
            "[NativelyInterface] Failed to send finalizeMicSTT:",
            err,
          ),
        );

      const currentAttachments = attachedContext;
      setAttachedContext([]); // Clear context immediately on send

      const question = (
        voiceInputRef.current +
        (manualTranscriptRef.current ? " " + manualTranscriptRef.current : "")
      ).trim();
      setVoiceInput("");
      voiceInputRef.current = "";
      setManualTranscript("");
      manualTranscriptRef.current = "";

      if (!question && currentAttachments.length === 0) {
        // No voice input and no image — show real STT error if available
        if (sttUserStatus === "failed" && sttUserError) {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "system",
              text: `❌ STT Error: ${sttUserError}`,
            },
          ]);
        } else if (sttUserStatus === "reconnecting") {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "system",
              text: "⏳ STT is reconnecting, try again in a moment.",
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "system",
              text: "⚠️ No speech detected. Try speaking closer to your microphone.",
            },
          ]);
        }
        return;
      }

      const historyMessages = messagesRef.current;

      // Show user's spoken question
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          text: question,
          hasScreenshot: currentAttachments.length > 0,
          screenshotPreview: currentAttachments[0]?.preview,
        },
      ]);

      setTimeout(() => scrollMessagesToBottom("smooth"), 50);

      try {
        if (currentAttachments.length === 0 && window.electronAPI.ragQueryLive) {
          // JIT RAG pre-flight stays as the fastest indexed answer path when available.
          const ragPlaceholderId = `${Date.now()}-rag`;
          setMessages((prev) => [
            ...prev,
            {
              id: ragPlaceholderId,
              role: "system",
              text: "",
              isStreaming: true,
              intent: "rag",
            },
          ]);
          incrementPending();

          let ragResult: { success?: boolean } | undefined;
          try {
            ragResult = await window.electronAPI.ragQueryLive?.(question);
          } catch (ragErr) {
            console.warn("[NativelyInterface] RAG pre-flight failed:", ragErr);
          }

          if (ragResult?.success) {
            // JIT RAG handled it — response streamed via rag:stream-chunk events
            return;
          }

          decrementPending();
          setMessages((prev) =>
            prev.filter((message) => message.id !== ragPlaceholderId),
          );
        }

        await runAgenticResponse({
          question,
          imagePaths:
            currentAttachments.length > 0
              ? currentAttachments.map((s) => s.path)
              : undefined,
          baseContext: conversationContext,
          historyMessages,
          source: currentAttachments.length > 0 ? "screenshot" : "voice",
        });
      } catch (err) {
        // Initial invocation failing (e.g. IPC error before stream starts)
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // If we just added the empty streaming placeholder, remove it or fill it with error
          if (last && last.isStreaming && last.text === "") {
            return prev.slice(0, -1).concat({
              id: Date.now().toString(),
              role: "system",
              text: `❌ Error starting stream: ${err}`,
            });
          }
          return [
            ...prev,
            {
              id: Date.now().toString(),
              role: "system",
              text: `❌ Error: ${err}`,
            },
          ];
        });
      }
    } else {
      // Start recording - reset voice input state
      setVoiceInput("");
      voiceInputRef.current = "";
      setManualTranscript("");
      isRecordingRef.current = true; // Update ref immediately
      setIsManualRecording(true);

      // Ensure native audio is connected
      try {
        // Native audio is now managed by main process
        // await window.electronAPI.invoke('native-audio-connect');
      } catch (err) {
        // Already connected, that's fine
      }
    }
  };

  const handleManualSubmit = async () => {
    if (!inputValue.trim() && attachedContext.length === 0) return;

    const userText = inputValue;
    const currentAttachments = attachedContext;
    const historyMessages = messagesRef.current;

    // Clear inputs immediately
    setInputValue("");
    setAttachedContext([]);

    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role: "user",
        text:
          userText ||
          (currentAttachments.length > 0 ? "Analyze this screenshot" : ""),
        hasScreenshot: currentAttachments.length > 0,
        screenshotPreview: currentAttachments[0]?.preview,
      },
    ]);

    setTimeout(() => scrollMessagesToBottom("smooth"), 50);

    setIsExpanded(true);

    try {
      await runAgenticResponse({
        question: userText || "Analyze this screenshot",
        imagePaths:
          currentAttachments.length > 0
            ? currentAttachments.map((s) => s.path)
            : undefined,
        baseContext: conversationContext,
        historyMessages,
        source: currentAttachments.length > 0 ? "screenshot" : "manual",
      });
    } catch (err) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.isStreaming && last.text === "") {
          // remove the empty placeholder
          return prev.slice(0, -1).concat({
            id: Date.now().toString(),
            role: "system",
            text: `❌ Error starting stream: ${err}`,
          });
        }
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: "system",
            text: `❌ Error: ${err}`,
          },
        ];
      });
    }
  };

  const clearChat = () => {
    setMessages([]);
    setCopilotSuggestion(null);
  };

  const actionCardScrollStyle: React.CSSProperties = {
    ...appearance.subtleStyle,
    width: "100%",
    minWidth: 0,
    ...(hasActionConversation
      ? {
          maxHeight: "min(20vh, 190px)",
          overflowY: "auto",
          scrollbarWidth: "thin",
        }
      : {}),
  };

  const renderMessageText = (msg: Message) => {
    // Negotiation coaching card takes priority
    if (msg.isNegotiationCoaching && msg.negotiationCoachingData) {
      return (
        <NegotiationCoachingCard
          {...msg.negotiationCoachingData}
          phase={msg.negotiationCoachingData.phase as any}
          onSilenceTimerEnd={() => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msg.id
                  ? {
                      ...m,
                      negotiationCoachingData: m.negotiationCoachingData
                        ? {
                            ...m.negotiationCoachingData,
                            showSilenceTimer: false,
                          }
                        : undefined,
                    }
                  : m,
              ),
            );
          }}
        />
      );
    }

    // Code-containing messages get special styling
    // We split by code blocks to keep the "Code Solution" UI intact for the code parts
    // But use ReactMarkdown for the text parts around it
    if (msg.isCode || (msg.role === "system" && msg.text.includes("```"))) {
      const parts = msg.text.split(/(```[\s\S]*?```)/g);
      return (
        <div
          className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`}
          style={actionCardScrollStyle}
        >
          <div
            className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? "text-violet-600" : "text-purple-300"}`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>Code Solution</span>
          </div>
          <div
            className={`space-y-2 text-[13px] leading-relaxed ${isLightTheme ? "text-slate-800" : "text-slate-200"}`}
          >
            {parts.map((part, i) => {
              if (part.startsWith("```")) {
                const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
                if (match) {
                  const lang = match[1] || "python";
                  const code = match[2].trim();
                  return (
                    <div
                      key={i}
                      className={`my-3 rounded-xl overflow-hidden border shadow-lg ${codeBlockClass}`}
                      style={appearance.codeBlockStyle}
                    >
                      {/* Minimalist Apple Header */}
                      <div
                        className={`px-3 py-1.5 border-b ${codeHeaderClass}`}
                        style={appearance.codeHeaderStyle}
                      >
                        <span
                          className={`text-[10px] uppercase tracking-widest font-semibold font-mono ${codeHeaderTextClass}`}
                        >
                          {lang || "CODE"}
                        </span>
                      </div>
                      <div className="bg-transparent">
                        <SyntaxHighlighter
                          language={lang}
                          style={codeTheme}
                          customStyle={{
                            margin: 0,
                            borderRadius: 0,
                            fontSize: "13px",
                            lineHeight: "1.6",
                            background: "transparent",
                            padding: "16px",
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          }}
                          wrapLongLines={true}
                          showLineNumbers={true}
                          lineNumberStyle={{
                            minWidth: "2.5em",
                            paddingRight: "1.2em",
                            color: codeLineNumberColor,
                            textAlign: "right",
                            fontSize: "11px",
                          }}
                        >
                          {code}
                        </SyntaxHighlighter>
                      </div>
                    </div>
                  );
                }
              }
              // Regular text - Render with Markdown
              return (
                <div key={i} className="markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      p: ({ node, ...props }: any) => (
                        <p
                          className="mb-2 last:mb-0 whitespace-pre-wrap"
                          {...props}
                        />
                      ),
                      strong: ({ node, ...props }: any) => (
                        <strong
                          className="font-bold overlay-text-strong"
                          {...props}
                        />
                      ),
                      em: ({ node, ...props }: any) => (
                        <em
                          className="italic overlay-text-secondary"
                          {...props}
                        />
                      ),
                      ul: ({ node, ...props }: any) => (
                        <ul
                          className="list-disc ml-4 mb-2 space-y-1"
                          {...props}
                        />
                      ),
                      ol: ({ node, ...props }: any) => (
                        <ol
                          className="list-decimal ml-4 mb-2 space-y-1"
                          {...props}
                        />
                      ),
                      li: ({ node, ...props }: any) => (
                        <li className="pl-1" {...props} />
                      ),
                      h1: ({ node, ...props }: any) => (
                        <h1
                          className="text-lg font-bold mb-2 mt-3 overlay-text-strong"
                          {...props}
                        />
                      ),
                      h2: ({ node, ...props }: any) => (
                        <h2
                          className="text-base font-bold mb-2 mt-3 overlay-text-strong"
                          {...props}
                        />
                      ),
                      h3: ({ node, ...props }: any) => (
                        <h3
                          className="text-sm font-bold mb-1 mt-2 overlay-text-primary"
                          {...props}
                        />
                      ),
                      code: ({ node, ...props }: any) => (
                        <code
                          className={`overlay-inline-code-surface rounded px-1 py-0.5 text-xs font-mono whitespace-pre-wrap ${isLightTheme ? "text-violet-700" : "text-purple-200"}`}
                          {...props}
                        />
                      ),
                      blockquote: ({ node, ...props }: any) => (
                        <blockquote
                          className={`border-l-2 pl-3 italic my-2 ${isLightTheme ? "border-violet-500/30 text-slate-600" : "border-purple-500/50 text-slate-400"}`}
                          {...props}
                        />
                      ),
                      a: ({ node, ...props }: any) => (
                        <a
                          className={`hover:underline ${isLightTheme ? "text-blue-600 hover:text-blue-700" : "text-blue-400 hover:text-blue-300"}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          {...props}
                        />
                      ),
                    }}
                  >
                    {part}
                  </ReactMarkdown>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    // Custom Styled Labels (Shorten, Recap, Follow-up) - also use Markdown for content
    if (msg.intent === "shorten") {
      return (
        <div
          className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`}
          style={actionCardScrollStyle}
        >
          <div
            className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? "text-cyan-700" : "text-cyan-300"}`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Shortened</span>
          </div>
          <div
            className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? "text-slate-800" : "text-slate-200"}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({ node, ...props }: any) => (
                  <p className="mb-2 last:mb-0" {...props} />
                ),
                strong: ({ node, ...props }: any) => (
                  <strong
                    className={`font-bold ${isLightTheme ? "text-cyan-800" : "text-cyan-100"}`}
                    {...props}
                  />
                ),
                ul: ({ node, ...props }: any) => (
                  <ul className="list-disc ml-4 mb-2" {...props} />
                ),
                li: ({ node, ...props }: any) => (
                  <li className="pl-1" {...props} />
                ),
              }}
            >
              {msg.text}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    if (msg.intent === "recap") {
      return (
        <div
          className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`}
          style={actionCardScrollStyle}
        >
          <div
            className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? "text-indigo-700" : "text-indigo-300"}`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Recap</span>
          </div>
          <div
            className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? "text-slate-800" : "text-slate-200"}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({ node, ...props }: any) => (
                  <p className="mb-2 last:mb-0" {...props} />
                ),
                strong: ({ node, ...props }: any) => (
                  <strong
                    className={`font-bold ${isLightTheme ? "text-indigo-800" : "text-indigo-100"}`}
                    {...props}
                  />
                ),
                ul: ({ node, ...props }: any) => (
                  <ul className="list-disc ml-4 mb-2" {...props} />
                ),
                li: ({ node, ...props }: any) => (
                  <li className="pl-1" {...props} />
                ),
              }}
            >
              {msg.text}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    if (msg.intent === "follow_up_questions") {
      return (
        <div
          className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`}
          style={actionCardScrollStyle}
        >
          <div
            className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? "text-amber-700" : "text-[#FFD60A]"}`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Follow-Up Questions</span>
          </div>
          <div
            className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? "text-slate-800" : "text-slate-200"}`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({ node, ...props }: any) => (
                  <p className="mb-2 last:mb-0" {...props} />
                ),
                strong: ({ node, ...props }: any) => (
                  <strong
                    className={`font-bold ${isLightTheme ? "text-amber-800" : "text-[#FFF9C4]"}`}
                    {...props}
                  />
                ),
                ul: ({ node, ...props }: any) => (
                  <ul className="list-disc ml-4 mb-2" {...props} />
                ),
                li: ({ node, ...props }: any) => (
                  <li className="pl-1" {...props} />
                ),
              }}
            >
              {msg.text}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    if (msg.intent === "what_to_answer") {
      // Split text by code blocks (Handle unclosed blocks at EOF)
      const parts = msg.text.split(/(```[\s\S]*?(?:```|$))/g);

      return (
        <div
          className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`}
          style={actionCardScrollStyle}
        >
          <div className="flex items-center gap-2 mb-2 text-emerald-400 font-semibold text-xs uppercase tracking-wide">
            <span>Say this</span>
          </div>
          <div className="text-[14px] leading-relaxed overlay-text-primary">
            {parts.map((part, i) => {
              if (part.startsWith("```")) {
                // Robust matching: handles unclosed blocks for streaming (```...$)
                const match = part.match(/```(\w*)\s+([\s\S]*?)(?:```|$)/);

                // Fallback logic: if it starts with ticks, treat as code (even if unclosed)
                if (match || part.startsWith("```")) {
                  const lang = match && match[1] ? match[1] : "python";
                  let code = "";

                  if (match && match[2]) {
                    code = match[2].trim();
                  } else {
                    // Manual strip if regex failed
                    code = part
                      .replace(/^```\w*\s*/, "")
                      .replace(/```$/, "")
                      .trim();
                  }

                  return (
                    <div
                      key={i}
                      className={`my-3 rounded-xl overflow-hidden border shadow-lg ${codeBlockClass}`}
                      style={appearance.codeBlockStyle}
                    >
                      {/* Minimalist Apple Header */}
                      <div
                        className={`px-3 py-1.5 border-b ${codeHeaderClass}`}
                        style={appearance.codeHeaderStyle}
                      >
                        <span
                          className={`text-[10px] uppercase tracking-widest font-semibold font-mono ${codeHeaderTextClass}`}
                        >
                          {lang || "CODE"}
                        </span>
                      </div>

                      <div className="bg-transparent">
                        <SyntaxHighlighter
                          language={lang}
                          style={codeTheme}
                          customStyle={{
                            margin: 0,
                            borderRadius: 0,
                            fontSize: "13px",
                            lineHeight: "1.6",
                            background: "transparent",
                            padding: "16px",
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          }}
                          wrapLongLines={true}
                          showLineNumbers={true}
                          lineNumberStyle={{
                            minWidth: "2.5em",
                            paddingRight: "1.2em",
                            color: codeLineNumberColor,
                            textAlign: "right",
                            fontSize: "11px",
                          }}
                        >
                          {code}
                        </SyntaxHighlighter>
                      </div>
                    </div>
                  );
                }
              }
              // Regular text - Render Markdown
              return (
                <div key={i} className="markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      p: ({ node, ...props }: any) => (
                        <p className="mb-2 last:mb-0" {...props} />
                      ),
                      strong: ({ node, ...props }: any) => (
                        <strong
                          className={`font-bold ${isLightTheme ? "text-emerald-700" : "text-emerald-100"}`}
                          {...props}
                        />
                      ),
                      em: ({ node, ...props }: any) => (
                        <em
                          className={`italic ${isLightTheme ? "text-emerald-700/80" : "text-emerald-200/80"}`}
                          {...props}
                        />
                      ),
                      ul: ({ node, ...props }: any) => (
                        <ul
                          className="list-disc ml-4 mb-2 space-y-1"
                          {...props}
                        />
                      ),
                      ol: ({ node, ...props }: any) => (
                        <ol
                          className="list-decimal ml-4 mb-2 space-y-1"
                          {...props}
                        />
                      ),
                      li: ({ node, ...props }: any) => (
                        <li className="pl-1" {...props} />
                      ),
                    }}
                  >
                    {part}
                  </ReactMarkdown>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    // Standard Text Messages (e.g. from User or Interviewer)
    // We still want basic markdown support here too
    return (
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            p: ({ node, ...props }: any) => (
              <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />
            ),
            strong: ({ node, ...props }: any) => (
              <strong
                className="font-bold opacity-100 overlay-text-strong"
                {...props}
              />
            ),
            em: ({ node, ...props }: any) => (
              <em
                className="italic opacity-90 overlay-text-secondary"
                {...props}
              />
            ),
            ul: ({ node, ...props }: any) => (
              <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />
            ),
            ol: ({ node, ...props }: any) => (
              <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />
            ),
            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
            code: ({ node, ...props }: any) => (
              <code
                className={`overlay-inline-code-surface rounded px-1 py-0.5 text-xs font-mono ${isLightTheme ? "text-slate-800" : ""}`}
                {...props}
              />
            ),
            a: ({ node, ...props }: any) => (
              <a
                className="underline hover:opacity-80"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              />
            ),
          }}
        >
          {msg.text}
        </ReactMarkdown>
      </div>
    );
  };

  // We use a ref to hold the latest handlers to avoid re-binding the event listener on every render
  const handlersRef = useRef({
    handleWhatToSay,
    handleFollowUp,
    handleFollowUpQuestions,
    handleRecap,
    handleAnswerNow,
    handleClarify,
    handleCodeHint,
    handleBrainstorm,
  });

  // Update ref on every render so the event listener always access latest state/props
  handlersRef.current = {
    handleWhatToSay,
    handleFollowUp,
    handleFollowUpQuestions,
    handleRecap,
    handleAnswerNow,
    handleClarify,
    handleCodeHint,
    handleBrainstorm,
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const {
        handleWhatToSay,
        handleFollowUp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow,
        handleClarify,
        handleCodeHint,
        handleBrainstorm,
      } = handlersRef.current;

      // Chat Shortcuts (Scope: Local to Chat/Overlay usually, but we allow them here if focused)
      if (isShortcutPressed(e, "whatToAnswer")) {
        e.preventDefault();
        handleWhatToSay();
      } else if (isShortcutPressed(e, "clarify")) {
        e.preventDefault();
        handleClarify();
      } else if (isShortcutPressed(e, "followUp")) {
        e.preventDefault();
        handleFollowUpQuestions();
      } else if (isShortcutPressed(e, "dynamicAction4")) {
        e.preventDefault();
        if (actionButtonMode === "brainstorm") {
          handleBrainstorm();
        } else {
          handleRecap();
        }
      } else if (isShortcutPressed(e, "answer")) {
        e.preventDefault();
        handleAnswerNow();
      } else if (isShortcutPressed(e, "clarify")) {
        e.preventDefault();
        handleClarify();
      } else if (isShortcutPressed(e, "codeHint")) {
        e.preventDefault();
        handleCodeHint();
      } else if (isShortcutPressed(e, "brainstorm")) {
        e.preventDefault();
        handleBrainstorm();
      } else if (isShortcutPressed(e, "scrollUp")) {
        e.preventDefault();
        scrollContainerRef.current?.scrollBy({ top: -100, behavior: "smooth" });
      } else if (isShortcutPressed(e, "scrollDown")) {
        e.preventDefault();
        scrollContainerRef.current?.scrollBy({ top: 100, behavior: "smooth" });
      } else if (
        isShortcutPressed(e, "moveWindowUp") ||
        isShortcutPressed(e, "moveWindowDown")
      ) {
        // Prevent default scrolling when moving window
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isShortcutPressed]);

  // General Global Shortcuts (Rebindable)
  // We listen here to handle them when the window is focused (renderer side)
  // Global shortcuts (when window blurred) are handled by Main process -> GlobalShortcuts
  // But Main process events might not reach here if we don't listen, or we want unified handling.
  // Actually, KeybindManager registers global shortcuts. If they are registered as global,
  // Electron might consume them before they reach here?
  // 'toggle-app' is Global.
  // 'toggle-visibility' is NOT Global in default config (isGlobal: false), so it depends on focus.
  // So we MUST listen for them here.

  const generalHandlersRef = useRef({
    toggleVisibility: () => window.electronAPI.toggleWindow(),
    processScreenshots: handleWhatToSay,
    resetCancel: async () => {
      if (isProcessing) {
        await cancelActiveWork();
      } else {
        await window.electronAPI.resetIntelligence();
        setMessages([]);
        setAttachedContext([]);
        setCopilotSuggestion(null);
        setInputValue("");
      }
    },
    toggleMousePassthrough: () => {
      const newState = !isMousePassthrough;
      setIsMousePassthrough(newState);
      window.electronAPI?.setOverlayMousePassthrough?.(newState);
    },
    takeScreenshot: async () => {
      try {
        const data = await window.electronAPI.takeScreenshot();
        if (data && data.path) {
          handleScreenshotAttach(data as { path: string; preview: string });
        }
      } catch (err) {
        console.error("Error triggering screenshot:", err);
      }
    },
    selectiveScreenshot: async () => {
      try {
        const data = await window.electronAPI.takeSelectiveScreenshot();
        if (data && !data.cancelled && data.path) {
          handleScreenshotAttach(data as { path: string; preview: string });
        }
      } catch (err) {
        console.error("Error triggering selective screenshot:", err);
      }
    },
  });

  // Update ref
  generalHandlersRef.current = {
    toggleVisibility: () => window.electronAPI.toggleWindow(),
    processScreenshots: handleWhatToSay,
    resetCancel: async () => {
      if (isProcessing) {
        await cancelActiveWork();
      } else {
        await window.electronAPI.resetIntelligence();
        setMessages([]);
        setAttachedContext([]);
        setCopilotSuggestion(null);
        setInputValue("");
      }
    },
    toggleMousePassthrough: () => {
      const newState = !isMousePassthrough;
      setIsMousePassthrough(newState);
      window.electronAPI?.setOverlayMousePassthrough?.(newState);
    },
    takeScreenshot: async () => {
      try {
        const data = await window.electronAPI.takeScreenshot();
        if (data && data.path) {
          handleScreenshotAttach(data as { path: string; preview: string });
        }
      } catch (err) {
        console.error("Error triggering screenshot:", err);
      }
    },
    selectiveScreenshot: async () => {
      try {
        const data = await window.electronAPI.takeSelectiveScreenshot();
        if (data && !data.cancelled && data.path) {
          handleScreenshotAttach(data as { path: string; preview: string });
        }
      } catch (err) {
        console.error("Error triggering selective screenshot:", err);
      }
    },
  };

  useEffect(() => {
    const handleGeneralKeyDown = (e: KeyboardEvent) => {
      const handlers = generalHandlersRef.current;
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (isShortcutPressed(e, "toggleVisibility")) {
        // Always allow toggling visibility
        e.preventDefault();
        handlers.toggleVisibility();
      } else if (isShortcutPressed(e, "processScreenshots")) {
        if (!isInput) {
          e.preventDefault();
          handlers.processScreenshots();
        }
        // If input focused, let default behavior (Enter) happen or handle it via onKeyDown in Input
      } else if (isShortcutPressed(e, "resetCancel")) {
        e.preventDefault();
        handlers.resetCancel();
      } else if (isShortcutPressed(e, "takeScreenshot")) {
        e.preventDefault();
        handlers.takeScreenshot();
      } else if (isShortcutPressed(e, "selectiveScreenshot")) {
        e.preventDefault();
        handlers.selectiveScreenshot();
      } else if (isShortcutPressed(e, "toggleMousePassthrough")) {
        e.preventDefault();
        handlers.toggleMousePassthrough();
      }
    };

    window.addEventListener("keydown", handleGeneralKeyDown);
    return () => window.removeEventListener("keydown", handleGeneralKeyDown);
  }, [isShortcutPressed]);

  // Global "Capture & Process" shortcut handler (issue #90)
  // Registered separately so it always has the latest handlersRef via stable ref access.
  // Main process takes the screenshot and sends "capture-and-process" with path+preview;
  // we attach the screenshot to context and immediately trigger AI analysis.
  useEffect(() => {
    if (!window.electronAPI.onCaptureAndProcess) return;
    const unsubscribe = window.electronAPI.onCaptureAndProcess((data) => {
      setIsExpanded(true);

      // Store screenshot in a stable ref BEFORE updating React state.
      // This fixes the React 18 concurrent mode timing race where setTimeout(0)
      // could fire before setAttachedContext had flushed, leaving handleWhatToSay
      // with an empty attachedContext and causing silent failures.
      pendingCaptureRef.current = data;

      setAttachedContext((prev) => {
        if (prev.some((s) => s.path === data.path)) return prev;
        return [...prev, data].slice(-5);
      });

      // Use requestAnimationFrame so we wait for at least one paint cycle —
      // more reliable than setTimeout(0) under React 18 concurrent scheduling.
      // The ref guarantees handleWhatToSay has the screenshot regardless of
      // whether the state update has flushed yet.
      requestAnimationFrame(() => {
        try {
          handlersRef.current.handleWhatToSay();
        } finally {
          pendingCaptureRef.current = null;
        }
      });
    });
    return unsubscribe;
  }, []);

  // Stealth Global Shortcuts Handler
  // Listens for shortcuts triggered when the app is in the background
  useEffect(() => {
    if (!window.electronAPI.onGlobalShortcut) return;
    const unsubscribe = window.electronAPI.onGlobalShortcut(({ action }) => {
      const handlers = handlersRef.current;
      const generalHandlers = generalHandlersRef.current;

      isStealthRef.current = true;

      if (action === "whatToAnswer") handlers.handleWhatToSay();
      else if (action === "shorten") handlers.handleFollowUp("shorten");
      else if (action === "followUp") handlers.handleFollowUpQuestions();
      else if (action === "recap") handlers.handleRecap();
      else if (action === "dynamicAction4") {
        if (actionButtonMode === "brainstorm") handlers.handleBrainstorm();
        else handlers.handleRecap();
      } else if (action === "answer") handlers.handleAnswerNow();
      else if (action === "clarify") handlers.handleClarify();
      else if (action === "codeHint") handlers.handleCodeHint();
      else if (action === "brainstorm") handlers.handleBrainstorm();
      else if (action === "scrollUp")
        scrollContainerRef.current?.scrollBy({ top: -100, behavior: "smooth" });
      else if (action === "scrollDown")
        scrollContainerRef.current?.scrollBy({ top: 100, behavior: "smooth" });
      else if (action === "processScreenshots")
        generalHandlers.processScreenshots();
      else if (action === "resetCancel") generalHandlers.resetCancel();
      else if (action === "takeScreenshot") generalHandlers.takeScreenshot();
      else if (action === "selectiveScreenshot")
        generalHandlers.selectiveScreenshot();

      // Safety reset if it didn't trigger an expansion
      setTimeout(() => {
        isStealthRef.current = false;
      }, 500);
    });
    return unsubscribe;
  }, []);

  // ── Derived STT status for the rolling transcript indicator (interviewer channel) ──
  const interviewerSttIndicatorStatus = sttInterviewerStatus;
  const hasSttConnectionIssue =
    interviewerSttIndicatorStatus !== "connected" ||
    sttUserStatus !== "connected";
  const shouldShowRollingTranscript =
    !hasActionConversation &&
    ((showTranscript && rollingTranscript) || hasSttConnectionIssue);
  // Strip consecutive error count from display — show only in expanded diagnostics
  const interviewerSttIndicatorError = sttInterviewerError?.replace(
    /\s*\(\d+ consecutive errors\):?/gi,
    "",
  );
  const liveTranscriptEmptyMessage = useMemo(() => {
    const formatIssue = (
      label: string,
      status: "connected" | "reconnecting" | "failed",
      provider: string,
      error: string,
    ) => {
      if (status === "connected") return null;
      const providerLabel = provider || "STT";
      const detail = error ? `: ${error}` : "";
      return `${label} ${providerLabel} is ${status}${detail}`;
    };

    const issues = [
      formatIssue("Speaker", sttInterviewerStatus, sttInterviewerProvider, sttInterviewerError),
      formatIssue("Mic", sttUserStatus, sttUserProvider, sttUserError),
    ].filter(Boolean);

    if (issues.length > 0) {
      return issues.join(" | ");
    }

    return "Waiting for live transcript...";
  }, [
    sttInterviewerError,
    sttInterviewerProvider,
    sttInterviewerStatus,
    sttUserError,
    sttUserProvider,
    sttUserStatus,
  ]);
  const visibleTranscriptTurns = [...liveTranscriptTurns].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const copyableTranscriptTurns = [...copyTranscriptTurns].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const pendingTranscriptTurns = Object.values(pendingLiveTranscript)
    .filter((turn): turn is LiveTranscriptTurn => Boolean(turn))
    .sort((a, b) => a.timestamp - b.timestamp);
  const hasPendingTranscript = pendingTranscriptTurns.length > 0;
  const hasLiveTranscript =
    showTranscript &&
    (visibleTranscriptTurns.length > 0 || hasPendingTranscript || isConnected);
  const transcriptPageSize = hasActionConversation
    ? isTranscriptExpanded
      ? 2
      : 1
    : isTranscriptExpanded
      ? LIVE_TRANSCRIPT_EXPANDED_PAGE_SIZE
      : LIVE_TRANSCRIPT_COLLAPSED_PAGE_SIZE;
  const transcriptViewportMaxHeight = hasActionConversation
    ? isTranscriptExpanded
      ? "min(8vh, 72px)"
      : "34px"
    : isTranscriptExpanded
      ? "min(30vh, 280px)"
      : "min(20vh, 180px)";
  const maxTranscriptPage = Math.max(
    0,
    Math.ceil(visibleTranscriptTurns.length / transcriptPageSize) - 1,
  );
  const currentTranscriptPage = Math.min(transcriptPage, maxTranscriptPage);
  const transcriptWindowEnd = Math.max(
    0,
    visibleTranscriptTurns.length - currentTranscriptPage * transcriptPageSize,
  );
  const transcriptWindowStart = Math.max(
    0,
    transcriptWindowEnd - transcriptPageSize,
  );
  const displayedStableTranscriptTurns = visibleTranscriptTurns.slice(
    transcriptWindowStart,
    transcriptWindowEnd,
  );
  const displayedTranscriptTurns =
    currentTranscriptPage === 0
      ? [...displayedStableTranscriptTurns, ...pendingTranscriptTurns]
      : displayedStableTranscriptTurns;
  const transcriptQualityFlags = [
    ...visibleTranscriptTurns.slice(-6),
    ...pendingTranscriptTurns,
  ].flatMap((turn) => turn.qualityFlags || []);
  const transcriptStatusBadges = [
    transcriptQualityFlags.includes("speaker_stable") ? "Speaker stable" : "",
    transcriptQualityFlags.includes("mic_gate_held") ? "Mic gated" : "",
    transcriptQualityFlags.includes("possible_overlap") ? "Overlap" : "",
    transcriptQualityFlags.includes("low_confidence") ? "Low confidence" : "",
  ].filter(Boolean).slice(0, 3);

  useEffect(() => {
    setTranscriptPage((page) => Math.min(page, maxTranscriptPage));
  }, [maxTranscriptPage]);

  const getTranscriptSpeakerLabel = (
    speaker: LiveTranscriptTurn["speaker"],
  ) => {
    if (speaker === "me") return "Me";
    if (speaker === "interlocutor" || speaker === "interviewer") return "Speaker";
    if (speaker === "uncertain") return "Uncertain";
    const diarizedMatch = /^locuteur[_-](\d+)$/i.exec(speaker);
    if (diarizedMatch) return `Locuteur ${Number(diarizedMatch[1]) + 1}`;
    const speakerMatch = /^speaker[_-](\d+)$/i.exec(speaker);
    if (speakerMatch) return `Speaker ${Number(speakerMatch[1])}`;
    if (speaker && speaker !== "user") return speaker;
    return "Mic";
  };

  const formatTranscriptTurn = (turn: LiveTranscriptTurn) => {
    const time = new Date(turn.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `[${time}] ${getTranscriptSpeakerLabel(turn.speaker)}: ${turn.text}`;
  };

  const copyTextToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const markTranscriptCopied = (id: string) => {
    setCopiedTranscriptId(id);
    window.setTimeout(() => {
      setCopiedTranscriptId((current) => (current === id ? null : current));
    }, 1400);
  };

  const handleCopyTranscriptTurn = async (turn: LiveTranscriptTurn) => {
    await copyTextToClipboard(formatTranscriptTurn(turn));
    markTranscriptCopied(turn.id);
  };

  const handleCopyFullTranscript = async () => {
    if (copyableTranscriptTurns.length === 0) return;
    await copyTextToClipboard(
      copyableTranscriptTurns.map(formatTranscriptTurn).join("\n"),
    );
    markTranscriptCopied("all");
  };

  const copyDiagnostics = async () => {
    const version = import.meta.env.VITE_APP_VERSION || "unknown";
    const [arch, osVersion] = await Promise.all([
      window.electronAPI?.getArch?.().catch(() => "unknown"),
      window.electronAPI?.getOsVersion?.().catch(() => "unknown"),
    ]);
    const { categorizeSttError } = await import("../lib/sttErrorMapper");
    const userCat = sttUserError ? categorizeSttError(sttUserError) : null;
    const interviewerCat = sttInterviewerError
      ? categorizeSttError(sttInterviewerError)
      : null;
    const report = [
      "## STT Diagnostic Report",
      `App Version: ${version}`,
      `Platform: ${osVersion} (${arch})`,
      `---`,
      `Microphone Provider: ${sttUserProvider}`,
      `Microphone Status: ${sttUserStatus}`,
      userCat
        ? `Microphone Category: ${userCat.title} [${userCat.category}]`
        : "",
      `Microphone Error: ${sttUserError || "N/A"}`,
      `---`,
      `System Audio Provider: ${sttInterviewerProvider}`,
      `System Audio Status: ${sttInterviewerStatus}`,
      interviewerCat
        ? `System Audio Category: ${interviewerCat.title} [${interviewerCat.category}]`
        : "",
      `System Audio Error: ${sttInterviewerError || "N/A"}`,
      `Timestamp: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  return (
    <div
      ref={contentRef}
      className="flex flex-col items-center w-fit mx-auto h-full min-h-0 bg-transparent p-0 rounded-[24px] font-sans gap-2 overlay-text-primary"
      style={{ height: preferredOverlayHeight }}
    >
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="flex flex-col items-center gap-2 w-full h-full min-h-0"
          >
            <TopPill
              expanded={isExpanded}
              onToggle={() => setIsExpanded(!isExpanded)}
              onQuit={() =>
                onEndMeeting ? onEndMeeting() : window.electronAPI.quitApp()
              }
              appearance={appearance}
              onLogoClick={() =>
                window.electronAPI?.setWindowMode?.("launcher")
              }
            />
            <div
              data-testid="natively-overlay-panel"
              className={`relative w-[760px] max-w-none flex-1 min-h-0 backdrop-blur-2xl border rounded-[24px] overflow-hidden flex flex-col draggable-area overlay-shell-surface ${overlayPanelClass}`}
              style={appearance.shellStyle}
            >
              {/* System Audio Permission Warning Banner */}
              {systemAudioWarning && (
                <div className="flex items-center justify-between mx-4 mt-3 mb-1 px-3.5 py-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-[12px] shadow-sm relative no-drag group/warning">
                  <div className="flex flex-col gap-1 pr-3">
                    <div className="flex items-center gap-2 text-[12.5px] text-yellow-600 dark:text-yellow-400/90 font-medium leading-tight">
                      <div className="shrink-0 p-1 bg-yellow-500/20 rounded-full">
                        <svg
                          className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2.5}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                      </div>
                      <span>{systemAudioWarningTitle}</span>
                    </div>
                    <p className="text-[11px] text-yellow-600/70 dark:text-yellow-400/60 leading-snug pl-[26px]">
                      {systemAudioWarning}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        window.electronAPI.openExternal(
                          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                        );
                      }}
                      className="px-3 py-1.5 rounded-lg bg-yellow-500/15 hover:bg-yellow-500/25 text-yellow-700 dark:text-yellow-500 text-[11px] font-semibold transition-all active:scale-95 border border-yellow-500/20 shadow-sm"
                    >
                      Open Settings
                    </button>
                    <button
                      onClick={() => setSystemAudioWarning(null)}
                      className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-yellow-600/50 hover:text-yellow-700 dark:text-yellow-500/50 dark:hover:text-yellow-400 transition-colors absolute top-1 right-1 opacity-0 group-hover/warning:opacity-100"
                      title="Dismiss"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}

              {/* PR #173: STT Not Configured Warning Banner */}
              {sttNotConfigured && (
                <div className="flex items-center justify-between mx-4 mt-3 mb-1 px-3.5 py-2.5 bg-orange-500/10 border border-orange-500/20 rounded-[12px] shadow-sm relative no-drag group/stt-warning">
                  <div className="flex flex-col gap-1 pr-3">
                    <div className="flex items-center gap-2 text-[12.5px] text-orange-600 dark:text-orange-400/90 font-medium leading-tight">
                      <div className="shrink-0 p-1 bg-orange-500/20 rounded-full">
                        <svg
                          className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2.5}
                            d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                          />
                        </svg>
                      </div>
                      <span>Transcription Not Configured</span>
                    </div>
                    <p className="text-[11px] text-orange-600/70 dark:text-orange-400/60 leading-snug pl-[26px]">
                      No STT provider selected. Open Settings → Audio to pick
                      one.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        window.electronAPI?.toggleSettingsWindow?.();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 text-orange-700 dark:text-orange-500 text-[11px] font-semibold transition-all active:scale-95 border border-orange-500/20 shadow-sm"
                    >
                      Open Settings
                    </button>
                    <button
                      onClick={() => setSttNotConfigured(false)}
                      className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-orange-600/50 hover:text-orange-700 dark:text-orange-500/50 dark:hover:text-orange-400 transition-colors absolute top-1 right-1 opacity-0 group-hover/stt-warning:opacity-100"
                      title="Dismiss"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}

              {/* Rolling Transcript Bar — includes STT status indicator inline */}
              {shouldShowRollingTranscript ? (
                <RollingTranscript
                  text={showTranscript ? rollingTranscript : ""}
                  isActive={isInterviewerSpeaking}
                  surfaceStyle={
                    showTranscript ? appearance.transcriptStyle : undefined
                  }
                  interviewerChannel={{
                    status: interviewerSttIndicatorStatus,
                    error: interviewerSttIndicatorError,
                    provider: sttInterviewerProvider,
                  }}
                  microphoneChannel={{
                    status: sttUserStatus,
                    error: sttUserError,
                    provider: sttUserProvider,
                  }}
                  onCopyDiagnostics={copyDiagnostics}
                />
              ) : null}

              <div
                data-testid="natively-assist-layout"
                className="flex-1 min-h-0 no-drag grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
              >
                <div
                  data-testid="natively-context-section"
                  className={`min-h-0 pt-1.5 overscroll-contain ${
                    hasActionConversation ? "overflow-hidden" : "overflow-y-auto"
                  }`}
                  style={{
                    maxHeight: topSectionMaxHeight,
                    scrollbarWidth: "none",
                  }}
                >
              {hasLiveTranscript && (
                <div
                  data-testid="natively-live-transcript-panel"
                  className={`mx-4 ${isConversationFocusMode ? "mt-1" : "mt-2"} mb-1 rounded-[12px] border no-drag overflow-hidden ${subtleSurfaceClass}`}
                  style={appearance.subtleStyle}
                >
                  <div className="flex items-center justify-between gap-3 px-3.5 pt-2.5 pb-1.5">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide overlay-text-muted">
                      <Mic className="w-3 h-3" />
                      Live transcript
                      {visibleTranscriptTurns.length > transcriptPageSize && (
                        <span className="normal-case font-medium opacity-70">
                          {currentTranscriptPage + 1}/{maxTranscriptPage + 1}
                        </span>
                      )}
                      {transcriptStatusBadges.map((badge) => (
                        <span
                          key={badge}
                          className="normal-case tracking-normal px-1.5 py-0.5 rounded-full border overlay-border-muted overlay-text-muted text-[9px] font-medium"
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] overlay-text-muted">
                      {visibleTranscriptTurns.length > transcriptPageSize && (
                        <>
                          <button
                            onClick={() =>
                              setTranscriptPage((page) =>
                                Math.min(maxTranscriptPage, page + 1),
                              )
                            }
                            disabled={
                              currentTranscriptPage >= maxTranscriptPage
                            }
                            className={`p-1.5 rounded-full border transition-all active:scale-95 disabled:opacity-35 disabled:pointer-events-none ${quickActionClass}`}
                            style={appearance.chipStyle}
                            title="Older transcript"
                          >
                            <ChevronUp className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() =>
                              setTranscriptPage((page) => Math.max(0, page - 1))
                            }
                            disabled={currentTranscriptPage === 0}
                            className={`p-1.5 rounded-full border transition-all active:scale-95 disabled:opacity-35 disabled:pointer-events-none ${quickActionClass}`}
                            style={appearance.chipStyle}
                            title="Newer transcript"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => {
                          setIsTranscriptExpanded((prev) => !prev);
                          setTranscriptPage(0);
                        }}
                        className={`flex items-center gap-1 px-2 py-1 rounded-full border transition-all active:scale-95 ${quickActionClass}`}
                        style={appearance.chipStyle}
                        title={
                          isTranscriptExpanded
                            ? "Collapse transcript"
                            : "Expand transcript"
                        }
                      >
                        {isTranscriptExpanded ? (
                          <ChevronUp className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                        <span>{isTranscriptExpanded ? "Less" : "More"}</span>
                      </button>
                      <button
                        onClick={handleCopyFullTranscript}
                        disabled={copyableTranscriptTurns.length === 0}
                        className={`flex items-center gap-1 px-2 py-1 rounded-full border transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none ${quickActionClass}`}
                        style={appearance.chipStyle}
                        title="Copy full transcript"
                      >
                        {copiedTranscriptId === "all" ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>
                          {copiedTranscriptId === "all" ? "Copied" : "Copy all"}
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          const next = !showTranscript;
                          setShowTranscript(next);
                          localStorage.setItem(
                            "natively_interviewer_transcript",
                            String(next),
                          );
                        }}
                        className={`flex items-center gap-1 px-2 py-1 rounded-full border transition-all active:scale-95 ${quickActionClass}`}
                        style={appearance.chipStyle}
                        title={
                          showTranscript ? "Hide transcript" : "Show transcript"
                        }
                      >
                        {showTranscript ? (
                          <EyeOff className="w-3 h-3" />
                        ) : (
                          <Eye className="w-3 h-3" />
                        )}
                        <span>{showTranscript ? "Hide" : "Show"}</span>
                      </button>
                      {hasPendingTranscript && (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span>Listening</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div
                    ref={liveTranscriptScrollRef}
                    className="px-3.5 pb-3 space-y-2 overflow-y-auto"
                    style={{
                      maxHeight: transcriptViewportMaxHeight,
                    }}
                  >
                    {displayedTranscriptTurns.length > 0 ? (
                      displayedTranscriptTurns.map((turn) => (
                        <div
                          key={turn.id}
                          className="group/transcript grid grid-cols-[88px_minmax(0,1fr)_24px] gap-2 text-[12px] leading-snug"
                        >
                          <div
                            className={`font-semibold ${turn.speaker === "user" || turn.speaker === "me" ? "text-emerald-400" : "overlay-text-muted"}`}
                          >
                            {getTranscriptSpeakerLabel(turn.speaker)}
                          </div>
                          <div
                            className={`min-w-0 select-text ${turn.final ? "overlay-text-primary" : "overlay-text-muted italic"}`}
                          >
                            {turn.text}
                            {!turn.final && (
                              <span className="inline-block ml-1 w-1 h-1 rounded-full bg-emerald-400 align-middle animate-pulse" />
                            )}
                          </div>
                          <button
                            onClick={() => handleCopyTranscriptTurn(turn)}
                            className="opacity-0 group-hover/transcript:opacity-100 focus:opacity-100 p-1 rounded-md overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive transition-opacity"
                            title="Copy transcript line"
                            style={appearance.iconStyle}
                          >
                            {copiedTranscriptId === turn.id ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="py-2 text-[12px] overlay-text-muted">
                        {liveTranscriptEmptyMessage}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {copilotQuality && !hasActionConversation && (
                <div
                  className={`mx-4 mt-2 mb-1 px-3 py-1.5 rounded-[12px] border no-drag ${subtleSurfaceClass}`}
                  style={appearance.subtleStyle}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="shrink-0 p-1 rounded-full overlay-icon-surface overlay-text-interactive"
                      style={appearance.iconStyle}
                    >
                      <Sparkles className="w-3 h-3" />
                    </div>
                    <div className="min-w-0 flex-1 flex items-baseline gap-2">
                      <div className="text-[9px] font-semibold uppercase tracking-wide overlay-text-muted shrink-0">
                        Autopilot
                      </div>
                      <div className="text-[12px] leading-tight font-medium overlay-text-primary truncate">
                        {copilotQuality.label}
                      </div>
                      {copilotQuality.reason && (
                        <div className="hidden sm:block truncate text-[10px] overlay-text-muted">
                          {copilotQuality.reason}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-[11px] font-semibold overlay-text-interactive">
                      {copilotQualityScore}%
                    </div>
                  </div>
                </div>
              )}

              {copilotSuggestion?.suggestion && !isConversationFocusMode && (
                <div
                  className={`mx-4 mt-2 mb-1 rounded-[12px] border no-drag ${subtleSurfaceClass} ${
                    hasActionConversation ? "px-2.5 py-2" : "px-3.5 py-3"
                  }`}
                  style={appearance.subtleStyle}
                >
                  {hasActionConversation ? (
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="shrink-0 p-1 rounded-full overlay-icon-surface overlay-text-interactive"
                        style={appearance.iconStyle}
                      >
                        <Lightbulb className="w-3 h-3" />
                      </div>
                      <div className="min-w-0 flex-1 flex items-center gap-2">
                        <div className="text-[9px] font-semibold uppercase tracking-wide overlay-text-muted shrink-0">
                          {copilotSuggestion.suggestionType ===
                            "vibe_interview_say_this" ||
                          copilotSuggestion.suggestionType ===
                            "interview_answer"
                            ? "Say"
                            : "Ask"}
                        </div>
                        <div
                          className="min-w-0 flex-1 truncate text-[12px] leading-tight overlay-text-primary"
                          title={copilotSuggestion.suggestion}
                        >
                          {copilotSuggestion.suggestion}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        <button
                          onClick={() => handleCopilotFeedback("useful")}
                          className={`p-1 rounded-md border transition-all active:scale-95 ${quickActionClass}`}
                          title="Useful"
                          style={appearance.chipStyle}
                        >
                          <ThumbsUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleCopilotFeedback("too_early")}
                          className={`p-1 rounded-md border transition-all active:scale-95 ${quickActionClass}`}
                          title="Too early"
                          style={appearance.chipStyle}
                        >
                          <Clock3 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleCopilotFeedback("not_relevant")}
                          className={`p-1 rounded-md border transition-all active:scale-95 ${quickActionClass}`}
                          title="Not relevant"
                          style={appearance.chipStyle}
                        >
                          <CircleSlash className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => setCopilotSuggestion(null)}
                          className="p-1 rounded-md overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                          title="Dismiss"
                          style={appearance.iconStyle}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ) : (
                  <div className="flex items-start gap-2.5">
                    <div
                      className="mt-0.5 shrink-0 p-1.5 rounded-full overlay-icon-surface overlay-text-interactive"
                      style={appearance.iconStyle}
                    >
                      <Lightbulb className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide overlay-text-muted">
                          {copilotSuggestion.suggestionType === "vibe_interview_say_this" ||
                          copilotSuggestion.suggestionType === "interview_answer"
                            ? "Say this"
                            : "Suggested question"}
                        </div>
                        <button
                          onClick={() => setCopilotSuggestion(null)}
                          className="p-1 rounded-md overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                          title="Dismiss"
                          style={appearance.iconStyle}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-[13px] leading-snug overlay-text-primary pr-1">
                        {copilotSuggestion.suggestion}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                        <button
                          onClick={() => handleCopilotFeedback("useful")}
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border transition-all active:scale-95 ${quickActionClass}`}
                          title="Useful"
                          style={appearance.chipStyle}
                        >
                          <ThumbsUp className="w-3 h-3" /> Useful
                        </button>
                        <button
                          onClick={() => handleCopilotFeedback("too_early")}
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border transition-all active:scale-95 ${quickActionClass}`}
                          title="Too early"
                          style={appearance.chipStyle}
                        >
                          <Clock3 className="w-3 h-3" /> Too early
                        </button>
                        <button
                          onClick={() => handleCopilotFeedback("not_relevant")}
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border transition-all active:scale-95 ${quickActionClass}`}
                          title="Not relevant"
                          style={appearance.chipStyle}
                        >
                          <CircleSlash className="w-3 h-3" /> Not relevant
                        </button>
                        <button
                          onClick={() =>
                            handleCopilotFeedback("already_discussed")
                          }
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border transition-all active:scale-95 ${quickActionClass}`}
                          title="Already discussed"
                          style={appearance.chipStyle}
                        >
                          <CheckCircle2 className="w-3 h-3" /> Already discussed
                        </button>
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              )}

                </div>

                <div
                  ref={scrollContainerRef}
                  data-testid="natively-chat-scroll"
                  className="min-h-0 h-full max-h-full overflow-y-auto overscroll-contain no-drag px-4 py-2 scroll-pb-28"
                  style={{
                    scrollbarWidth: "thin",
                    overscrollBehaviorY: "contain",
                    WebkitOverflowScrolling: "touch",
                  }}
                >

              {/* Chat History - Only show if there are messages OR active states */}
              {(messages.length > 0 || isManualRecording || isProcessing) && (
                <div className="min-h-full flex flex-col justify-start gap-1.5 pb-3 no-drag">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      data-action-id={msg.actionId || undefined}
                      data-action-status={msg.actionStatus || undefined}
                      data-action-intent={msg.intent || undefined}
                      data-service-tier={msg.serviceTierUsed || undefined}
                      data-service-tier-fallback={msg.serviceTierFallback ? "true" : undefined}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in-up`}
                    >
                      <div
                        className={`
                      ${msg.role === "user" ? "max-w-[72.25%] px-[13.6px] py-[10.2px]" : "w-full max-w-full px-0 py-1"} text-[14px] leading-relaxed relative group whitespace-pre-wrap
                      ${
                        msg.role === "user"
                          ? isLightTheme
                            ? "bg-blue-500/10 backdrop-blur-md border border-blue-500/20 text-blue-900 rounded-[20px] rounded-tr-[4px] shadow-sm font-medium"
                            : "bg-blue-600/20 backdrop-blur-md border border-blue-500/30 text-blue-100 rounded-[20px] rounded-tr-[4px] shadow-sm font-medium"
                          : ""
                      }
                      ${
                        msg.role === "system"
                          ? "overlay-text-primary font-normal"
                          : ""
                      }
                      ${
                        msg.role === "interviewer"
                          ? "overlay-text-muted italic pl-0 text-[13px]"
                          : ""
                      }
                    `}
                      >
                        {msg.role === "interviewer" && (
                          <div className="flex items-center gap-1.5 mb-1 text-[10px] font-medium uppercase tracking-wider overlay-text-muted">
                            Interviewer
                            {msg.isStreaming && (
                              <span className="w-1 h-1 bg-green-500 rounded-full animate-pulse" />
                            )}
                          </div>
                        )}
                        {msg.role === "user" && msg.hasScreenshot && (
                          <div
                            className={`flex items-center gap-1 text-[10px] opacity-70 mb-1 border-b pb-1 ${isLightTheme ? "border-black/10" : "border-white/10"}`}
                          >
                            <Image className="w-2.5 h-2.5" />
                            <span>Screenshot attached</span>
                          </div>
                        )}
                        {msg.role === "system" && !msg.isStreaming && (
                          <button
                            onClick={() => handleCopy(msg.text)}
                            className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                            title="Copy to clipboard"
                            style={appearance.iconStyle}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {renderMessageText(msg)}
                        {msg.role === "system" &&
                          msg.modelUsed &&
                          !msg.isStreaming && (
                            <div
                              className="flex items-center gap-2 mt-2 pt-1.5 text-[11px] font-medium overlay-text-secondary border-t"
                              style={{ borderColor: "inherit", opacity: 0.9 }}
                            >
                              <span className="flex items-center gap-1.5">
                                <Sparkles className="w-3 h-3" />
                                {msg.modelUsed}
                                {msg.serviceTierFallback
                                  ? " · Standard fallback"
                                  : msg.serviceTierUsed === "fast"
                                    ? " · Fast"
                                    : ""}
                              </span>
                              {msg.durationMs != null ? (
                                <span className="tabular-nums">
                                  {formatDuration(msg.durationMs)}
                                </span>
                              ) : null}
                              {msg.tokensUsed != null ? (
                                <span className="tabular-nums">
                                  {msg.tokensUsed} tok
                                </span>
                              ) : null}
                            </div>
                          )}
                      </div>
                    </div>
                  ))}

                  {/* Active Recording State with Live Transcription */}
                  {isManualRecording && (
                    <div className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      {/* Live transcription preview */}
                      {(manualTranscript || voiceInput) && (
                        <div className="max-w-[85%] px-3.5 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-[18px] rounded-tr-[4px]">
                          <span className="text-[13px] text-emerald-300">
                            {voiceInput}
                            {voiceInput && manualTranscript ? " " : ""}
                            {manualTranscript}
                          </span>
                        </div>
                      )}
                      <div className="px-3 py-2 flex gap-1.5 items-center">
                        <div
                          className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <div
                          className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce"
                          style={{ animationDelay: "150ms" }}
                        />
                        <div
                          className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce"
                          style={{ animationDelay: "300ms" }}
                        />
                        <span className="text-[10px] text-emerald-400/70 ml-1">
                          Listening...
                        </span>
                      </div>
                    </div>
                  )}

                  {isProcessing && (
                    <div className="flex justify-start">
                      <div className="px-3 py-2 flex gap-1.5">
                        <div
                          className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <div
                          className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                          style={{ animationDelay: "150ms" }}
                        />
                        <div
                          className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                          style={{ animationDelay: "300ms" }}
                        />
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
              {messages.length === 0 && !isManualRecording && !isProcessing && (
                <div className="h-full min-h-[72px]" />
              )}
              </div>

              <div
                data-testid="natively-command-dock"
                className="sticky bottom-0 shrink-0 min-h-[88px] max-h-[148px] overflow-y-auto border-t no-drag overlay-shell-surface z-20"
                style={{
                  ...appearance.shellStyle,
                  borderLeft: "none",
                  borderRight: "none",
                  borderBottom: "none",
                  borderRadius: 0,
                  boxShadow: isLightTheme
                    ? "0 -12px 24px rgba(148, 163, 184, 0.14)"
                    : "0 -12px 24px rgba(2, 6, 23, 0.28)",
                }}
              >
              {/* Input Area */}
              <div className="px-3 py-2">
                {/* Latent Context Preview (Attached Screenshot) */}
                {attachedContext.length > 0 && (
                  <div
                    data-testid="natively-attached-screenshot-strip"
                    className={`mb-1.5 min-h-[34px] rounded-lg px-2 py-1.5 transition-all duration-200 border ${subtleSurfaceClass}`}
                    style={appearance.subtleStyle}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 text-[10.5px] font-medium overlay-text-primary">
                        {attachedContext.length} screenshot
                        {attachedContext.length > 1 ? "s" : ""} attached
                      </span>
                      <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-x-auto">
                        {attachedContext.map((ctx, idx) => (
                          <div
                            key={ctx.path}
                            className="relative group/thumb flex-shrink-0"
                          >
                            <img
                              src={ctx.preview}
                              alt={`Screenshot ${idx + 1}`}
                              className={`h-7 w-auto rounded border ${isLightTheme ? "border-black/15" : "border-white/20"}`}
                            />
                            <button
                              onClick={() =>
                                setAttachedContext((prev) =>
                                  prev.filter((_, i) => i !== idx),
                                )
                              }
                              className="absolute -top-1 -right-1 w-4 h-4 bg-red-500/80 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 focus:opacity-100 transition-opacity"
                              title="Remove"
                            >
                              <X className="w-2.5 h-2.5 text-white" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => setAttachedContext([])}
                        className="shrink-0 p-1 rounded-full transition-colors overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                        title="Remove all"
                        style={appearance.iconStyle}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                <div className="relative group">
                  <input
                    ref={textInputRef}
                    data-testid="natively-command-input"
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleManualSubmit()}
                    className={`w-full border focus:ring-1 rounded-xl pl-3 pr-10 py-2 focus:outline-none transition-all duration-200 ease-sculpted text-[13px] leading-relaxed ${inputClass}`}
                    style={appearance.inputStyle}
                  />
                  <button
                    data-testid="natively-command-send"
                    onClick={handleManualSubmit}
                    disabled={!inputValue.trim() && attachedContext.length === 0}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center transition-all active:scale-95 ${
                      inputValue.trim() || attachedContext.length > 0
                        ? "bg-[#007AFF] text-white shadow-sm shadow-blue-500/20 hover:bg-[#0071E3]"
                        : "overlay-icon-surface overlay-text-muted cursor-not-allowed"
                    }`}
                    style={inputValue.trim() || attachedContext.length > 0 ? undefined : appearance.iconStyle}
                    title="Send"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  {/* Custom Rich Placeholder */}
                  {!inputValue && (
                    <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none text-[13px] overlay-text-muted overflow-hidden">
                      <span className="truncate">
                        Ask anything on screen or conversation
                      </span>
                      <div className="hidden sm:flex items-center gap-1 opacity-80 shrink-0">
                        <span className="text-[11px] opacity-70">or</span>
                        {(
                          shortcuts.selectiveScreenshot || ["⌘", "Shift", "H"]
                        ).map((key, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && <span className="text-[10px]">+</span>}
                            <kbd
                              className="px-1.5 py-0.5 rounded border text-[10px] font-sans min-w-[20px] text-center overlay-control-surface overlay-text-secondary"
                              style={appearance.controlStyle}
                            >
                              {key}
                            </kbd>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  )}

                </div>

                {/* Quick Actions - pinned below input so typing never disappears */}
                <div
                  className="flex flex-nowrap justify-start items-center gap-1.5 overflow-x-auto mt-1.5 pb-0.5"
                  style={{ scrollbarWidth: "none" }}
                >
                  <button
                    data-testid="natively-action-what-to-answer"
                    onClick={handleWhatToSay}
                    disabled={!!actionLoading.whatToSay}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`}
                    style={appearance.chipStyle}
                  >
                    {actionLoading.whatToSay ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Pencil className="w-3 h-3 opacity-70" />
                    )}
                    <span>What to say</span>
                  </button>
                  <button
                    data-testid="natively-action-clarify"
                    onClick={handleClarify}
                    disabled={!!actionLoading.clarify}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`}
                    style={appearance.chipStyle}
                  >
                    {actionLoading.clarify ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <MessageSquare className="w-3 h-3 opacity-70" />
                    )}
                    <span>Clarify</span>
                  </button>
                  <button
                    data-testid="natively-action-dynamic"
                    onClick={
                      actionButtonMode === "brainstorm"
                        ? handleBrainstorm
                        : handleRecap
                    }
                    disabled={
                      actionButtonMode === "brainstorm"
                        ? !!actionLoading.brainstorm
                        : !!actionLoading.recap
                    }
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`}
                    style={appearance.chipStyle}
                  >
                    {actionButtonMode === "brainstorm" ? (
                      <>
                        {actionLoading.brainstorm ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lightbulb className="w-3 h-3 opacity-70" />
                        )}{" "}
                        <span>Brainstorm</span>
                      </>
                    ) : (
                      <>
                        {actionLoading.recap ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3 h-3 opacity-70" />
                        )}{" "}
                        <span>Recap</span>
                      </>
                    )}
                  </button>
                  <button
                    data-testid="natively-action-follow-up"
                    onClick={handleFollowUpQuestions}
                    disabled={!!actionLoading.followUpQuestions}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`}
                    style={appearance.chipStyle}
                  >
                    {actionLoading.followUpQuestions ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <HelpCircle className="w-3 h-3 opacity-70" />
                    )}
                    <span>Follow Up</span>
                  </button>
                  <button
                    data-testid="natively-action-agentic-toggle"
                    onClick={handleAgenticModeToggle}
                    aria-pressed={isAgenticModeEnabled}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${
                      isAgenticModeEnabled
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/15"
                        : quickActionClass
                    }`}
                    style={
                      isAgenticModeEnabled ? undefined : appearance.chipStyle
                    }
                    title="Toggle agentic answers"
                  >
                    <Sparkles className="w-3 h-3 opacity-80" />
                    <span>{isAgenticModeEnabled ? "Agent On" : "Agent Off"}</span>
                  </button>
                  <button
                    data-testid="natively-action-speaker-separation-toggle"
                    onClick={handleSpeakerSeparationToggle}
                    aria-pressed={isSpeakerSeparationEnabled}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${
                      isSpeakerSeparationEnabled
                        ? "bg-sky-500/10 text-sky-400 border-sky-500/25 hover:bg-sky-500/15"
                        : quickActionClass
                    }`}
                    style={
                      isSpeakerSeparationEnabled ? undefined : appearance.chipStyle
                    }
                    title="Toggle live speaker split"
                  >
                    <Users className="w-3 h-3 opacity-80" />
                    <span>{isSpeakerSeparationEnabled ? "Split On" : "Split Off"}</span>
                  </button>
                  {isProcessing && (
                    <button
                      data-testid="natively-action-stop-generation"
                      onClick={cancelActiveWork}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 bg-red-500/10 text-red-400 ring-1 ring-red-500/20 hover:bg-red-500/15"
                      title="Stop current response"
                    >
                      <CircleSlash className="w-3 h-3 opacity-80" />
                      <span>Stop</span>
                    </button>
                  )}
                  <button
                    data-testid="natively-action-answer"
                    onClick={handleAnswerNow}
                    className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium transition-all active:scale-95 duration-200 interaction-base interaction-press min-w-[68px] whitespace-nowrap shrink-0 ${
                      isManualRecording
                        ? "bg-red-500/10 text-red-400 ring-1 ring-red-500/20"
                        : "overlay-chip-surface overlay-text-interactive hover:text-emerald-500 hover:bg-emerald-500/10"
                    }`}
                    style={isManualRecording ? undefined : appearance.chipStyle}
                  >
                    {isManualRecording ? (
                      <>
                        <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                        Stop
                      </>
                    ) : (
                      <>
                        <Zap className="w-3 h-3 opacity-70" /> Answer
                      </>
                    )}
                  </button>
                  {isConversationFocusMode && (
                    <button
                      data-testid="natively-action-tools"
                      onClick={() => setIsCommandToolsOpen((prev) => !prev)}
                      className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10.5px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`}
                      style={appearance.chipStyle}
                      title={
                        isCommandToolsOpen
                          ? "Hide model and settings controls"
                          : "Show model and settings controls"
                      }
                    >
                      <SlidersHorizontal className="w-3 h-3 opacity-70" />
                      <span>{isCommandToolsOpen ? "Hide tools" : "Tools"}</span>
                    </button>
                  )}
                </div>

                {/* Bottom Row */}
                {(!isConversationFocusMode || isCommandToolsOpen) && (
                <div
                  data-testid="natively-secondary-controls"
                  className="flex items-center justify-between mt-1.5 px-0.5"
                >
                  <div className="flex items-center gap-1.5">
                    <ModelSelector
                      currentModel={currentModel}
                      onSelectModel={handleModelSelect}
                      placement="top"
                    />

                    <div
                      className="w-px h-3 mx-1"
                      style={appearance.dividerStyle}
                    />

                    {/* Project Context Badge */}
                    <ProjectBadge
                      active={activeProject}
                      onOpen={() => setIsProjectPickerOpen(true)}
                      onClear={() => setActiveProject(null)}
                    />

                    {/* Mode Selector */}
                    <div className="relative" ref={modeRef}>
                      <button
                        onClick={() => {
                          setIsModeOpen(!isModeOpen);
                          setIsLangOpen(false);
                        }}
                        className={`
                                                    flex items-center gap-1 px-2.5 py-1.5
                                                    border rounded-lg transition-colors
                                                    text-[11px] font-medium max-w-[110px]
                                                    interaction-base interaction-press whitespace-nowrap
                                                    ${controlSurfaceClass}
                                                    ${activeModeLabel ? "text-accent-primary" : "text-text-secondary"}
                                                `}
                        style={appearance.controlStyle}
                        title="Switch context mode"
                      >
                        <Sparkles className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          {activeModeLabel || "Mode"}
                        </span>
                        <ChevronDown size={10} className="shrink-0" />
                      </button>
                      {isModeOpen && (
                        <div className="absolute bottom-full left-0 mb-1 min-w-[200px] max-w-[280px] bg-bg-elevated border border-border-subtle rounded-xl shadow-xl overflow-hidden z-50 p-1 animated fadeIn select-none">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary px-2 py-1.5">
                            Context Mode
                          </div>
                          <div className="max-h-[160px] overflow-y-auto">
                            <button
                              onClick={() => handleSetActiveMode(null)}
                              className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] flex items-center gap-2 transition-colors ${!activeModeLabel ? "text-accent-primary bg-accent-primary/10" : "text-text-secondary hover:bg-bg-input hover:text-text-primary"}`}
                            >
                              <span className="w-2 h-2 rounded-full border border-current" />
                              No mode (default)
                            </button>
                            {availableModes.map((m) => (
                              <button
                                key={m.id}
                                onClick={() => handleSetActiveMode(m.id)}
                                className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] flex items-center gap-2 transition-colors ${activeModeLabel === m.name ? "text-accent-primary bg-accent-primary/10" : "text-text-secondary hover:bg-bg-input hover:text-text-primary"}`}
                              >
                                {activeModeLabel === m.name ? (
                                  <Check className="w-3 h-3 text-accent-primary shrink-0" />
                                ) : (
                                  <span className="w-3 h-3 rounded-full border border-current opacity-30 shrink-0" />
                                )}
                                <span className="truncate">{m.name}</span>
                                <span className="text-[10px] text-text-tertiary ml-auto shrink-0">
                                  {m.templateType}
                                </span>
                              </button>
                            ))}
                          </div>
                          {activeModeLabel && (
                            <div className="border-t border-border-subtle mt-1 pt-1.5 px-1.5">
                              <input
                                type="text"
                                placeholder="Add context notes for this mode..."
                                className="w-full bg-bg-input border border-border-subtle rounded-md px-2 py-1 text-[11px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-primary"
                                onKeyDown={async (e) => {
                                  if (e.key === "Enter") {
                                    const val = (
                                      e.target as HTMLInputElement
                                    ).value.trim();
                                    if (!val) return;
                                    try {
                                      const mode = availableModes.find(
                                        (m) => m.name === activeModeLabel,
                                      );
                                      if (mode) {
                                        await window.electronAPI?.modesUpdate(
                                          mode.id,
                                          { customContext: val },
                                        );
                                        (e.target as HTMLInputElement).value =
                                          "";
                                      }
                                    } catch {}
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Language Selector */}
                    <div className="relative" ref={langRef}>
                      <button
                        onClick={() => {
                          setIsLangOpen(!isLangOpen);
                          setIsModeOpen(false);
                        }}
                        className={`
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    text-text-secondary hover:text-text-primary
                                                    transition-colors
                                                    ${isLangOpen ? "bg-bg-input text-text-primary" : ""}
                                                `}
                        title={`AI response language: ${aiLang}`}
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </button>
                      {isLangOpen && (
                        <div className="absolute bottom-full left-0 mb-1 min-w-[130px] bg-bg-elevated border border-border-subtle rounded-xl shadow-xl overflow-hidden z-50 p-1 animated fadeIn select-none">
                          {LANG_OPTIONS.map((opt) => (
                            <button
                              key={opt.code}
                              onClick={() => handleSetLanguage(opt.code)}
                              className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12px] flex items-center gap-2 transition-colors ${aiLang === opt.code ? "text-accent-primary bg-accent-primary/10" : "text-text-secondary hover:bg-bg-input hover:text-text-primary"}`}
                            >
                              <span className="flex-1">{opt.label}</span>
                              {aiLang === opt.code && (
                                <Check className="w-3 h-3 text-accent-primary shrink-0" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div
                      className="w-px h-3 mx-0.5"
                      style={appearance.dividerStyle}
                    />

                    <div className="relative">
                      <button
                        onClick={(e) => {
                          if (isSettingsOpen) {
                            // If open, just close it (toggle will handle logic but we can be explicit or just toggle)
                            // Actually toggle-settings-window handles hiding if visible, so logic is same.
                            window.electronAPI.toggleSettingsWindow();
                            return;
                          }

                          if (!contentRef.current) return;

                          const contentRect =
                            contentRef.current.getBoundingClientRect();
                          const buttonRect =
                            e.currentTarget.getBoundingClientRect();
                          const POPUP_WIDTH = 270; // Matches SettingsWindowHelper actual width
                          const GAP = 8; // Same gap as between TopPill and main body (gap-2 = 8px)

                          // X: Left-aligned relative to the Settings Button
                          const x = window.screenX + buttonRect.left;

                          // Y: Below the main content + gap
                          const y = window.screenY + contentRect.bottom + GAP;

                          window.electronAPI.toggleSettingsWindow({ x, y });
                        }}
                        className={`
                                            w-7 h-7 flex items-center justify-center rounded-lg
                                            interaction-base interaction-press
                                            ${
                                              isSettingsOpen
                                                ? "overlay-icon-surface overlay-icon-surface-hover overlay-text-primary"
                                                : "overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                                            }
                                        `}
                        style={appearance.iconStyle}
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Mouse Passthrough Toggle */}
                    <div className="relative">
                      <button
                        onClick={() => {
                          const newState = !isMousePassthrough;
                          setIsMousePassthrough(newState);
                          window.electronAPI?.setOverlayMousePassthrough?.(
                            newState,
                          );
                        }}
                        className={`
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    interaction-base interaction-press
                                                    ${
                                                      isMousePassthrough
                                                        ? "overlay-icon-surface overlay-icon-surface-hover text-sky-400 opacity-100"
                                                        : "overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                                                    }
                                                `}
                        style={appearance.iconStyle}
                      >
                        <PointerOff className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                </div>
                )}
              </div>
              </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Project Picker modal */}
      <ProjectPicker
        isOpen={isProjectPickerOpen}
        onClose={() => setIsProjectPickerOpen(false)}
        onManageInSettings={() => {
          window.electronAPI?.openSettingsTab?.('project-context');
        }}
      />
    </div>
  );
};

export default NativelyInterface;
