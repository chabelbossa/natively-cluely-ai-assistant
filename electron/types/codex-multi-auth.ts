/**
 * Types pour le système Codex Multi-Auth OAuth
 * Inspiré de oc-codex-multi-auth (ndycode) et opencode-openai-codex-auth (Numman Ali)
 */

// ============================================================================
// OAuth Flow Types
// ============================================================================

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

export interface AuthorizationFlow {
  pkce: PKCEPair;
  state: string;
  url: string;
}

export interface TokenResultSuccess {
  type: "success";
  access: string;
  refresh: string;
  expires: number;
  idToken?: string;
  scope?: string;
}

export interface TokenResultFailed {
  type: "failed";
  reason: string;
  statusCode?: number;
  message?: string;
}

export type TokenResult = TokenResultSuccess | TokenResultFailed;

export interface OAuthServerInfo {
  port: number;
  ready: boolean;
  close: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}

// ============================================================================
// Account Types
// ============================================================================

export interface CodexAccount {
  /** Identifiant unique (alias choisi par l'utilisateur) */
  alias: string;
  /** Email du compte ChatGPT (normalisé lowercase) */
  email: string;
  /** Actif dans la rotation ? */
  enabled: boolean;
  /** Timestamp ISO de désactivation */
  disabledAt?: string;
  /** Raison de la désactivation */
  disableReason?: string;

  // Tokens OAuth
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Timestamp ISO d'expiration du access token */
  expiresAt: string;
  /** Timestamp ISO d'obtention */
  obtainedAt: string;
  /** Scopes OAuth accordés */
  oauthScope?: string;

  // Quota / Health
  rateLimits?: {
    dailyRemaining?: number;
    dailyLimit?: number;
    weeklyRemaining?: number;
    weeklyLimit?: number;
  };
  /** Timestamp ISO du dernier probe de quotas */
  lastLimitProbeAt?: string;
  /** Fraîcheur des données de quota */
  limitStatus?: "fresh" | "stale" | "error" | "unknown";

  // Runtime state (non persisté — reset au restart)
  rateLimitedUntil?: string;
  consecutiveErrors: number;
  lastErrorAt?: string;
  requestCount: number;

  // Load balancing
  weight: number;
}

// ============================================================================
// Settings Types
// ============================================================================

export type CodexRotationStrategy =
  | "round-robin"
  | "least-used"
  | "random"
  | "weighted-round-robin";

export interface CodexMultiAuthSettings {
  rotationStrategy: CodexRotationStrategy;
  /** Force mode : pinner un compte spécifique */
  forcedAlias?: string;
  /** TTL du force mode (timestamp ISO) */
  forcedUntil?: string;
  /** Stratégie précédente pour restore après force mode */
  previousStrategy?: CodexRotationStrategy;
  /** % quota restant avant exclusion (default 10) */
  criticalThreshold: number;
  /** % quota restant avant warning (default 25) */
  lowThreshold: number;
}

export const DEFAULT_CODEX_SETTINGS: CodexMultiAuthSettings = {
  rotationStrategy: "round-robin",
  criticalThreshold: 10,
  lowThreshold: 25,
};

// ============================================================================
// Router / Selection Types
// ============================================================================

export interface AccountSelectionResult {
  account: CodexAccount;
  reason: string;
  forced: boolean;
}

export interface CodexHealthReport {
  totalAccounts: number;
  enabledAccounts: number;
  healthyAccounts: number;
  rateLimitedAccounts: number;
  coolingDownAccounts: number;
  forcedAlias?: string;
  currentStrategy: CodexRotationStrategy;
  accounts: Array<{
    alias: string;
    email: string;
    enabled: boolean;
    eligible: boolean;
    healthScore: number;
    requestCount: number;
    rateLimitedUntil?: string;
    cooldownReason?: string;
    limitStatus?: string;
  }>;
}

// ============================================================================
// API Responses Types
// ============================================================================

export interface CodexResponsesRequest {
  model: string;
  input: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  stream?: boolean;
  store?: boolean;
  reasoning?: {
    effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  };
}

// ============================================================================
// IPC Types (Renderer → Main)
// ============================================================================

export interface CodexAuthStartResult {
  success: boolean;
  flow?: AuthorizationFlow;
  error?: string;
}

export interface CodexAuthCallbackResult {
  success: boolean;
  account?: Omit<CodexAccount, "accessToken" | "refreshToken" | "idToken">;
  error?: string;
}

export interface CodexAccountsListResult {
  success: boolean;
  accounts?: Array<
    Omit<CodexAccount, "accessToken" | "refreshToken" | "idToken">
  >;
  error?: string;
}
