import {
  parseContextSelection,
  type ParsedContextSelection,
} from "./contextParse";
import {
  mergeContextLimits,
  type ContextLimits,
} from "./contextLimits";

export type { ContextLimits };
export { DEFAULT_CONTEXT_LIMITS, mergeContextLimits } from "./contextLimits";

export interface TurnContextSummaryInput {
  includeActiveNote: boolean;
  activeNotePath: string | null;
  draftMessage: string;
  attachmentCount: number;
  /** Expanded vault paths that would be read (after tag expansion, before char read). */
  expandedPathCount: number;
  /** True if tag expansion was cut by maxExpandedPaths or per-tag caps. */
  expansionCapped: boolean;
  /** True if file body content was cut by per-file or total char limits (set after read when known). */
  contentTruncated?: boolean;
  /** Optional selection character count for summary line. */
  selectionChars?: number;
  limits?: Partial<ContextLimits>;
}

export interface TurnContextSummary {
  activeNoteLabel: string | null;
  fileCount: number;
  folderCount: number;
  tagCount: number;
  attachmentCount: number;
  expandedPathCount: number;
  truncated: boolean;
  /** Short Chinese line for the context rail. */
  line: string;
}

export function summarizeTurnContext(input: TurnContextSummaryInput): TurnContextSummary {
  const limits = mergeContextLimits(input.limits);
  const selection = parseContextSelection(input.draftMessage, {
    files: limits.maxFilesInMessage,
    folders: limits.maxFoldersInMessage,
    tags: limits.maxTagsInMessage,
  });

  const rawTags = countRawMentions(input.draftMessage, /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu);

  const mentionCapped = rawTags > selection.tags.length;

  const truncated =
    Boolean(input.expansionCapped) ||
    Boolean(input.contentTruncated) ||
    mentionCapped ||
    input.expandedPathCount >= limits.maxExpandedPaths;

  const activeNoteLabel =
    input.includeActiveNote && input.activeNotePath
      ? basename(input.activeNotePath)
      : input.includeActiveNote
        ? null
        : undefined;

  // Short line for tooltips / inventory header only — not a second UI copy of the chips.
  const bits: string[] = [];
  if (activeNoteLabel) bits.push(activeNoteLabel);
  else if (input.includeActiveNote) bits.push("当前笔记");
  if (selection.tags.length) bits.push(`#${selection.tags.length}`);
  if (input.attachmentCount > 0) bits.push(`图${input.attachmentCount}`);
  if (input.selectionChars && input.selectionChars > 0) bits.push("选区");
  if (truncated) bits.push("已截断");

  return {
    activeNoteLabel: activeNoteLabel ?? null,
    fileCount: selection.filePaths.length,
    folderCount: selection.folderPaths.length,
    tagCount: selection.tags.length,
    attachmentCount: input.attachmentCount,
    expandedPathCount: input.expandedPathCount,
    truncated,
    line: bits.length ? bits.join(" · ") : "无附加上下文",
  };
}

/** Pure estimate of expansion caps without vault I/O. */
export function estimateExpansionCap(
  selection: ParsedContextSelection,
  folderHits: number[],
  tagHits: number[],
  limitsInput?: Partial<ContextLimits>,
): {
  expandedPathCount: number;
  expansionCapped: boolean;
} {
  const limits = mergeContextLimits(limitsInput);
  let count = selection.filePaths.length;
  let capped = false;

  for (const hits of folderHits) {
    const taken = Math.min(hits, limits.maxFilesPerFolder);
    if (hits > limits.maxFilesPerFolder) capped = true;
    count += taken;
  }
  for (const hits of tagHits) {
    const taken = Math.min(hits, limits.maxFilesPerTag);
    if (hits > limits.maxFilesPerTag) capped = true;
    count += taken;
  }

  if (count > limits.maxExpandedPaths) {
    capped = true;
    count = limits.maxExpandedPaths;
  }

  return { expandedPathCount: count, expansionCapped: capped };
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "") || name;
}

function countRawMentions(message: string, pattern: RegExp): number {
  return Array.from(message.matchAll(pattern)).length;
}
