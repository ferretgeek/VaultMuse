import type {
  ApiUsage,
  ChatStreamRequest,
  NeutralMessage,
  ProviderProfile,
  StreamHandlers,
} from "./types";

/** OpenAI Responses API adapter. */

type JsonRecord = Record<string, unknown>;

function toWireContent(message: NeutralMessage): unknown[] {
  if (message.role === "assistant") {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => ({ type: "output_text", text: part.type === "text" ? part.text : "" }));
  }
  return message.content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : {
          type: "input_image",
          image_url: `data:${part.mimeType};base64,${part.dataBase64}`,
          detail: "auto",
        },
  );
}

export function buildResponsesBody(
  profile: ProviderProfile,
  request: ChatStreamRequest,
): JsonRecord {
  const body: JsonRecord = {
    model: profile.model,
    input: request.messages.map((message) => ({
      role: message.role,
      content: toWireContent(message),
    })),
    stream: true,
    store: false,
  };

  const reasoning: JsonRecord = {};
  if (request.effort !== "default") reasoning.effort = request.effort;
  if (profile.reasoningSummary) reasoning.summary = profile.reasoningSummary;
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

  if (profile.verbosity) body.text = { verbosity: profile.verbosity };
  if (typeof profile.temperature === "number") body.temperature = profile.temperature;
  const maxTokens = request.maxOutputTokensOverride ?? profile.maxOutputTokens;
  if (typeof maxTokens === "number" && maxTokens > 0) body.max_output_tokens = maxTokens;
  if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
  return body;
}

function usageFrom(response: JsonRecord | undefined): ApiUsage | null {
  const usage = response?.usage as JsonRecord | undefined;
  if (!usage || typeof usage !== "object") return null;
  const inputDetails = usage.input_tokens_details as JsonRecord | undefined;
  const outputDetails = usage.output_tokens_details as JsonRecord | undefined;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    cachedInputTokens:
      inputDetails && typeof inputDetails.cached_tokens === "number"
        ? inputDetails.cached_tokens
        : undefined,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    reasoningTokens:
      outputDetails && typeof outputDetails.reasoning_tokens === "number"
        ? outputDetails.reasoning_tokens
        : undefined,
  };
}

/**
 * Handle one parsed SSE payload from the Responses API.
 * The payload's own `type` field is authoritative (event names may be absent on relays).
 */
export function handleResponsesData(json: JsonRecord, handlers: StreamHandlers): void {
  const type = typeof json.type === "string" ? json.type : "";

  if (type === "response.output_text.delta" || type === "response.refusal.delta") {
    if (typeof json.delta === "string" && json.delta) handlers.onTextDelta(json.delta);
    return;
  }
  if (type === "response.reasoning_summary_text.delta") {
    if (typeof json.delta === "string" && json.delta) handlers.onReasoningDelta(json.delta);
    return;
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const usage = usageFrom(json.response as JsonRecord | undefined);
    if (usage) handlers.onUsage?.(usage);
    if (type === "response.incomplete") {
      const response = json.response as JsonRecord | undefined;
      const details = response?.incomplete_details as JsonRecord | undefined;
      if (details?.reason === "max_output_tokens") {
        handlers.onTextDelta("\n\n> 输出达到 max_output_tokens 上限，回答被截断。");
      }
    }
    return;
  }
  if (type === "response.failed") {
    const response = json.response as JsonRecord | undefined;
    const error = response?.error as JsonRecord | undefined;
    throw new Error(
      typeof error?.message === "string" ? error.message : "Responses 请求失败",
    );
  }
  if (type === "error") {
    throw new Error(
      typeof json.message === "string" ? json.message : "Responses 流式错误",
    );
  }
  // Other lifecycle events (response.created, output_item.added, …) are activity only.
}
