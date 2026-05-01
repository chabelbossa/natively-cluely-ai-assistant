/**
 * CodexOAuthFlow.ts
 *
 * Flux OAuth PKCE pour l'authentification ChatGPT/Codex.
 * Inspiré de oc-codex-multi-auth (ndycode) et opencode-openai-codex-auth (Numman Ali).
 *
 * Endpoints OpenAI OAuth (constants du CLI Codex officiel):
 *   CLIENT_ID    = "app_EMoamEEZ73f0CkXaXp7hrann"
 *   AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
 *   TOKEN_URL     = "https://auth.openai.com/oauth/token"
 */

import http from "node:http";
import crypto from "node:crypto";
import { shell } from "electron";
import type {
  PKCEPair,
  AuthorizationFlow,
  TokenResult,
  OAuthServerInfo,
} from "../types/codex-multi-auth";

// OAuth constants (from openai/codex CLI)
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

const REQUIRED_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
];
const SCOPE = REQUIRED_OAUTH_SCOPES.join(" ");

// ============================================================================
// PKCE Generation
// ============================================================================

function base64urlencode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generatePKCE(): PKCEPair {
  const verifier = base64urlencode(crypto.randomBytes(64));
  const challenge = base64urlencode(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

function createState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ============================================================================
// Success HTML
// ============================================================================

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0d0d0d; color: #fff; }
    .card { text-align: center; padding: 2rem; border-radius: 12px; background: #1a1a1a; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
    .check { font-size: 48px; margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    p { margin: 0; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to Natively.</p>
  </div>
</body>
</html>`;

// ============================================================================
// Authorization Flow
// ============================================================================

export async function createAuthorizationFlow(
  forceNewLogin = false
): Promise<AuthorizationFlow> {
  const pkce = generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");

  if (forceNewLogin) {
    url.searchParams.set("prompt", "login");
  }

  return { pkce, state, url: url.toString() };
}

// ============================================================================
// Token Exchange
// ============================================================================

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string
): Promise<TokenResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[CodexOAuthFlow] code->token failed: ${res.status} ${text}`);
    return {
      type: "failed",
      reason: "http_error",
      statusCode: res.status,
      message: text || undefined,
    };
  }

  const json = (await res.json()) as Record<string, unknown>;

  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    console.error("[CodexOAuthFlow] token response validation failed", json);
    return {
      type: "failed",
      reason: "invalid_response",
      message: "Response failed schema validation",
    };
  }

  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    idToken: typeof json.id_token === "string" ? json.id_token : undefined,
    scope: typeof json.scope === "string" ? json.scope : SCOPE,
  };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenResult> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[CodexOAuthFlow] Token refresh failed: ${response.status} ${text}`);
      return {
        type: "failed",
        reason: "http_error",
        statusCode: response.status,
        message: text || undefined,
      };
    }

    const json = (await response.json()) as Record<string, unknown>;

    if (
      typeof json.access_token !== "string" ||
      typeof json.expires_in !== "number"
    ) {
      return {
        type: "failed",
        reason: "invalid_response",
        message: "Refresh response missing required fields",
      };
    }

    const nextRefresh =
      typeof json.refresh_token === "string"
        ? json.refresh_token
        : refreshToken;

    return {
      type: "success",
      access: json.access_token,
      refresh: nextRefresh,
      expires: Date.now() + json.expires_in * 1000,
      idToken: typeof json.id_token === "string" ? json.id_token : undefined,
      scope: typeof json.scope === "string" ? json.scope : undefined,
    };
  } catch (error) {
    const err = error as Error;
    console.error("[CodexOAuthFlow] Token refresh error", err);
    return {
      type: "failed",
      reason: "network_error",
      message: err?.message,
    };
  }
}

// ============================================================================
// Local Callback Server
// ============================================================================

type ServerWithLastCode = http.Server & { _lastCode?: string };

function closeServer(server: http.Server): void {
  try {
    server.close();
  } catch {
    // ignore
  }
}

export async function startLocalOAuthServer({
  state,
}: {
  state: string;
}): Promise<OAuthServerInfo> {
  let pollAborted = false;
  let lastCode: string | undefined;
  const allServers: ServerWithLastCode[] = [];

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'");
      res.end(OAUTH_SUCCESS_HTML);
      lastCode = code;
      for (const server of allServers) {
        server._lastCode = code;
      }
    } catch (err) {
      console.error(`[CodexOAuthFlow] Request handler error: ${(err as Error)?.message}`);
      res.statusCode = 500;
      res.end("Internal error");
    }
  };

  const bindServer = (host: string): Promise<http.Server | null> => {
    const server = http.createServer(handler) as ServerWithLastCode;
    allServers.push(server);
    server.unref();

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: http.Server | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      server
        .on("error", (err: NodeJS.ErrnoException) => {
          console.error(
            `[CodexOAuthFlow] Failed to bind ${host}:${OAUTH_CALLBACK_PORT} (${err?.code})`
          );
          settle(null);
        })
        .listen(OAUTH_CALLBACK_PORT, host, () => {
          settle(server);
        });
    });
  };

  const boundServers = (
    await Promise.all([bindServer("127.0.0.1"), bindServer("::1")])
  ).filter((server): server is http.Server => server !== null);

  if (boundServers.length === 0) {
    return {
      port: OAUTH_CALLBACK_PORT,
      ready: false,
      close: () => {
        pollAborted = true;
        for (const server of allServers) {
          closeServer(server);
        }
      },
      waitForCode: () => Promise.resolve(null),
    };
  }

  return {
    port: OAUTH_CALLBACK_PORT,
    ready: true,
    close: () => {
      pollAborted = true;
      for (const server of boundServers) {
        closeServer(server);
      }
    },
    waitForCode: async () => {
      const POLL_INTERVAL_MS = 100;
      const TIMEOUT_MS = 5 * 60 * 1000;
      const maxIterations = Math.floor(TIMEOUT_MS / POLL_INTERVAL_MS);
      const poll = () => new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      for (let i = 0; i < maxIterations; i++) {
        if (pollAborted) return null;
        const serverCode = allServers
          .map((server) => server._lastCode)
          .find((code): code is string => typeof code === "string" && code.length > 0);
        const code = lastCode ?? serverCode;
        if (code) return { code };
        await poll();
      }
      console.warn("[CodexOAuthFlow] OAuth poll timeout after 5 minutes");
      return null;
    },
  };
}

// ============================================================================
// High-level Flow Orchestrator
// ============================================================================

export interface CodexAuthFlowResult {
  success: boolean;
  account?: {
    email: string;
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: string;
    oauthScope?: string;
  };
  error?: string;
}

/**
 * Run the complete OAuth flow: start server → open browser → wait callback → exchange tokens.
 */
export async function runOAuthFlow(forceNewLogin = false): Promise<CodexAuthFlowResult> {
  let server: OAuthServerInfo | null = null;
  try {
    const flow = await createAuthorizationFlow(forceNewLogin);

    server = await startLocalOAuthServer({ state: flow.state });
    if (!server.ready) {
      return { success: false, error: "Failed to start local OAuth callback server on port 1455" };
    }

    // Open browser
    await shell.openExternal(flow.url);

    // Wait for callback
    const codeResult = await server.waitForCode();
    if (!codeResult) {
      return { success: false, error: "OAuth timeout or user cancelled" };
    }

    // Exchange code for tokens
    const tokenResult = await exchangeAuthorizationCode(codeResult.code, flow.pkce.verifier);
    if (tokenResult.type === "failed") {
      return { success: false, error: tokenResult.message || `Token exchange failed: ${tokenResult.reason}` };
    }

    // Decode JWT to extract email
    let email = "";
    try {
      if (tokenResult.idToken) {
        const parts = tokenResult.idToken.split(".");
        if (parts.length === 3) {
          const payload = parts[1] ?? "";
          const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
          const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            "="
          );
          const decoded = Buffer.from(padded, "base64").toString("utf-8");
          const jwtPayload = JSON.parse(decoded) as Record<string, unknown>;
          email = typeof jwtPayload.email === "string" ? jwtPayload.email : "";
        }
      }
    } catch {
      // ignore decode errors
    }

    return {
      success: true,
      account: {
        email: email || "unknown",
        accessToken: tokenResult.access,
        refreshToken: tokenResult.refresh,
        idToken: tokenResult.idToken,
        expiresAt: new Date(tokenResult.expires).toISOString(),
        oauthScope: tokenResult.scope,
      },
    };
  } catch (error) {
    const err = error as Error;
    console.error("[CodexOAuthFlow] Unexpected error", err);
    return { success: false, error: err.message };
  } finally {
    server?.close();
  }
}
