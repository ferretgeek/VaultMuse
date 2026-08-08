/**
 * Lightweight streaming Markdown preview before full Obsidian MarkdownRenderer
 * runs on completion. Keeps long replies bounded for plain-text display.
 */
export function formatStreamingMarkdownPreview(text: string, maxChars = 120_000): string {
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}
