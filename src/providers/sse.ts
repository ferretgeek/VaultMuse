/** Incremental Server-Sent Events parser (handles chunk boundaries anywhere). */

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    // Events are separated by a blank line (\n\n or \r\n\r\n).
    for (;;) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.dispatch(block);
    }
  }

  /** Flush any trailing block missing the final blank line. */
  flush(): void {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim()) this.dispatch(rest);
  }

  private dispatch(block: string): void {
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    this.onEvent({ event: eventName, data: dataLines.join("\n") });
  }
}
