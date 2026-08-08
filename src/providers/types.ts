/** Provider-neutral types shared by the API layer, prompt builder, and UI. */

export type ProviderKind = "openai-responses" | "openai-chat" | "anthropic";

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI 兼容（Chat Completions）",
  anthropic: "Anthropic Messages",
};

/**
 * Unified reasoning intensity. "default" means "do not send the parameter".
 * OpenAI kinds send the value verbatim (`low`/`medium`/`high`/`xhigh`/`max`);
 * Anthropic maps the level to a thinking token budget.
 * Lowest selectable level is `low` (no none/minimal).
 */
export type ReasoningEffort =
  | "default"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const EFFORT_ORDER: ReasoningEffort[] = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  default: "默认",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "MAX",
};

/** Map legacy none/minimal (and unknown) values onto the current scale. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  // Old "none" / "minimal" collapse to the new floor.
  if (value === "none" || value === "minimal") return "low";
  return "default";
}

/**
 * Resolve the effort actually sent on a request.
 * Conversation chip "默认" (undefined / default) follows the profile setting.
 */
export function resolveEffectiveEffort(
  override: ReasoningEffort | undefined,
  profileEffort: ReasoningEffort,
): ReasoningEffort {
  if (override && override !== "default") return override;
  return profileEffort || "default";
}

/** Map a unified effort level to an Anthropic thinking budget (tokens). */
export function anthropicBudgetForEffort(effort: ReasoningEffort): number | null {
  switch (effort) {
    case "low":
      return 4096;
    case "medium":
      return 10240;
    case "high":
      return 24576;
    case "xhigh":
      return 32768;
    case "max":
      // Anthropic has no "max"; use a larger budget than xhigh.
      return 65536;
    default:
      return null;
  }
}

export interface ProviderProfile {
  id: string;
  /** Display name shown in the model selector. */
  name: string;
  kind: ProviderKind;
  /**
   * API root. OpenAI kinds follow the SDK convention and should include /v1
   * (e.g. https://api.openai.com/v1). Anthropic accepts the bare origin
   * (https://api.anthropic.com); /v1 is appended automatically.
   * A full endpoint path (…/chat/completions, …/responses, …/messages) is used as-is.
   */
  baseUrl: string;
  apiKey: string;
  /** Persist API key and custom headers in data.json. Off keeps them in memory only. */
  rememberSensitiveFields: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Anthropic thinking budget override (tokens). Empty/0 = derive from effort. */
  thinkingBudgetTokens?: number;
  /** OpenAI Responses reasoning summary ("" = off). Requires a verified org on official API. */
  reasoningSummary?: "" | "auto" | "detailed";
  /** GPT-5 family text verbosity ("" = default). */
  verbosity?: "" | "low" | "medium" | "high";
  /** Max output tokens. Empty = provider default (Anthropic falls back to 8192). */
  maxOutputTokens?: number;
  /** Sampling temperature. Empty = omit (required for reasoning models). */
  temperature?: number;
  /** Extra HTTP headers, one per line: "Name: value". */
  extraHeaders?: string;
}

export interface NeutralContentText {
  type: "text";
  text: string;
}

export interface NeutralContentImage {
  type: "image";
  mimeType: string;
  dataBase64: string;
}

export type NeutralContent = NeutralContentText | NeutralContentImage;

export interface NeutralMessage {
  role: "system" | "user" | "assistant";
  content: NeutralContent[];
}

export interface ApiUsage {
  /** Total input tokens including any cached portion. */
  inputTokens?: number;
  /** Tokens served from the provider prompt cache. */
  cachedInputTokens?: number;
  /** Tokens written to cache this request (Anthropic cache_creation). */
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ChatStreamRequest {
  messages: NeutralMessage[];
  /** Resolved effort (conversation override already applied). */
  effort: ReasoningEffort;
  /** Stable per-conversation key to improve provider cache routing. */
  cacheKey?: string;
  /** Used by connection tests to keep replies tiny. */
  maxOutputTokensOverride?: number;
}

export interface StreamHandlers {
  /** Called once when the first response byte arrives. */
  onStart?: () => void;
  onTextDelta: (text: string) => void;
  onReasoningDelta: (text: string) => void;
  onUsage?: (usage: ApiUsage) => void;
  /** Called on any network activity (watchdog keep-alive). */
  onActivity?: () => void;
}

export class ProviderError extends Error {
  status?: number;
  detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.detail = detail;
  }
}

/** Remove common credential shapes before an upstream error reaches UI or history. */
export function sanitizeProviderErrorText(value: string, maxLength = 400): string {
  return value
    .slice(0, Math.max(0, maxLength))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(
      /("?(?:api[_-]?key|authorization|x-api-key)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi,
      "$1[redacted]",
    );
}

/** Produce the profile shape that is safe to write to the plugin data file. */
export function profileForPersistence(profile: ProviderProfile): ProviderProfile {
  return profile.rememberSensitiveFields
    ? { ...profile }
    : { ...profile, apiKey: "", extraHeaders: "" };
}

/** Human-readable hint for common HTTP failures. */
export function statusHint(status: number | undefined): string {
  if (status === undefined) return "";
  if (status === 401) return "API Key 无效或未授权";
  if (status === 403) return "没有访问权限（Key 或模型受限）";
  if (status === 404) return "接口地址或模型不存在，请检查 Base URL 与模型 ID";
  if (status === 408) return "请求超时";
  if (status === 429) return "限流或额度不足";
  if (status >= 500) return "服务端错误，可稍后重试";
  return "";
}

/** Parse "Name: value" lines into a header map. */
export function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  const forbidden = new Set([
    "connection",
    "content-length",
    "cookie",
    "expect",
    "host",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const line of raw.slice(0, 16_384).split(/\r?\n/).slice(0, 64)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim().slice(0, 4096);
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(name)) continue;
    if (forbidden.has(name) || !value || /[\r\n\0]/.test(value)) continue;
    headers[name] = value;
  }
  return headers;
}

export function createProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultProfile(kind: ProviderKind = "openai-chat"): ProviderProfile {
  const base =
    kind === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1";
  return {
    id: createProfileId(),
    name: "",
    kind,
    baseUrl: base,
    apiKey: "",
    rememberSensitiveFields: false,
    model: "",
    reasoningEffort: "default",
    reasoningSummary: "",
    verbosity: "",
    extraHeaders: "",
  };
}
