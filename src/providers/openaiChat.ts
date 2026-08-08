import type {
  ApiUsage,
  ChatStreamRequest,
  NeutralMessage,
  ProviderProfile,
  StreamHandlers,
} from "./types";

/** OpenAI-compatible Chat Completions adapter (official API, relays, local servers). */

type JsonRecord = Record<string, unknown>;

function toWireContent(message: NeutralMessage): unknown {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) {
    // Plain string maximizes compatibility with strict/older endpoints.
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return message.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image_url",
          image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` },
        },
  );
}

export function buildChatCompletionsBody(
  profile: ProviderProfile,
  request: ChatStreamRequest,
): JsonRecord {
  const local = isLocalBaseUrl(profile.baseUrl);
  const body: JsonRecord = {
    model: profile.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: toWireContent(message),
    })),
    stream: true,
  };
  // Official / cloud relays support stream_options; many local servers reject it.
  if (!local) body.stream_options = { include_usage: true };
  if (request.effort !== "default") body.reasoning_effort = request.effort;
  if (profile.verbosity) body.verbosity = profile.verbosity;
  if (typeof profile.temperature === "number") body.temperature = profile.temperature;
  const maxTokens = request.maxOutputTokensOverride ?? profile.maxOutputTokens;
  if (typeof maxTokens === "number" && maxTokens > 0) {
    // Local servers expect classic max_tokens; cloud Chat Completions prefer max_completion_tokens.
    if (local) body.max_tokens = maxTokens;
    else body.max_completion_tokens = maxTokens;
  }
  if (request.cacheKey && !local) body.prompt_cache_key = request.cacheKey;
  return body;
}

function isLocalBaseUrl(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(baseUrl);
}

function usageFrom(json: JsonRecord): ApiUsage | null {
  const usage = json.usage as JsonRecord | null | undefined;
  if (!usage || typeof usage !== "object") return null;
  const promptDetails = usage.prompt_tokens_details as JsonRecord | undefined;
  const completionDetails = usage.completion_tokens_details as JsonRecord | undefined;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    cachedInputTokens:
      promptDetails && typeof promptDetails.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : undefined,
    outputTokens:
      typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    reasoningTokens:
      completionDetails && typeof completionDetails.reasoning_tokens === "number"
        ? completionDetails.reasoning_tokens
        : undefined,
  };
}

/** Handle one parsed SSE data payload. Throws on provider-reported errors. */
export function handleChatCompletionsData(json: JsonRecord, handlers: StreamHandlers): void {
  const error = json.error as JsonRecord | undefined;
  if (error && typeof error === "object") {
    throw new Error(
      typeof error.message === "string" ? error.message : JSON.stringify(error),
    );
  }
  const usage = usageFrom(json);
  if (usage) handlers.onUsage?.(usage);

  const choices = json.choices as Array<JsonRecord> | undefined;
  const delta = choices?.[0]?.delta as JsonRecord | undefined;
  if (!delta) return;

  // DeepSeek-style reasoning_content; OpenRouter-normalized reasoning.
  const reasoning =
    typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string"
        ? delta.reasoning
        : "";
  if (reasoning) handlers.onReasoningDelta(reasoning);

  if (typeof delta.content === "string" && delta.content) {
    handlers.onTextDelta(delta.content);
  }
}
