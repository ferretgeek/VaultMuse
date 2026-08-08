import type {
  ApiUsage,
  ChatStreamRequest,
  NeutralContent,
  NeutralMessage,
  ProviderProfile,
  StreamHandlers,
} from "./types";
import { anthropicBudgetForEffort } from "./types";

/** Anthropic Messages API adapter with explicit prompt-cache breakpoints. */

type JsonRecord = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 8192;

function toWireBlock(part: NeutralContent): JsonRecord {
  if (part.type === "text") return { type: "text", text: part.text };
  return {
    type: "image",
    source: { type: "base64", media_type: part.mimeType, data: part.dataBase64 },
  };
}

/** Anthropic requires strictly alternating user/assistant roles starting with user. */
function coalesceMessages(messages: NeutralMessage[]): Array<{ role: string; content: JsonRecord[] }> {
  const wire: Array<{ role: string; content: JsonRecord[] }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const blocks = message.content
      .filter((part) => part.type !== "text" || part.text.length > 0)
      .map(toWireBlock);
    if (blocks.length === 0) continue;
    const last = wire[wire.length - 1];
    if (last && last.role === message.role) {
      const lastBlock = last.content[last.content.length - 1];
      const firstBlock = blocks[0];
      if (lastBlock?.type === "text" && firstBlock?.type === "text") {
        lastBlock.text = `${String(lastBlock.text)}\n\n${String(firstBlock.text)}`;
        last.content.push(...blocks.slice(1));
      } else {
        last.content.push(...blocks);
      }
    } else {
      wire.push({ role: message.role, content: blocks });
    }
  }
  while (wire.length > 0 && wire[0]?.role !== "user") wire.shift();
  return wire;
}

export function resolveThinkingBudget(
  profile: ProviderProfile,
  effort: ChatStreamRequest["effort"],
): number | null {
  const override = profile.thinkingBudgetTokens;
  if (typeof override === "number" && override >= 1024) return Math.floor(override);
  if (effort === "default") return anthropicBudgetForEffort(profile.reasoningEffort);
  return anthropicBudgetForEffort(effort);
}

export function buildAnthropicBody(
  profile: ProviderProfile,
  request: ChatStreamRequest,
): JsonRecord {
  const systemText = request.messages
    .filter((message) => message.role === "system")
    .map((message) =>
      message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n\n");

  const messages = coalesceMessages(request.messages);
  // Cache breakpoint on the final content block caches the whole conversation prefix.
  const lastMessage = messages[messages.length - 1];
  const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
  if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };

  const budget = resolveThinkingBudget(profile, request.effort);
  const requestedMax = request.maxOutputTokensOverride ?? profile.maxOutputTokens;
  let maxTokens =
    typeof requestedMax === "number" && requestedMax > 0 ? requestedMax : DEFAULT_MAX_TOKENS;
  if (budget !== null && maxTokens <= budget) maxTokens = budget + 4096;

  const body: JsonRecord = {
    model: profile.model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (systemText.trim()) {
    body.system = [
      { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
    ];
  }
  if (budget !== null) {
    body.thinking = { type: "enabled", budget_tokens: budget };
  } else if (typeof profile.temperature === "number") {
    // temperature must stay unset while extended thinking is enabled.
    body.temperature = profile.temperature;
  }
  return body;
}

function usageFrom(usage: JsonRecord | undefined): ApiUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : 0;
  return {
    // Normalize: report the full prompt size including cached segments.
    inputTokens: input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead || undefined,
    cacheWriteTokens: cacheWrite || undefined,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
  };
}

export function handleAnthropicData(json: JsonRecord, handlers: StreamHandlers): void {
  const type = typeof json.type === "string" ? json.type : "";

  if (type === "message_start") {
    const message = json.message as JsonRecord | undefined;
    const usage = usageFrom(message?.usage as JsonRecord | undefined);
    if (usage) handlers.onUsage?.(usage);
    return;
  }
  if (type === "content_block_delta") {
    const delta = json.delta as JsonRecord | undefined;
    if (!delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      handlers.onTextDelta(delta.text);
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      handlers.onReasoningDelta(delta.thinking);
    }
    return;
  }
  if (type === "message_delta") {
    const usage = json.usage as JsonRecord | undefined;
    if (usage && typeof usage.output_tokens === "number") {
      handlers.onUsage?.({ outputTokens: usage.output_tokens });
    }
    return;
  }
  if (type === "error") {
    const error = json.error as JsonRecord | undefined;
    throw new Error(
      typeof error?.message === "string" ? error.message : "Anthropic 流式错误",
    );
  }
}
