import { postStream, getJson } from "./http";
import { SseParser } from "./sse";
import { buildChatCompletionsBody, handleChatCompletionsData } from "./openaiChat";
import { buildResponsesBody, handleResponsesData } from "./openaiResponses";
import { buildAnthropicBody, handleAnthropicData } from "./anthropic";
import {
  ProviderError,
  parseExtraHeaders,
  sanitizeProviderErrorText,
  statusHint,
  type ChatStreamRequest,
  type ProviderProfile,
  type StreamHandlers,
} from "./types";

export * from "./types";

const FULL_ENDPOINT_RE = /\/(chat\/completions|responses|messages)\/?$/;

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Resolve the chat endpoint URL for a profile (pure, testable). */
export function resolveEndpoint(profile: ProviderProfile): string {
  const base = trimBase(profile.baseUrl);
  if (FULL_ENDPOINT_RE.test(base)) return base;
  if (profile.kind === "openai-chat") return `${base}/chat/completions`;
  if (profile.kind === "openai-responses") return `${base}/responses`;
  const root = base.endsWith("/v1") ? base : `${base}/v1`;
  return `${root}/messages`;
}

/** Resolve the model-list endpoint for a profile. */
export function resolveModelsEndpoint(profile: ProviderProfile): string {
  const base = trimBase(profile.baseUrl).replace(FULL_ENDPOINT_RE, "");
  if (profile.kind === "anthropic") {
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return `${root}/models`;
  }
  return `${base}/models`;
}

export function buildHeaders(profile: ProviderProfile): Record<string, string> {
  const headers: Record<string, string> = parseExtraHeaders(profile.extraHeaders);
  const key = profile.apiKey.trim();
  if (profile.kind === "anthropic") {
    // Local Anthropic-compatible endpoints may run keyless.
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

export function buildRequestBody(
  profile: ProviderProfile,
  request: ChatStreamRequest,
): Record<string, unknown> {
  if (profile.kind === "openai-chat") return buildChatCompletionsBody(profile, request);
  if (profile.kind === "openai-responses") return buildResponsesBody(profile, request);
  return buildAnthropicBody(profile, request);
}

function parseErrorBody(bodyText: string | undefined): string {
  if (!bodyText) return "";
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    const error = json.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof json.message === "string") return json.message;
  } catch {
    /* not JSON */
  }
  return sanitizeProviderErrorText(bodyText);
}

export function validateProfile(profile: ProviderProfile): void {
  if (!profile.baseUrl.trim()) throw new ProviderError("未填写 Base URL");
  if (!profile.model.trim()) throw new ProviderError("未填写模型 ID");
  let url: URL;
  try {
    url = new URL(resolveEndpoint(profile));
  } catch {
    throw new ProviderError("接口地址无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("接口地址只允许 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new ProviderError("接口地址不能包含用户名或密码");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new ProviderError("远程接口必须使用 HTTPS；HTTP 仅允许本机回环地址");
  }
}

/**
 * Stream one chat turn. Deltas/usage arrive via handlers; throws ProviderError
 * on any failure (including "aborted" when the signal fires).
 */
export async function streamChat(
  profile: ProviderProfile,
  request: ChatStreamRequest,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  validateProfile(profile);
  const url = resolveEndpoint(profile);
  const body = buildRequestBody(profile, request);
  const headers = buildHeaders(profile);

  let streamError: Error | null = null;
  let started = false;

  const dispatch = (data: string) => {
    if (streamError) return;
    if (data.trim() === "[DONE]") return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      if (profile.kind === "openai-chat") handleChatCompletionsData(json, handlers);
      else if (profile.kind === "openai-responses") handleResponsesData(json, handlers);
      else handleAnthropicData(json, handlers);
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
    }
  };

  const parser = new SseParser((event) => dispatch(event.data));

  let response;
  try {
    response = await postStream({
      url,
      headers,
      body,
      signal,
      onChunk: (chunk) => {
        if (!started) {
          started = true;
          handlers.onStart?.();
        }
        handlers.onActivity?.();
        parser.push(chunk);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "aborted") throw new ProviderError("aborted");
    throw new ProviderError(`网络请求失败：${message}`);
  }

  if (!response.ok) {
    const detail = parseErrorBody(response.bodyText);
    const hint = statusHint(response.status);
    throw new ProviderError(
      [`HTTP ${response.status}`, hint, detail].filter(Boolean).join(" · "),
      response.status,
      detail || undefined,
    );
  }

  parser.flush();
  if (streamError) {
    const err: Error = streamError;
    throw new ProviderError(err.message);
  }
}

/** Send a minimal request to verify connectivity and credentials. */
export async function testConnection(
  profile: ProviderProfile,
): Promise<{ ok: boolean; message: string }> {
  const startedAt = Date.now();
  let reply = "";
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30_000);
  try {
    await streamChat(
      profile,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "Reply with OK" }] },
        ],
        effort: "default",
        maxOutputTokensOverride: 64,
      },
      {
        onTextDelta: (text) => {
          reply += text;
        },
        onReasoningDelta: () => {},
      },
      controller.signal,
    );
    const latency = Date.now() - startedAt;
    const snippet = reply.trim().replace(/\s+/g, " ").slice(0, 60);
    return {
      ok: true,
      message: `连接成功 · ${latency}ms${snippet ? ` · 回复：${snippet}` : ""}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连接失败：${message}` };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Fetch available model ids (GET /models, supported by all three protocols). */
export async function listModels(profile: ProviderProfile): Promise<string[]> {
  const url = resolveModelsEndpoint(profile);
  const response = await getJson({ url, headers: buildHeaders(profile) });
  if (!response.ok) {
    const detail = parseErrorBody(response.bodyText);
    const hint = statusHint(response.status);
    throw new ProviderError(
      [`HTTP ${response.status}`, hint, detail].filter(Boolean).join(" · "),
      response.status,
    );
  }
  const json = response.json as Record<string, unknown> | undefined;
  const data = Array.isArray(json?.data) ? (json?.data as Array<Record<string, unknown>>) : [];
  const ids = data
    .map((item) => (typeof item.id === "string" ? item.id : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return Array.from(new Set(ids));
}
