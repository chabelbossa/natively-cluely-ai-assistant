/**
 * CodexResponsesClient.ts
 *
 * Client pour l'API OpenAI Responses (backend Codex).
 * Appelle directement https://api.openai.com/v1/responses avec rotation
 * automatique des comptes OAuth en cas de rate-limit / erreur.
 */

import type { CodexAuthRouter, RouterErrorResult } from "./CodexAuthRouter";
import type { CodexAccount } from "../types/codex-multi-auth";

const RESPONSES_API_URL = "https://api.openai.com/v1/responses";
const MAX_ROTATION_ATTEMPTS = 5;

export interface CodexResponsesParams {
  model: string;
  input: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream?: boolean;
  store?: boolean;
  reasoning?: { effort?: "none" | "low" | "medium" | "high" | "xhigh" };
}

export class CodexResponsesClient {
  private router: CodexAuthRouter;

  constructor(router: CodexAuthRouter) {
    this.router = router;
  }

  // =========================================================================
  // Non-streaming
  // =========================================================================

  async generateResponse(params: CodexResponsesParams): Promise<string> {
    return this.executeWithRotation<string>(async (account) => {
      const res = await this.callResponsesApi(account, params);
      const text = await this.parseResponseText(res);
      return text;
    });
  }

  // =========================================================================
  // Streaming (SSE)
  // =========================================================================

  async *streamResponse(params: CodexResponsesParams): AsyncGenerator<string> {
    const result = this.executeWithRotation<AsyncGenerator<string>>(async (account) => {
      return this.streamResponsesApi(account, params);
    });

    // Note: executeWithRotation returns a Promise<AsyncGenerator>.
    // We need to unwrap it carefully.
    const generator = await result;
    yield* generator;
  }

  // =========================================================================
  // Low-level API call
  // =========================================================================

  private async callResponsesApi(
    account: CodexAccount,
    params: CodexResponsesParams
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: params.model,
      input: params.input,
      stream: params.stream ?? false,
      store: params.store ?? false,
    };
    if (params.reasoning) {
      body.reasoning = params.reasoning;
    }

    return fetch(RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async parseResponseText(res: Response): Promise<string> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Codex API error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as Record<string, unknown>;

    // Responses API returns output items
    const output = json.output as Array<Record<string, unknown>> | undefined;
    if (output && output.length > 0) {
      const last = output[output.length - 1];
      if (typeof last.content === "string") return last.content;
      if (Array.isArray(last.content)) {
        return last.content
          .map((c: Record<string, unknown>) => (typeof c.text === "string" ? c.text : ""))
          .join("");
      }
    }

    // Fallback
    if (typeof json.output_text === "string") return json.output_text;

    return JSON.stringify(json);
  }

  private async *streamResponsesApi(
    account: CodexAccount,
    params: CodexResponsesParams
  ): AsyncGenerator<string> {
    const res = await this.callResponsesApi(account, { ...params, stream: true });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Codex API error ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error("No response body for streaming");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            // Extract text delta from SSE events
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta && typeof delta.text === "string") {
              yield delta.text;
            }
            // Alternative: output_text field
            if (typeof event.output_text === "string") {
              yield event.output_text;
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // =========================================================================
  // Rotation retry wrapper
  // =========================================================================

  private async executeWithRotation<T>(
    fn: (account: CodexAccount) => Promise<T>
  ): Promise<T> {
    const attemptedAliases = new Set<string>();
    let lastError: RouterErrorResult | null = null;

    for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
      const selection = this.router.selectAccount();
      if (!selection) {
        throw new Error(
          lastError
            ? `All Codex accounts exhausted. Last error: ${lastError.message}`
            : "No eligible Codex accounts available. Add accounts in Settings."
        );
      }

      const { account } = selection;

      // Skip if already attempted in this rotation cycle
      if (attemptedAliases.has(account.alias)) {
        continue;
      }
      attemptedAliases.add(account.alias);

      try {
        const result = await fn(account);
        this.router.recordSuccess(account.alias);
        this.router.updateLimitsFromHeaders(
          account.alias,
          // We don't have headers here for non-streaming; handled differently
          new Headers()
        );
        return result;
      } catch (error: any) {
        const status = error.status ?? (error.message?.includes("429") ? 429 : 0);
        const message = error.message || String(error);

        if (status === 429 || message.includes("429") || message.includes("rate limit")) {
          // Parse Retry-After if available
          const retryMatch = message.match(/retry[_\s-]?after[:\s]*(\d+)/i);
          const retryAfterMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 60_000;
          this.router.recordRateLimit(account.alias, retryAfterMs);
          lastError = { type: "rate-limit", message, alias: account.alias, retryAfterMs };
          console.warn(`[CodexResponsesClient] Rate limit on ${account.alias}, rotating...`);
          continue;
        }

        if (status === 401 || status === 403 || message.includes("auth")) {
          this.router.recordAuthFailure(account.alias);
          lastError = { type: "auth-failure", message, alias: account.alias };
          console.warn(`[CodexResponsesClient] Auth failure on ${account.alias}, rotating...`);
          continue;
        }

        if (status >= 500 || message.includes("network")) {
          this.router.recordServerError(account.alias);
          lastError = { type: "server-error", message, alias: account.alias };
          console.warn(`[CodexResponsesClient] Server error on ${account.alias}, rotating...`);
          continue;
        }

        // Unknown error — don't rotate blindly, just throw
        throw error;
      }
    }

    throw new Error(
      lastError
        ? `All Codex accounts exhausted after ${MAX_ROTATION_ATTEMPTS} attempts. Last error: ${lastError.message}`
        : `All Codex accounts exhausted after ${MAX_ROTATION_ATTEMPTS} attempts.`
    );
  }
}
