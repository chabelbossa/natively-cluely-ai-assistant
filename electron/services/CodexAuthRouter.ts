/**
 * CodexAuthRouter.ts
 *
 * Moteur de rotation multi-comptes Codex.
 * Sélection health-aware, gestion des cooldowns, force mode, load balancing.
 * Inspiré de lib/rotation.ts et lib/accounts/state.ts (oc-codex-multi-auth).
 */

import type { CodexAccount, CodexMultiAuthSettings, CodexRotationStrategy, AccountSelectionResult, CodexHealthReport } from "../types/codex-multi-auth";
import { DEFAULT_CODEX_SETTINGS } from "../types/codex-multi-auth";
import { CodexAccountManager } from "./CodexAccountManager";

export interface RouterErrorResult {
  type: "rate-limit" | "auth-failure" | "server-error" | "network-error" | "all-exhausted";
  message: string;
  alias?: string;
  retryAfterMs?: number;
}

export class CodexAuthRouter {
  private accountManager: CodexAccountManager;
  private settings: CodexMultiAuthSettings;
  private currentRoundRobinIndex = 0;
  private healthScores: Map<string, { score: number; lastUpdated: number; consecutiveFailures: number }> = new Map();

  // Health scoring config (inspired by oc-codex-multi-auth rotation.ts)
  private readonly HEALTH_CONFIG = {
    successDelta: 1,
    rateLimitDelta: -10,
    failureDelta: -20,
    maxScore: 100,
    minScore: 0,
    passiveRecoveryPerHour: 2,
  };

  constructor() {
    this.accountManager = CodexAccountManager.getInstance();
    this.settings = this.accountManager.getSettings();
  }

  private reloadSettings(): void {
    this.settings = this.accountManager.getSettings();
  }

  // =========================================================================
  // Eligibility
  // =========================================================================

  /**
   * Check if an account is eligible for selection right now.
   */
  public isEligible(account: CodexAccount): boolean {
    if (!account.enabled) return false;
    if (account.consecutiveErrors >= 3) return false;

    // Check rate limit cooldown
    if (account.rateLimitedUntil) {
      const until = new Date(account.rateLimitedUntil).getTime();
      if (Date.now() < until) return false;
    }

    // Check token expiry (within 1 min grace)
    const expiresAt = new Date(account.expiresAt).getTime();
    if (Date.now() > expiresAt - 60_000) return false;

    return true;
  }

  public getEligibleAccounts(): CodexAccount[] {
    return this.accountManager.getEnabledAccounts().filter((a) => this.isEligible(a));
  }

  // =========================================================================
  // Account Selection
  // =========================================================================

  public selectAccount(): AccountSelectionResult | null {
    this.reloadSettings();

    // Force mode
    if (this.settings.forcedAlias && this.settings.forcedUntil) {
      const forcedUntil = new Date(this.settings.forcedUntil).getTime();
      if (Date.now() < forcedUntil) {
        const forced = this.accountManager.getAccount(this.settings.forcedAlias);
        if (forced && this.isEligible(forced)) {
          return { account: forced, reason: "force-mode", forced: true };
        }
        // Force mode active but account ineligible → fail hard (no silent fallback)
        return null;
      } else {
        // Force mode expired → auto-clear
        this.clearForceMode();
      }
    }

    const eligible = this.getEligibleAccounts();
    if (eligible.length === 0) return null;

    const strategy = this.settings.rotationStrategy;
    let selected: CodexAccount;

    switch (strategy) {
      case "round-robin":
        selected = this.selectRoundRobin(eligible);
        break;
      case "least-used":
        selected = this.selectLeastUsed(eligible);
        break;
      case "random":
        selected = this.selectRandom(eligible);
        break;
      case "weighted-round-robin":
        selected = this.selectWeightedRoundRobin(eligible);
        break;
      default:
        selected = this.selectRoundRobin(eligible);
    }

    // Increment request count
    selected.requestCount += 1;
    this.accountManager.updateAccount(selected.alias, { requestCount: selected.requestCount });

    return { account: selected, reason: strategy, forced: false };
  }

