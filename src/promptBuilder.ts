import type {
  ChatMessage,
  ContextAttachmentRecord,
} from "./chatTypes";
import type {
  NeutralContentImage,
  NeutralMessage,
} from "./providers/types";

/**
 * Cache-friendly turn assembly:
 * - one byte-stable system prompt (never carries volatile data);
 * - history replayed verbatim from each message's stored apiText;
 * - vault context appended only to the current user message, and file bodies
 *   deduped by content hash against copies already inside the request window;
 * - the window start moves rarely (hysteresis) so the prompt prefix stays
 *   identical across turns and provider prefix caches keep hitting.
 */

export const DEFAULT_SYSTEM_PROMPT: string = [
  "You are an AI assistant living inside the user's Obsidian vault — a thoughtful chat companion for reading, thinking, and writing notes.",
  "",
  "## Conversation",
  "- Mirror the user's language (usually Simplified Chinese) and register; be direct, warm, and concrete.",
  "- Answer first, then add only the detail that genuinely helps. Use clear Markdown — short paragraphs, lists, tables, or headings — when it aids reading, not by default.",
  "- If a request is ambiguous, make the most reasonable assumption and note it briefly; ask at most one focused question when truly blocked.",
  "",
  "## Vault context",
  "- Messages may carry context blocks: <context> with <referenced_file> bodies, <referenced_file_unchanged> markers (that file is unchanged since it was last shown in this conversation), <selection> for the user's current editor selection, and <attached_images> for images.",
  "- Treat this material as the user's own notes. Rely on it accurately; never claim a note says something it does not. If context looks truncated, say so when it matters.",
  "- Refer to notes by their vault paths when pointing the user somewhere.",
  "",
  "## Proposing note edits",
  "You cannot modify files yourself. When the user asks for edits, output proposals the plugin can preview and apply:",
  "1. Full file (create or replace) — a fenced block whose info string carries the vault path:",
  "```md:Notes/example.md",
  "...complete file body...",
  "```",
  "2. Partial edit — a heading line with the path, then one or more unique SEARCH/REPLACE blocks:",
  "### Notes/example.md",
  "<<<<<<< SEARCH",
  "exact existing text (must occur exactly once in the file)",
  "=======",
  "replacement text",
  ">>>>>>> REPLACE",
  "- Prefer SEARCH/REPLACE for small edits; use full-file blocks for new notes or heavy rewrites. Multiple files in one reply are fine.",
  "- Outside of edit proposals, never wrap your whole answer in a single code fence.",
  "",
  "## Images",
  "- Attached images are already saved in the vault at the exact paths listed in <attached_images>. To embed one in a note, write ![[exact/vault/path.png]]; never invent filenames and never ask the user to copy files into the vault.",
].join("\n");

/** Approximate prompt cost of one embedded image, in characters. */
const IMAGE_CHAR_ESTIMATE = 4000;

