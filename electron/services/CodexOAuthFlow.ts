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
import https from "node:https";
import dns from "node:dns";
import crypto from "node:crypto";
import { shell } from "electron";
import type {
  PKCEPair,
  AuthorizationFlow,
  TokenResult,
  TokenResultFailed,
  OAuthServerInfo,
} from "../types/codex-multi-auth";

// OAuth constants (from openai/codex CLI)
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_HOST = "auth.openai.com";
const TOKEN_PATH = "/oauth/token";
const TOKEN_URL = `https://${TOKEN_HOST}${TOKEN_PATH}`;

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
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REQUEST_MAX_ATTEMPTS = 4;
const TOKEN_DNS_TIMEOUT_MS = 5_000;

type TokenJsonResult =
  | { type: "success"; json: Record<string, unknown> }
  | TokenResultFailed;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTokenStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

function formatTokenNetworkError(error: unknown): string {
  const err = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code || err?.code || err?.name;
  const detail = err?.cause?.message || err?.message || String(error);
  const suffix = code ? ` (${code})` : "";
  return `Network error while contacting OpenAI OAuth at auth.openai.com: ${detail}${suffix}. Check DNS, VPN, firewall, or internet connectivity, then try again.`;
}

function formatTokenErrorDetail(error: unknown): string {
  const err = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code || err?.code || err?.name;
  const detail = err?.cause?.message || err?.message || String(error);
  return code ? `${detail} (${code})` : detail;
}

function normalizeTokenNetworkMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Network error while contacting OpenAI OAuth")) return message;
  return formatTokenNetworkError(error);
}

async function resolveTokenHostIpv4(): Promise<string[]> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    const addresses = await Promise.race([
      dns.promises.resolve4(TOKEN_HOST),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`DNS resolve4 timed out after ${TOKEN_DNS_TIMEOUT_MS}ms`)),
          TOKEN_DNS_TIMEOUT_MS
        );
      }),
    ]);

    if (addresses.length === 0) {
      throw new Error(`DNS resolve4 returned no IPv4 addresses for ${TOKEN_HOST}`);
    }

    return addresses;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toFetchHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (typeof value === "string") {
      result.set(key, value);
    }
  }
  return result;
}

async function requestTokenViaResolvedIpv4(body: URLSearchParams): Promise<Response> {
  const payload = body.toString();
  const addresses = await resolveTokenHostIpv4();
  let lastError: unknown = null;

  for (const address of addresses) {
    try {
      return await new Promise<Response>((resolve, reject) => {
        const req = https.request(
          {
            host: address,
            servername: TOKEN_HOST,
            path: TOKEN_PATH,
            method: "POST",
            headers: {
              Host: TOKEN_HOST,
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(payload),
            },
            timeout: TOKEN_REQUEST_TIMEOUT_MS,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on("end", () => {
              resolve(
                new Response(Buffer.concat(chunks).toString("utf8"), {
                  status: res.statusCode ?? 502,
                  headers: toFetchHeaders(res.headers),
                })
              );
            });
          }
        );

        req.on("timeout", () => {
          req.destroy(new Error(`OpenAI OAuth HTTPS request timed out after ${TOKEN_REQUEST_TIMEOUT_MS}ms`));
        });
        req.on("error", reject);
        req.end(payload);
      });
    } catch (error) {
      lastError = error;
      console.warn(
        `[CodexOAuthFlow] OAuth token request failed via ${address}: ${formatTokenErrorDetail(error)}`
      );
    }
  }

  throw lastError ?? new Error(`Unable to contact ${TOKEN_HOST} via resolved IPv4 address`);
}

async function requestTokenViaFetch(body: URLSearchParams): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTokenHttpResponse(body: URLSearchParams): Promise<Response> {
  try {
    return await requestTokenViaResolvedIpv4(body);
  } catch (resolvedError) {
    console.warn(
      `[CodexOAuthFlow] OAuth token request via resolve4 failed; falling back to fetch: ${formatTokenErrorDetail(resolvedError)}`
    );
    try {
      return await requestTokenViaFetch(body);
    } catch (fetchError) {
      throw new Error(
        `${formatTokenNetworkError(fetchError)} resolve4 fallback also failed: ${formatTokenErrorDetail(resolvedError)}`
      );
    }
  }
}

async function requestTokenJson(
  body: URLSearchParams,
  operation: string
): Promise<TokenJsonResult> {
  let lastFailure: TokenResultFailed | null = null;

  for (let attempt = 1; attempt <= TOKEN_REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await requestTokenHttpResponse(body);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const failed: TokenResultFailed = {
          type: "failed",
          reason: "http_error",
          statusCode: res.status,
          message: text || `OpenAI OAuth ${operation} failed with HTTP ${res.status}`,
        };
        lastFailure = failed;

        if (attempt < TOKEN_REQUEST_MAX_ATTEMPTS && isRetryableTokenStatus(res.status)) {
          const delay = retryAfterMs(res.headers) ?? Math.min(20_000, 1000 * 2 ** (attempt - 1));
          console.warn(
            `[CodexOAuthFlow] OAuth ${operation} returned ${res.status}; retrying in ${Math.round(delay / 1000)}s`
          );
          await sleep(delay);
          continue;
        }

        return failed;
      }

      const json = (await res.json().catch((): null => null)) as Record<string, unknown> | null;
      if (!json || typeof json !== "object") {
        return {
          type: "failed",
          reason: "invalid_response",
          message: "OpenAI OAuth token response was not valid JSON",
        };
      }

      return { type: "success", json };
    } catch (error) {
      const failed: TokenResultFailed = {
        type: "failed",
        reason: "network_error",
        message: normalizeTokenNetworkMessage(error),
      };
      lastFailure = failed;

      if (attempt < TOKEN_REQUEST_MAX_ATTEMPTS) {
        const delay = Math.min(20_000, 1000 * 2 ** (attempt - 1));
        console.warn(
          `[CodexOAuthFlow] OAuth ${operation} network failure; retrying in ${Math.round(delay / 1000)}s`
        );
        await sleep(delay);
        continue;
      }

      return failed;
    }
  }

  return (
    lastFailure ?? {
      type: "failed",
      reason: "network_error",
      message: `OpenAI OAuth ${operation} failed after retries`,
    }
  );
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string
): Promise<TokenResult> {
  const tokenResult = await requestTokenJson(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
    "code exchange"
  );

  if (tokenResult.type === "failed") {
    console.error(
      `[CodexOAuthFlow] code->token failed: ${tokenResult.reason} ${tokenResult.message || ""}`
    );
    return tokenResult;
  }

  const { json } = tokenResult;

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
  const tokenResult = await requestTokenJson(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    "token refresh"
  );

  if (tokenResult.type === "failed") {
    console.error(
      `[CodexOAuthFlow] Token refresh failed: ${tokenResult.reason} ${tokenResult.message || ""}`
    );
    return tokenResult;
  }

  const { json } = tokenResult;

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