  private selectRoundRobin(accounts: CodexAccount[]): CodexAccount {
    const idx = this.currentRoundRobinIndex % accounts.length;
    this.currentRoundRobinIndex = (this.currentRoundRobinIndex + 1) % accounts.length;
    return accounts[idx];
  }

  private selectLeastUsed(accounts: CodexAccount[]): CodexAccount {
    return accounts.reduce((best, current) =>
      current.requestCount < best.requestCount ? current : best
    );
  }

  private selectRandom(accounts: CodexAccount[]): CodexAccount {
    const idx = Math.floor(Math.random() * accounts.length);
    return accounts[idx];
  }

  private selectWeightedRoundRobin(accounts: CodexAccount[]): CodexAccount {
    const totalWeight = accounts.reduce((sum, a) => sum + (a.weight || 1), 0);
    let random = Math.random() * totalWeight;
    for (const account of accounts) {
      random -= account.weight || 1;
      if (random <= 0) return account;
    }
    return accounts[accounts.length - 1];
  }

  // =========================================================================
  // Force Mode
  // =========================================================================

  public setForceMode(alias: string, ttlHours = 24): boolean {
    const account = this.accountManager.getAccount(alias);
    if (!account || !account.enabled) return false;

    const previousStrategy = this.settings.rotationStrategy;
    const forcedUntil = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    this.accountManager.setSettings({
      forcedAlias: alias,
      forcedUntil,
      previousStrategy,
    });
    console.log(`[CodexAuthRouter] Force mode activated: ${alias} for ${ttlHours}h`);
    return true;
  }

  public clearForceMode(): void {
    const previous = this.settings.previousStrategy;
    this.accountManager.setSettings({
      forcedAlias: undefined,
      forcedUntil: undefined,
      previousStrategy: undefined,
      ...(previous ? { rotationStrategy: previous } : {}),
    });
    console.log("[CodexAuthRouter] Force mode cleared");
  }

  // =========================================================================
  // Post-Request Health Tracking
  // =========================================================================

  public recordSuccess(alias: string): void {
    const entry = this.getHealthEntry(alias);
    const hoursSinceUpdate = (Date.now() - entry.lastUpdated) / (1000 * 60 * 60);
    const recovery = hoursSinceUpdate * this.HEALTH_CONFIG.passiveRecoveryPerHour;
    const baseScore = Math.min(entry.score + recovery, this.HEALTH_CONFIG.maxScore);
    const newScore = Math.min(baseScore + this.HEALTH_CONFIG.successDelta, this.HEALTH_CONFIG.maxScore);

    this.healthScores.set(alias, {
      score: newScore,
      lastUpdated: Date.now(),
      consecutiveFailures: 0,
    });

    this.accountManager.updateAccount(alias, {
      consecutiveErrors: 0,
      lastErrorAt: undefined,
    });
  }

  public recordRateLimit(alias: string, retryAfterMs?: number): void {
    const entry = this.getHealthEntry(alias);
    const hoursSinceUpdate = (Date.now() - entry.lastUpdated) / (1000 * 60 * 60);
    const recovery = hoursSinceUpdate * this.HEALTH_CONFIG.passiveRecoveryPerHour;
    const baseScore = Math.min(entry.score + recovery, this.HEALTH_CONFIG.maxScore);
    const newScore = Math.max(baseScore + this.HEALTH_CONFIG.rateLimitDelta, this.HEALTH_CONFIG.minScore);

    this.healthScores.set(alias, {
      score: newScore,
      lastUpdated: Date.now(),
      consecutiveFailures: entry.consecutiveFailures + 1,
    });

    const rateLimitedUntil = retryAfterMs
      ? new Date(Date.now() + retryAfterMs).toISOString()
      : new Date(Date.now() + 60_000).toISOString();

    this.accountManager.updateAccount(alias, {
      rateLimitedUntil,
      consecutiveErrors: entry.consecutiveFailures + 1,
      lastErrorAt: new Date().toISOString(),
    });
  }

