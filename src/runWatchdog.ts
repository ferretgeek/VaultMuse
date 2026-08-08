/**
 * Dual timeout for long-running API requests:
 * - total: absolute wall clock from start
 * - idle: no "activity" (received bytes/progress) for idleMs
 *
 * Call `touch()` whenever meaningful progress arrives.
 */
export class RunWatchdog {
  private totalTimer: number | null = null;
  private idleTimer: number | null = null;
  private disposed = false;

  constructor(
    private readonly totalMs: number,
    private readonly idleMs: number,
    private readonly onTimeout: (reason: "total" | "idle", message: string) => void,
  ) {
    const total = Math.max(1_000, totalMs);
    const idle = Math.max(50, Math.min(idleMs, total));

    this.totalTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.fire(
        "total",
        `请求超时（${Math.ceil(total / 1000)} 秒），已停止本轮请求。`,
      );
    }, total);

    this.armIdle(idle);
  }

  /** Mark progress so the idle timer resets. */
  touch(): void {
    if (this.disposed) return;
    const idle = Math.max(50, Math.min(this.idleMs, Math.max(1_000, this.totalMs)));
    this.armIdle(idle);
  }

  dispose(): void {
    this.disposed = true;
    if (this.totalTimer !== null) {
      window.clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle(idleMs: number): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.fire(
        "idle",
        `长时间无进度（${Math.ceil(idleMs / 1000)} 秒未收到数据），已停止本轮请求。可在设置中调大「无进度超时」。`,
      );
    }, idleMs);
  }

  private fire(reason: "total" | "idle", message: string): void {
    if (this.disposed) return;
    this.dispose();
    this.onTimeout(reason, message);
  }
}

/** Default idle: 2 minutes, never longer than the total timeout. */
export function resolveIdleTimeoutMs(totalMs: number, idleMs?: number): number {
  const total = Math.max(10_000, totalMs);
  const idle = typeof idleMs === "number" && Number.isFinite(idleMs) ? idleMs : 120_000;
  return Math.max(5_000, Math.min(idle, total));
}