export function hashText(text: string): string {
  // djb2 — fast, deterministic, good enough for change detection.
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function messageChars(message: ChatMessage): number {
  const text = message.apiText ?? message.text;
  const images = (message.attachments ?? []).length * IMAGE_CHAR_ESTIMATE;
  return text.length + images;
}

export interface HistoryWindowPlan {
  window: ChatMessage[];
  startMessageId?: string;
  dropped: boolean;
}

/**
 * Choose which history messages join the request. The previous start id is
 * kept whenever the window still fits (stable prefix = cache hits); when the
 * budget is exceeded the start advances in one jump down to ~60% usage so the
 * next many turns keep an identical prefix again.
 */
export function planHistoryWindow(
  messages: ChatMessage[],
  previousStartId: string | undefined,
  maxChars: number,
): HistoryWindowPlan {
  const startIndex = previousStartId
    ? Math.max(
        0,
        messages.findIndex((message) => message.id === previousStartId),
      )
    : 0;
  let window = messages.slice(startIndex);
  let total = window.reduce((sum, message) => sum + messageChars(message), 0);
  if (total <= maxChars) {
    return {
      window,
      startMessageId: window[0]?.id ?? undefined,
      dropped: startIndex > 0,
    };
  }

  const target = Math.floor(maxChars * 0.6);
  const minKeep = Math.min(window.length, 4);
  while (window.length > minKeep && total > target) {
    const first = window[0];
    if (!first) break;
    total -= messageChars(first);
    window = window.slice(1);
  }
  return { window, startMessageId: window[0]?.id ?? undefined, dropped: true };
}

export interface ContextFileInput {
  path: string;
  title: string;
  /** Body already capped to the per-file char limit. */
  content: string;
  /** True when the per-file cap cut the body. */
  truncated?: boolean;
  /** Present when the file could not be read. */
  error?: string;
}

export interface BuildTurnInput {
  systemPrompt?: string;
  extraInstructions?: string;
  /** Messages included in the window (already planned), excluding the current turn. */
  windowMessages: ChatMessage[];
  userText: string;
  contextFiles: ContextFileInput[];
  selectionText?: string;
  /** Vault paths of images attached to the current turn. */
  imagePaths: string[];
  /** Encoded image parts keyed by vault path (current turn and history). */
  imageParts: Map<string, NeutralContentImage>;
  /** Total char budget across attached file bodies this turn. */
  maxCharsTotal: number;
}

export interface BuildTurnOutput {
  messages: NeutralMessage[];
  /** Exact text content sent for the current user turn (persist verbatim). */
  apiText: string;
  contextAttachments: ContextAttachmentRecord[];
  /** True when some file bodies were cut by per-file or total limits. */
  contentTruncated: boolean;
}

function textContent(text: string): NeutralMessage["content"] {
  return [{ type: "text", text }];
}

function historyMessageToNeutral(
  message: ChatMessage,
  imageParts: Map<string, NeutralContentImage>,
): NeutralMessage | null {
  const text = (message.apiText ?? message.text).trim() ? (message.apiText ?? message.text) : "";
  const images: NeutralContentImage[] = [];
  for (const attachment of message.attachments ?? []) {
    const part = imageParts.get(attachment.path);
    if (part) images.push(part);
  }
  if (!text && images.length === 0) return null;
  const content: NeutralMessage["content"] = [...images];
  if (text) content.push({ type: "text", text });
  return { role: message.role, content };
}

/** Collect path→hash of full file bodies already present inside the window. */
export function collectSentHashes(windowMessages: ChatMessage[]): Map<string, string> {
  const sent = new Map<string, string>();
  for (const message of windowMessages) {
    for (const record of message.contextAttachments ?? []) {
      if (record.full) sent.set(record.path, record.hash);
    }
  }
  return sent;
}

export function buildTurnMessages(input: BuildTurnInput): BuildTurnOutput {
  const sentHashes = collectSentHashes(input.windowMessages);
  const records: ContextAttachmentRecord[] = [];
  const contextBlocks: string[] = [];
  let attachedChars = 0;
  let contentTruncated = false;

  for (const file of input.contextFiles) {
    if (file.error) {
      contextBlocks.push(
        `<referenced_file_error path="${escapeXmlAttribute(file.path)}" error="${escapeXmlAttribute(file.error)}"/>`,
      );
      continue;
    }
    const hash = hashText(file.content);
    if (sentHashes.get(file.path) === hash) {
      contextBlocks.push(
        `<referenced_file_unchanged path="${escapeXmlAttribute(file.path)}" note="unchanged since last shown in this conversation"/>`,
      );
      records.push({ path: file.path, hash, full: false });
      continue;
    }
    const remaining = Math.max(0, input.maxCharsTotal - attachedChars);
    if (remaining <= 0) {
      contextBlocks.push(
        `<referenced_file_error path="${escapeXmlAttribute(file.path)}" error="Skipped: total context budget reached"/>`,
      );
      contentTruncated = true;
      continue;
    }
    const body = file.content.slice(0, remaining);
    const cut = Boolean(file.truncated) || body.length < file.content.length;
    if (cut) contentTruncated = true;
    attachedChars += body.length;
    contextBlocks.push(
      [
        `<referenced_file path="${escapeXmlAttribute(file.path)}" title="${escapeXmlAttribute(file.title)}">`,
        body + (cut ? "\n[Content truncated]" : ""),
        "</referenced_file>",
      ].join("\n"),
    );
    // Record only complete bodies so a truncated send is retried in full later.
    if (!cut) records.push({ path: file.path, hash, full: true });
  }

  const sections: string[] = [];
  if (contextBlocks.length > 0) {
    sections.push(["<context>", contextBlocks.join("\n\n"), "</context>"].join("\n"));
  }
  if (input.selectionText?.trim()) {
    sections.push(
      [
        '<selection note="the user\'s current selection in the active note">',
        input.selectionText,
        "</selection>",
      ].join("\n"),
    );
  }
  if (input.imagePaths.length > 0) {
    sections.push(
      [
        "<attached_images>",
        "These images are attached to this message and already saved in the vault at these exact vault-relative paths. Embed with ![[path]] using the exact path.",
        ...input.imagePaths.map((path, index) => `${index + 1}. ${path}`),
        "</attached_images>",
      ].join("\n"),
    );
  }
  const question = input.userText.trim() || "请分析附加的图片。";
  sections.push(question);
  const apiText = sections.join("\n\n");

  const system = [
    input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    input.extraInstructions?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n\n## Additional instructions\n");

  const messages: NeutralMessage[] = [{ role: "system", content: textContent(system) }];
  for (const message of input.windowMessages) {
    const neutral = historyMessageToNeutral(message, input.imageParts);
    if (neutral) messages.push(neutral);
  }

  const currentImages: NeutralContentImage[] = [];
  for (const path of input.imagePaths) {
    const part = input.imageParts.get(path);
    if (part) currentImages.push(part);
  }
  messages.push({
    role: "user",
    content: [...currentImages, { type: "text", text: apiText }],
  });

  return { messages, apiText, contextAttachments: records, contentTruncated };
}