  public recordAuthFailure(alias: string): void {
    const entry = this.getHealthEntry(alias);
    const hoursSinceUpdate = (Date.now() - entry.lastUpdated) / (1000 * 60 * 60);
    const recovery = hoursSinceUpdate * this.HEALTH_CONFIG.passiveRecoveryPerHour;
    const baseScore = Math.min(entry.score + recovery, this.HEALTH_CONFIG.maxScore);
    const newScore = Math.max(baseScore + this.HEALTH_CONFIG.failureDelta, this.HEALTH_CONFIG.minScore);

    this.healthScores.set(alias, {
      score: newScore,
      lastUpdated: Date.now(),
      consecutiveFailures: entry.consecutiveFailures + 1,
    });

    // Flag account as disabled after 3 consecutive auth failures
    const newErrors = entry.consecutiveFailures + 1;
    const update: Partial<CodexAccount> = {
      consecutiveErrors: newErrors,
      lastErrorAt: new Date().toISOString(),
    };
    if (newErrors >= 3) {
      update.enabled = false;
      update.disableReason = "Too many consecutive auth failures — re-auth required";
    }
    this.accountManager.updateAccount(alias, update);
  }

  public recordServerError(alias: string): void {
    this.recordAuthFailure(alias); // same scoring as auth failure for now
  }

  public recordNetworkError(alias: string): void {
    // Network errors are transient — don't penalize as harshly
    const entry = this.getHealthEntry(alias);
    this.healthScores.set(alias, {
      score: Math.max(entry.score - 5, this.HEALTH_CONFIG.minScore),
      lastUpdated: Date.now(),
      consecutiveFailures: entry.consecutiveFailures + 1,
    });
  }

  private getHealthEntry(alias: string): { score: number; lastUpdated: number; consecutiveFailures: number } {
    return this.healthScores.get(alias) ?? {
      score: this.HEALTH_CONFIG.maxScore,
      lastUpdated: Date.now(),
      consecutiveFailures: 0,
    };
  }

  // =========================================================================
  // Quota Probing
  // =========================================================================

  /**
   * Parse rate-limit headers from a response and update account limits.
   * Never overwrites valid limits with error data.
   */
  public updateLimitsFromHeaders(alias: string, headers: Headers): void {
    const dailyRemaining = headers.get("x-ratelimit-remaining-requests");
    const dailyLimit = headers.get("x-ratelimit-limit-requests");

    const rateLimits: CodexAccount["rateLimits"] = {};
    if (dailyRemaining) rateLimits.dailyRemaining = parseInt(dailyRemaining, 10);
    if (dailyLimit) rateLimits.dailyLimit = parseInt(dailyLimit, 10);

    this.accountManager.updateAccount(alias, {
      rateLimits,
      lastLimitProbeAt: new Date().toISOString(),
      limitStatus: "fresh",
    });
  }

  // =========================================================================
  // Health Report
  // =========================================================================

  public getHealthReport(): CodexHealthReport {
    const accounts = this.accountManager.getAccounts();
    const enabled = accounts.filter((a) => a.enabled);
    const eligible = enabled.filter((a) => this.isEligible(a));
    const rateLimited = enabled.filter((a) => a.rateLimitedUntil && new Date(a.rateLimitedUntil).getTime() > Date.now());
    const coolingDown = enabled.filter((a) => !this.isEligible(a) && !rateLimited.includes(a));

    return {
      totalAccounts: accounts.length,
      enabledAccounts: enabled.length,
      healthyAccounts: eligible.length,
      rateLimitedAccounts: rateLimited.length,
      coolingDownAccounts: coolingDown.length,
      forcedAlias: this.settings.forcedAlias,
      currentStrategy: this.settings.rotationStrategy,
      accounts: accounts.map((a) => {
        const health = this.getHealthEntry(a.alias);
        return {
          alias: a.alias,
          email: a.email,
          enabled: a.enabled,
          eligible: this.isEligible(a),
          healthScore: Math.round(health.score),
          requestCount: a.requestCount,
          rateLimitedUntil: a.rateLimitedUntil,
          cooldownReason: a.rateLimitedUntil ? "rate-limited" : a.consecutiveErrors >= 3 ? "auth-failures" : undefined,
          limitStatus: a.limitStatus ?? "unknown",
        };
      }),
    };
  }
}
