import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "release-assets");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  const source = resolve(root, name);
  const info = await stat(source);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing release asset: ${name}`);
  await copyFile(source, resolve(output, name));
  const hash = createHash("sha256").update(await readFile(source)).digest("hex");
  console.log(`${name}  ${hash}`);
}
