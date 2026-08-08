import * as http from "http";
import * as https from "https";

const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;

/**
 * Streaming HTTP via Node modules (bypasses renderer CORS entirely and
 * supports true incremental reads, which Obsidian's requestUrl cannot do).
 */

export interface StreamResponse {
  ok: boolean;
  status: number;
  /** Full body text for non-2xx responses (error payloads). */
  bodyText?: string;
}

function moduleFor(url: URL): typeof https {
  return (url.protocol === "http:" ? http : https) as typeof https;
}

export function postStream(options: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<StreamResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishOk = (value: StreamResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishErr = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      finishErr(new Error("接口地址无效"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      finishErr(new Error("接口地址只允许 HTTP 或 HTTPS"));
      return;
    }

    const payload = JSON.stringify(options.body);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      finishErr(new Error("请求内容过大，请减少图片或上下文"));
      return;
    }
    const request = moduleFor(url).request(
      url,
      {
        method: "POST",
        headers: {
          ...options.headers,
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.setEncoding("utf8");
        if (status < 200 || status >= 300) {
          let body = "";
          response.on("data", (chunk: string) => {
            const remaining = 64_000 - body.length;
            if (remaining > 0) body += chunk.slice(0, remaining);
          });
          response.on("end", () => finishOk({ ok: false, status, bodyText: body }));
          response.on("error", (error) => finishErr(error));
          return;
        }
        let receivedBytes = 0;
        response.on("data", (chunk: string) => {
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > MAX_STREAM_BYTES) {
            request.destroy(new Error("模型响应过大，已停止接收"));
            finishErr(new Error("模型响应过大，已停止接收"));
            return;
          }
          try {
            options.onChunk(chunk);
          } catch (error) {
            request.destroy();
            finishErr(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on("end", () => finishOk({ ok: true, status }));
        response.on("error", (error) => finishErr(error));
      },
    );

    const onAbort = () => {
      request.destroy(new Error("aborted"));
      finishErr(new Error("aborted"));
    };
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error) => {
      finishErr(options.signal.aborted ? new Error("aborted") : error);
    });
    request.end(payload);
  });
}

export function getJson(options: {
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; json?: unknown; bodyText: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      reject(new Error("接口地址无效"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("接口地址只允许 HTTP 或 HTTPS"));
      return;
    }
    const request = moduleFor(url).request(
      url,
      { method: "GET", headers: { ...options.headers, accept: "application/json" } },
      (response) => {
        const status = response.statusCode ?? 0;
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          const remaining = MAX_JSON_BYTES - Buffer.byteLength(body);
          const chunkBytes = Buffer.byteLength(chunk);
          if (remaining <= 0 || chunkBytes > remaining) {
            request.destroy(new Error("接口响应过大"));
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            json = undefined;
          }
          resolve({ ok: status >= 200 && status < 300, status, json, bodyText: body });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(options.timeoutMs ?? 15_000, () => {
      request.destroy(new Error("请求超时"));
    });
    request.on("error", reject);
    request.end();
  });
}
