/**
 * CodexAccountManager.ts
 *
 * Gestion du pool de comptes Codex OAuth.
 * CRUD, persistence via CredentialsManager, proactive token refresh.
 */

import type { CodexAccount, CodexMultiAuthSettings } from "../types/codex-multi-auth";
import { DEFAULT_CODEX_SETTINGS } from "../types/codex-multi-auth";
import { CredentialsManager } from "./CredentialsManager";
import { refreshAccessToken } from "./CodexOAuthFlow";

const TOKEN_REFRESH_INTERVAL_MS = 60 * 1000;

export class CodexAccountManager {
  private static instance: CodexAccountManager;
  private cm: CredentialsManager;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;

  private constructor() {
    this.cm = CredentialsManager.getInstance();
    this.startAutoRefresh();
  }

  public static getInstance(): CodexAccountManager {
    if (!CodexAccountManager.instance) {
      CodexAccountManager.instance = new CodexAccountManager();
    }
    return CodexAccountManager.instance;
  }

  // =========================================================================
  // CRUD
  // =========================================================================

  public getAccounts(): CodexAccount[] {
    return this.cm.getCodexAccounts();
  }

  public getEnabledAccounts(): CodexAccount[] {
    return this.getAccounts().filter((a) => a.enabled);
  }

  public getAccount(alias: string): CodexAccount | undefined {
    return this.getAccounts().find((a) => a.alias === alias);
  }

  public addAccount(alias: string, partial: Omit<CodexAccount, "alias" | "consecutiveErrors" | "requestCount">): CodexAccount {
    const accounts = this.getAccounts();
    if (accounts.some((a) => a.alias === alias)) {
      throw new Error(`Account alias '${alias}' already exists`);
    }

    const newAccount: CodexAccount = {
      ...partial,
      alias,
      enabled: true,
      consecutiveErrors: 0,
      requestCount: 0,
      weight: partial.weight ?? 1.0,
    };

    accounts.push(newAccount);
    this.cm.setCodexAccounts(accounts);
    console.log(`[CodexAccountManager] Added account: ${alias}`);
    return newAccount;
  }

  public removeAccount(alias: string): boolean {
    const accounts = this.getAccounts();
    const idx = accounts.findIndex((a) => a.alias === alias);
    if (idx === -1) return false;

    accounts.splice(idx, 1);
    this.cm.setCodexAccounts(accounts);
    console.log(`[CodexAccountManager] Removed account: ${alias}`);
    return true;
  }

  public setAccountEnabled(alias: string, enabled: boolean): boolean {
    const accounts = this.getAccounts();
    const account = accounts.find((a) => a.alias === alias);
    if (!account) return false;

    account.enabled = enabled;
    if (!enabled) {
      account.disabledAt = new Date().toISOString();
    } else {
      delete account.disabledAt;
      delete account.disableReason;
    }

    this.cm.setCodexAccounts(accounts);
    if (enabled) this.queueAutoRefresh("account-enabled");
    return true;
  }

  public updateAccount(alias: string, patch: Partial<CodexAccount>): boolean {
    const accounts = this.getAccounts();
    const account = accounts.find((a) => a.alias === alias);
    if (!account) return false;

    Object.assign(account, patch);
    this.cm.setCodexAccounts(accounts);
    return true;
  }

  // =========================================================================
  // Settings
  // =========================================================================

  public getSettings(): CodexMultiAuthSettings {
    return this.cm.getCodexSettings();
  }

  public setSettings(settings: Partial<CodexMultiAuthSettings>): void {
    const current = this.getSettings();
    const merged = { ...current, ...settings };
    this.cm.setCodexSettings(merged);
  }

  // =========================================================================
  // Token Refresh
  // =========================================================================

  /**
   * Refresh token proactively if it expires within the next 5 minutes.
   */
  public async refreshTokenIfNeeded(alias: string): Promise<boolean> {
    const account = this.getAccount(alias);
    if (!account) return false;

    const expiresAt = new Date(account.expiresAt).getTime();
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    if (expiresAt - now > fiveMinutes) {
      return true; // still valid
    }

    console.log(`[CodexAccountManager] Refreshing token for ${alias} (expires in ${Math.round((expiresAt - now) / 1000)}s)`);
    const result = await refreshAccessToken(account.refreshToken);

    if (result.type === "failed") {
      console.error(`[CodexAccountManager] Token refresh failed for ${alias}:`, result.message);
      account.consecutiveErrors += 1;
      account.lastErrorAt = new Date().toISOString();
      this.updateAccount(alias, account);
      return false;
    }

    account.accessToken = result.access;
    account.refreshToken = result.refresh;
    account.expiresAt = new Date(result.expires).toISOString();
    if (result.idToken) account.idToken = result.idToken;
    if (result.scope) account.oauthScope = result.scope;
    account.consecutiveErrors = 0;

    this.updateAccount(alias, account);
    console.log(`[CodexAccountManager] Token refreshed for ${alias}`);
    return true;
  }

  /**
   * Refresh all enabled accounts that are near expiry.
   */
  public async refreshAllTokens(): Promise<void> {
    const accounts = this.getEnabledAccounts();
    for (const account of accounts) {
      await this.refreshTokenIfNeeded(account.alias);
    }
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer) return;

    this.queueAutoRefresh("startup");
    this.refreshTimer = setInterval(() => {
      this.queueAutoRefresh("scheduled");
    }, TOKEN_REFRESH_INTERVAL_MS);

    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  private queueAutoRefresh(reason: string): void {
    if (this.refreshInFlight) return;
    if (this.getEnabledAccounts().length === 0) return;

    this.refreshInFlight = this.refreshAllTokens()
      .catch((error) => {
        console.error(`[CodexAccountManager] Auto token refresh failed (${reason}):`, error);
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  // =========================================================================
  // Re-auth (full OAuth re-login for an existing alias)
  // =========================================================================

  public async reauthAccount(alias: string, newTokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    idToken?: string;
    oauthScope?: string;
  }): Promise<boolean> {
    const account = this.getAccount(alias);
    if (!account) return false;

    account.accessToken = newTokens.accessToken;
    account.refreshToken = newTokens.refreshToken;
    account.expiresAt = newTokens.expiresAt;
    if (newTokens.idToken) account.idToken = newTokens.idToken;
    if (newTokens.oauthScope) account.oauthScope = newTokens.oauthScope;
    account.consecutiveErrors = 0;
    account.lastErrorAt = undefined;
    account.enabled = true;
    delete account.disabledAt;
    delete account.disableReason;

    this.updateAccount(alias, account);
    console.log(`[CodexAccountManager] Re-authed account: ${alias}`);
    return true;
  }

  // =========================================================================
  // Sanitized snapshot (no tokens)
  // =========================================================================

  public getSanitizedAccounts(): Array<Omit<CodexAccount, "accessToken" | "refreshToken" | "idToken">> {
    return this.getAccounts().map((account) => {
      const { accessToken, refreshToken, idToken, ...sanitized } = account;
      return sanitized;
    });
  }
}
