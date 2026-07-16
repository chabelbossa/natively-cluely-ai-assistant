/**
 * CodexResponsesClient.ts
 *
 * Client pour le backend Codex ChatGPT avec rotation automatique des comptes
 * OAuth en cas de rate-limit / erreur.
 */

import type { CodexAuthRouter, RouterErrorResult } from "./CodexAuthRouter";
import type { CodexAccount } from "../types/codex-multi-auth";

const RESPONSES_API_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_BETA_HEADER = "responses=2026-02-06";
const MINIMUM_GPT_56_CODEX_VERSION = "0.144.0";
const DEFAULT_SERVICE_TIER = "fast";
const MAX_ROTATION_ATTEMPTS = 5;

export interface CodexResponsesParams {
  model: string;
  input: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream?: boolean;
  store?: boolean;
  reasoning?: { effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" };
}

class CodexApiError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(`Codex API error ${status}: ${message}`);
    this.name = "CodexApiError";
    this.status = status;
  }
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
      const res = await this.callResponsesApiWithFastDefault(account, params);
      const text = await this.parseResponseText(res);
      return text;
    });
  }

  // =========================================================================
  // Streaming (SSE)
  // =========================================================================

  async *streamResponse(params: CodexResponsesParams): AsyncGenerator<string> {
    const result = this.executeWithRotation<AsyncGenerator<string>>(async (account) => {
      return this.createStreamGenerator(account, params);
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
    params: CodexResponsesParams,
    serviceTier?: string
  ): Promise<Response> {
    const { instructions, input } = this.normalizeInput(params.input);
    const body: Record<string, unknown> = {
      model: this.resolveCodexModel(params.model),
      instructions,
      input,
      stream: params.stream ?? true,
      store: params.store ?? false,
    };
    if (params.reasoning) {
      body.reasoning = params.reasoning;
    }
    if (serviceTier) {
      body.service_tier = serviceTier;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "OpenAI-Beta": OPENAI_BETA_HEADER,
      Originator: "codex_cli_rs",
      Version: MINIMUM_GPT_56_CODEX_VERSION,
      "User-Agent": `codex_cli_rs/${MINIMUM_GPT_56_CODEX_VERSION} (Natively)`,
    };
    const accountId = this.extractChatGptAccountId(account);
    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }

    return fetch(RESPONSES_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private extractChatGptAccountId(account: CodexAccount): string | undefined {
    for (const token of [account.idToken, account.accessToken]) {
      if (!token) continue;
      try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8")) as Record<string, unknown>;
        const accountId = payload.chatgpt_account_id
          || payload["https://api.openai.com/auth.chatgpt_account_id"];
        if (typeof accountId === "string" && accountId.trim()) {
          return accountId.trim();
        }
        const organizations = payload.organizations;
        if (Array.isArray(organizations)) {
          const organizationId = (organizations[0] as Record<string, unknown> | undefined)?.id;
          if (typeof organizationId === "string" && organizationId.trim()) {
            return organizationId.trim();
          }
        }
      } catch {
        // The token can be opaque. The account-id header is optional in that case.
      }
    }
    return undefined;
  }

  private async callResponsesApiWithFastDefault(
    account: CodexAccount,
    params: CodexResponsesParams
  ): Promise<Response> {
    const fastResponse = await this.callResponsesApi(account, params, DEFAULT_SERVICE_TIER);
    if (fastResponse.ok) {
      return fastResponse;
    }

    const message = await fastResponse.text().catch(() => "");
    throw new CodexApiError(fastResponse.status, message);
  }

  private async parseResponseText(res: Response): Promise<string> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CodexApiError(res.status, text);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return this.parseSseText(await res.text());
    }

    const rawText = await res.text();
    if (rawText.includes("event:") || rawText.includes("data:")) {
      const parsed = this.parseSseText(rawText);
      if (parsed) return parsed;
    }

    if (!rawText.trim()) {
      return "";
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return rawText;
    }

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
    res: Response
  ): AsyncGenerator<string> {
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
            const text = this.extractEventText(event);
            if (text) yield text;
          } catch {
            // ignore malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async createStreamGenerator(
    account: CodexAccount,
    params: CodexResponsesParams
  ): Promise<AsyncGenerator<string>> {
    const res = await this.callResponsesApiWithFastDefault(account, { ...params, stream: true });
    return this.streamResponsesApi(res);
  }

  private normalizeInput(
    messages: CodexResponsesParams["input"]
  ): { instructions: string; input: Array<{ role: "user" | "assistant"; content: string }> } {
    const systemMessages = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .filter(Boolean);

    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    return {
      instructions: systemMessages.join("\n\n") || "Follow the user's instructions.",
      input: input.length > 0 ? input : [{ role: "user", content: "" }],
    };
  }

  private resolveCodexModel(model: string): string {
    return model.startsWith("codex:") ? model.slice("codex:".length) : model;
  }

  private parseSseText(text: string): string {
    const chunks: string[] = [];
    let completedText = "";

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (!data || data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as Record<string, unknown>;
        const eventText = this.extractEventText(event);
        if (eventText) {
          chunks.push(eventText);
        }
        const finalText = this.extractFinalResponseText(event);
        if (finalText) {
          completedText = finalText;
        }
      } catch {
        // ignore malformed JSON
      }
    }

    return chunks.join("") || completedText;
  }

  private extractEventText(event: Record<string, unknown>): string {
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType) {
      if (eventType === "response.output_text.delta") {
        return typeof event.delta === "string" ? event.delta : "";
      }

      // Completion events can contain the whole final answer. Emitting that text
      // after the deltas would duplicate the response in the live UI.
      return "";
    }

    // Compatibility with older/untyped Codex SSE payloads.
    if (typeof event.delta === "string") return event.delta;
    if (typeof event.output_text === "string") return event.output_text;
    if (typeof event.text === "string") return event.text;

    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.text === "string") return delta.text;

    return "";
  }

  private extractFinalResponseText(event: Record<string, unknown>): string {
    const response = event.response as Record<string, unknown> | undefined;
    const output = response?.output as Array<Record<string, unknown>> | undefined;
    if (!output) return "";

    return output
      .flatMap((item) => {
        if (typeof item.content === "string") return [item.content];
        if (!Array.isArray(item.content)) return [];
        return item.content.map((contentItem: Record<string, unknown>) =>
          typeof contentItem.text === "string" ? contentItem.text : ""
        );
      })
      .join("");
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
