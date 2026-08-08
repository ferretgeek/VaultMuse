import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(resolve(root, "demo/favicon.svg"));
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, index) => {
  const size = sizes[index]; const position = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, position); header.writeUInt8(size === 256 ? 0 : size, position + 1);
  header.writeUInt8(0, position + 2); header.writeUInt8(0, position + 3);
  header.writeUInt16LE(1, position + 4); header.writeUInt16LE(32, position + 6);
  header.writeUInt32LE(image.length, position + 8); header.writeUInt32LE(offset, position + 12); offset += image.length;
});
await writeFile(resolve(root, "demo/favicon.ico"), Buffer.concat([header, ...images]));
await sharp(svg).resize(180, 180).png({ compressionLevel: 9 }).toFile(resolve(root, "demo/apple-touch-icon.png"));
