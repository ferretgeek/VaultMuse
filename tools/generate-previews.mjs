import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source) throw new Error("Pass a real desktop browser screenshot path.");
await access(source);
const metadata = await sharp(source).metadata();
if (!metadata.width || !metadata.height || metadata.width < 1000) throw new Error("Expected a desktop screenshot.");
const image = sharp(source)
  .extract({ left: 0, top: 0, width: metadata.width - 15, height: metadata.height })
  .flatten({ background: "#edf6fb" });
const dashboard = resolve(root, "docs/images/dashboard.png");
const social = resolve(root, "docs/images/social-preview.png");
await image.clone().resize(1280, 720, { fit: "cover", position: "top" }).png({ compressionLevel: 9, palette: true, quality: 92 }).toFile(dashboard);
await image.clone().resize(1280, 640, { fit: "cover", position: "top" }).png({ compressionLevel: 9, palette: true, quality: 92 }).toFile(social);
if ((await stat(social)).size >= 1_000_000) throw new Error("Social preview must remain below 1 MB.");
