/**
 * Split inline <think>…</think> segments (emitted by Qwen/R1-style models on
 * OpenAI-compatible endpoints) out of the visible text stream.
 * Safe across chunk boundaries: holds back a partial-tag suffix until resolved.
 */

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export class ThinkTagFilter {
  private inThink = false;
  private pending = "";

  /** Feed a raw text delta; returns what should go to text vs reasoning. */
  push(delta: string): { text: string; reasoning: string } {
    this.pending += delta;
    let text = "";
    let reasoning = "";

    for (;;) {
      if (this.inThink) {
        const close = this.pending.indexOf(CLOSE_TAG);
        if (close >= 0) {
          reasoning += this.pending.slice(0, close);
          this.pending = this.pending.slice(close + CLOSE_TAG.length);
          this.inThink = false;
          continue;
        }
        const hold = partialSuffixLength(this.pending, CLOSE_TAG);
        reasoning += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        break;
      }
      const open = this.pending.indexOf(OPEN_TAG);
      if (open >= 0) {
        text += this.pending.slice(0, open);
        this.pending = this.pending.slice(open + OPEN_TAG.length);
        this.inThink = true;
        continue;
      }
      const hold = partialSuffixLength(this.pending, OPEN_TAG);
      text += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      break;
    }
    return { text, reasoning };
  }

  /** Flush any held-back tail at end of stream. */
  flush(): { text: string; reasoning: string } {
    const rest = this.pending;
    this.pending = "";
    if (!rest) return { text: "", reasoning: "" };
    return this.inThink ? { text: "", reasoning: rest } : { text: rest, reasoning: "" };
  }
}

/** Length of the longest suffix of `value` that is a proper prefix of `tag`. */
function partialSuffixLength(value: string, tag: string): number {
  const max = Math.min(value.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}
