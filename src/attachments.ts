import { App, TFile } from "obsidian";
import type { ChatAttachment } from "./chatTypes";
import type { NeutralContentImage } from "./providers/types";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function imageMime(file: File): string {
  return file.type.startsWith("image/") ? file.type : "image/png";
}

async function pngBuffer(file: File): Promise<ArrayBuffer> {
  const original = await file.arrayBuffer();
  if (imageMime(file) === "image/png" && original.byteLength <= MAX_IMAGE_BYTES) {
    return original;
  }

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = createEl("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建图片画布");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("图片转换失败"))), "image/png");
    });
    const converted = await blob.arrayBuffer();
    if (converted.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片过大，请粘贴较小的截图");
    }
    return converted;
  } finally {
    bitmap.close();
  }
}

function attachmentName(index: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .slice(0, 22);
  return `AI Chat Screenshot ${stamp}-${index + 1}.png`;
}

export async function saveImageFiles(
  app: App,
  files: File[],
  sourcePath?: string,
): Promise<ChatAttachment[]> {
  const saved: ChatAttachment[] = [];
  for (const [index, file] of files.slice(0, 4).entries()) {
    if (!file.type.startsWith("image/") && !file.name.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
      continue;
    }
    const data = await pngBuffer(file);
    const path = await app.fileManager.getAvailablePathForAttachment(attachmentName(index), sourcePath);
    const created = await app.vault.createBinary(path, data);
    saved.push({
      id: `${created.path}-${created.stat.mtime}`,
      path: created.path,
      name: created.name,
      mimeType: "image/png",
      kind: "image",
    });
  }
  return saved;
}

export function attachmentResourcePath(app: App, attachment: ChatAttachment): string {
  return app.vault.adapter.getResourcePath(attachment.path);
}

/** Read a vault image and encode it for the API (base64 data). */
export async function encodeVaultImage(
  app: App,
  path: string,
  mimeType = "image/png",
): Promise<NeutralContentImage | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  try {
    const binary = await app.vault.readBinary(file);
    return {
      type: "image",
      mimeType,
      dataBase64: Buffer.from(binary).toString("base64"),
    };
  } catch {
    return null;
  }
}

/** True for images created by this plugin (safe to auto-delete on cleanup). */
export function isPluginManagedScreenshot(pathOrName: string): boolean {
  const name = pathOrName.split(/[/\\]/).pop() ?? pathOrName;
  return /^(AI Chat|Grok) Screenshot /i.test(name);
}

export async function deleteVaultFiles(app: App, paths: string[]): Promise<number> {
  let deleted = 0;
  for (const path of Array.from(new Set(paths))) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    try {
      await app.fileManager.trashFile(file);
      deleted += 1;
    } catch {
      /* ignore missing/locked */
    }
  }
  return deleted;
}
