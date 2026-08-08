import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = resolve(fileURLToPath(new URL("../demo/", import.meta.url)));
const types = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".ico", "image/x-icon"],
]);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const candidate = resolve(demoRoot, pathname === "/" ? "index.html" : `.${pathname}`);
    if (candidate !== demoRoot && !candidate.startsWith(`${demoRoot}${sep}`)) {
      response.writeHead(404).end("Not found"); return;
    }
    const body = await readFile(candidate);
    response.writeHead(200, {
      "Content-Type": types.get(extname(candidate)) ?? "application/octet-stream",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(4173, "127.0.0.1", () => console.log("VaultMuse demo: http://127.0.0.1:4173"));
