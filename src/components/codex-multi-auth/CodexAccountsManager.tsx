/**
 * CodexAccountsManager.tsx
 *
 * UI de gestion des comptes Codex OAuth (ChatGPT Plus/Pro).
 * Theme-aware — compatible clair et sombre.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Power,
  PowerOff,
  AlertTriangle,
  CheckCircle,
  Activity,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";

interface CodexAccountUI {
  alias: string;
  email: string;
  enabled: boolean;
  weight: number;
  requestCount: number;
  healthScore?: number;
  eligible?: boolean;
  rateLimitedUntil?: string;
  limitStatus?: string;
  rateLimits?: {
    dailyRemaining?: number;
    dailyLimit?: number;
    weeklyRemaining?: number;
    weeklyLimit?: number;
  };
}

interface CodexSettingsUI {
  rotationStrategy: string;
  forcedAlias?: string;
  criticalThreshold: number;
  lowThreshold: number;
}

export const CodexAccountsManager: React.FC = () => {
  const [accounts, setAccounts] = useState<CodexAccountUI[]>([]);
  const [settings, setSettings] = useState<CodexSettingsUI | null>(null);
  const [loading, setLoading] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const result = await window.electronAPI?.codexAccountsList?.();
      if (result?.success && result.accounts) {
        setAccounts(result.accounts as CodexAccountUI[]);
      }
      const settingsResult = await window.electronAPI?.codexGetSettings?.();
      if (settingsResult?.success && settingsResult.settings) {
        setSettings(settingsResult.settings as CodexSettingsUI);
      }
    } catch (e) {
      console.error("Failed to load Codex accounts:", e);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 5000);
    return () => clearInterval(interval);
  }, [loadAccounts]);

  const handleAddAccount = async () => {
    if (!newAlias.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.codexAuthAddAccount?.(newAlias.trim());
      if (result?.success) {
        setNewAlias("");
        setShowAddModal(false);
        await loadAccounts();
      } else {
        setError(result?.error || "Failed to add account");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async (alias: string, enabled: boolean) => {
    try {
      await window.electronAPI?.codexAccountSetEnabled?.(alias, !enabled);
      await loadAccounts();
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemove = async (alias: string) => {
    if (!confirm(`Remove account "${alias}"?`)) return;
    try {
      await window.electronAPI?.codexAccountRemove?.(alias);
      await loadAccounts();
    } catch (e) {
      console.error(e);
    }
  };

  const handleReauth = async (alias: string) => {
    setLoading(true);
    try {
      const result = await window.electronAPI?.codexAccountReauth?.(alias);
      if (result?.success) {
        await loadAccounts();
      } else {
        setError(result?.error || "Re-auth failed");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSetStrategy = async (strategy: string) => {
    try {
      await window.electronAPI?.codexSetStrategy?.(strategy);
      await loadAccounts();
    } catch (e) {
      console.error(e);
    }
  };

  const formatStatus = (account: CodexAccountUI) => {
    if (!account.enabled) return { label: "Disabled", color: "text-gray-500", icon: <PowerOff size={14} /> };
    if (account.rateLimitedUntil) return { label: "Rate Limited", color: "text-amber-500", icon: <AlertTriangle size={14} /> };
    if (!account.eligible) return { label: "Cooling Down", color: "text-orange-500", icon: <Activity size={14} /> };
    return { label: "Active", color: "text-green-500", icon: <CheckCircle size={14} /> };
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Shield size={18} className="text-accent-primary" />
            Codex Multi-Auth
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            Connect multiple ChatGPT Plus/Pro accounts via OAuth. Rotate automatically to avoid rate limits.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-accent-primary text-black text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus size={14} /> Add Account
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
          {error}
        </div>
      )}

      {/* Settings */}
      {settings && (
        <div className="p-4 rounded-xl bg-bg-item-surface border border-border-subtle">
          <div className="flex items-center gap-2 mb-3">
            <SettingsIcon size={14} className="text-text-secondary" />
            <span className="text-sm font-medium text-text-primary">Rotation Strategy</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            {["round-robin", "least-used", "random", "weighted-round-robin"].map((s) => (
              <button
                key={s}
                onClick={() => handleSetStrategy(s)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  settings.rotationStrategy === s
                    ? "bg-accent-primary text-black"
                    : "bg-bg-input text-text-secondary hover:bg-bg-elevated border border-border-muted"
                }`}
              >
                {s.replace(/-/g, " ")}
              </button>
            ))}
          </div>
          {settings.forcedAlias && (
            <div className="mt-2 text-xs text-amber-500">
              Force mode active: pinned to <strong>{settings.forcedAlias}</strong>
            </div>
          )}
        </div>
      )}

      {/* Accounts list */}
      <div className="space-y-2">
        {accounts.length === 0 && (
          <div className="p-8 text-center rounded-xl bg-bg-item-surface border border-border-subtle">
            <Shield size={32} className="mx-auto text-text-tertiary mb-3" />
            <p className="text-sm text-text-secondary">No Codex accounts configured.</p>
            <p className="text-xs text-text-tertiary mt-1">Click &quot;Add Account&quot; to login with your ChatGPT credentials.</p>
          </div>
        )}

        {accounts.map((account) => {
          const status = formatStatus(account);
          return (
            <div
              key={account.alias}
              className="p-4 rounded-xl bg-bg-item-surface border border-border-subtle flex items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">{account.alias}</span>
                  <span className={`flex items-center gap-1 text-xs ${status.color}`}>
                    {status.icon} {status.label}
                  </span>
                </div>
                <div className="text-xs text-text-tertiary mt-0.5 truncate">{account.email}</div>
                <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-tertiary">
                  <span>Requests: {account.requestCount}</span>
                  <span>Weight: {account.weight}</span>
                  {account.healthScore !== undefined && (
                    <span>Health: {account.healthScore}%</span>
                  )}
                  {account.rateLimits?.dailyLimit ? (
                    <span>
                      Daily: {account.rateLimits.dailyRemaining ?? '?'}/{account.rateLimits.dailyLimit}
                    </span>
                  ) : account.rateLimits?.weeklyLimit ? (
                    <span>
                      Weekly: {account.rateLimits.weeklyRemaining ?? '?'}/{account.rateLimits.weeklyLimit}
                    </span>
                  ) : (
                    <span className="capitalize">Status: {account.limitStatus || "unknown"}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggleEnabled(account.alias, account.enabled)}
                  className={`p-2 rounded-lg transition-colors ${
                    account.enabled
                      ? "bg-green-500/10 text-green-500 hover:bg-green-500/20"
                      : "bg-bg-input text-text-tertiary hover:bg-bg-elevated border border-border-muted"
                  }`}
                  title={account.enabled ? "Disable" : "Enable"}
                >
                  {account.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                </button>
                <button
                  onClick={() => handleReauth(account.alias)}
                  className="p-2 rounded-lg bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
                  title="Re-auth"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => handleRemove(account.alias)}
                  className="p-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                  title="Remove"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm p-6 rounded-2xl bg-bg-card border border-border-subtle shadow-2xl">
            <h4 className="text-base font-semibold text-text-primary mb-2">Add Codex Account</h4>
            <p className="text-xs text-text-secondary mb-4">
              A browser window will open for you to login with your ChatGPT account.
            </p>
            <input
              type="text"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="Account name (e.g. personal, work)..."
              className="w-full px-3 py-2 rounded-lg bg-bg-input border border-border-muted text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 px-3 py-2 rounded-lg bg-bg-input text-sm text-text-secondary hover:bg-bg-elevated transition-colors border border-border-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleAddAccount}
                disabled={!newAlias.trim() || loading}
                className="flex-1 px-3 py-2 rounded-lg bg-accent-primary text-black text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? "Opening browser..." : "Login with OpenAI"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
