import { streamChat, ProviderError } from "./providers";
import type {
  ApiUsage,
  ChatStreamRequest,
  ProviderProfile,
} from "./providers/types";
import { ThinkTagFilter } from "./providers/thinkFilter";
import { resolveIdleTimeoutMs, RunWatchdog } from "./runWatchdog";

export type ChatStage =
  | "idle"
  | "starting"
  | "thinking"
  | "writing"
  | "done"
  | "error"
  | "cancelled";

export interface RunProgressEvent {
  stage: ChatStage;
  message: string;
  partialText?: string;
  partialThought?: string;
}

export interface ApiRunResult {
  ok: boolean;
  text: string;
  thought?: string;
  usage?: ApiUsage;
  error?: string;
  errorDetails?: string;
  durationMs: number;
  /** True once any response byte arrived (the model definitely saw the prompt). */
  gotFirstByte: boolean;
}

export interface ApiRunRequest {
  profile: ProviderProfile;
  request: ChatStreamRequest;
  timeoutMs: number;
  idleTimeoutMs: number;
  onProgress: (event: RunProgressEvent) => void;
}

/** Minimum interval between streamed UI updates (keeps DOM work sane). */
const FLUSH_INTERVAL_MS = 60;

export class ApiRunner {
  private controller: AbortController | null = null;
  private killed = false;

  get isRunning(): boolean {
    return this.controller !== null;
  }

  cancel(): void {
    this.killed = true;
    this.controller?.abort();
  }

  async run(req: ApiRunRequest): Promise<ApiRunResult> {
    this.killed = false;
    const controller = new AbortController();
    this.controller = controller;

    const startedAt = Date.now();
    const filter = new ThinkTagFilter();
    let text = "";
    let thought = "";
    let usage: ApiUsage | undefined;
    let gotFirstByte = false;
    let timeoutMessage: string | null = null;
    let dirty = false;
    let flushTimer: number | null = null;

    const stageNow = (): ChatStage => {
      if (text) return "writing";
      if (thought) return "thinking";
      return "starting";
    };
    const stageMessage: Record<string, string> = {
      starting: "正在连接模型…",
      thinking: "正在思考…",
      writing: "正在回复…",
    };

    const flush = () => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      const stage = stageNow();
      req.onProgress({
        stage,
        message: stageMessage[stage] ?? "",
        partialText: text,
        partialThought: thought || undefined,
      });
    };
    const scheduleFlush = () => {
      dirty = true;
      if (flushTimer === null) flushTimer = window.setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    const watchdog = new RunWatchdog(
      req.timeoutMs,
      resolveIdleTimeoutMs(req.timeoutMs, req.idleTimeoutMs),
      (_reason, message) => {
        timeoutMessage = message;
        controller.abort();
      },
    );

    req.onProgress({ stage: "starting", message: stageMessage.starting ?? "正在连接" });

    let failure: { error: string; details?: string } | null = null;
    try {
      await streamChat(
        req.profile,
        req.request,
        {
          onStart: () => {
            gotFirstByte = true;
          },
          onActivity: () => watchdog.touch(),
          onTextDelta: (delta) => {
            const split = filter.push(delta);
            if (split.text) text += split.text;
            if (split.reasoning) thought += split.reasoning;
            scheduleFlush();
          },
          onReasoningDelta: (delta) => {
            thought += delta;
            scheduleFlush();
          },
          onUsage: (partial) => {
            usage = { ...(usage ?? {}), ...definedOnly(partial) };
          },
        },
        controller.signal,
      );
      const tail = filter.flush();
      if (tail.text) text += tail.text;
      if (tail.reasoning) thought += tail.reasoning;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (timeoutMessage) {
        failure = { error: timeoutMessage };
      } else if (this.killed || message === "aborted") {
        failure = { error: "cancelled" };
      } else {
        failure = {
          error: message,
          details: error instanceof ProviderError ? error.detail : undefined,
        };
      }
    } finally {
      watchdog.dispose();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      this.controller = null;
    }

    const durationMs = Date.now() - startedAt;

    if (failure) {
      const cancelled = failure.error === "cancelled";
      req.onProgress({
        stage: cancelled ? "cancelled" : "error",
        message: cancelled ? "已停止" : failure.error,
        partialText: text,
        partialThought: thought || undefined,
      });
      return {
        ok: false,
        text,
        thought: thought || undefined,
        usage,
        error: failure.error,
        errorDetails: failure.details,
        durationMs,
        gotFirstByte,
      };
    }

    if (!text.trim() && !thought.trim()) {
      req.onProgress({ stage: "error", message: "模型没有返回内容" });
      return {
        ok: false,
        text: "",
        usage,
        error: "模型没有返回任何内容，请检查模型 ID 与参数。",
        durationMs,
        gotFirstByte,
      };
    }

    req.onProgress({
      stage: "done",
      message: "完成",
      partialText: text,
      partialThought: thought || undefined,
    });
    return {
      ok: true,
      text,
      thought: thought || undefined,
      usage,
      durationMs,
      gotFirstByte,
    };
  }
}

function definedOnly(usage: ApiUsage): Partial<ApiUsage> {
  const out: Partial<ApiUsage> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.cachedInputTokens !== undefined) out.cachedInputTokens = usage.cachedInputTokens;
  if (usage.cacheWriteTokens !== undefined) out.cacheWriteTokens = usage.cacheWriteTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.reasoningTokens !== undefined) out.reasoningTokens = usage.reasoningTokens;
  return out;
}
