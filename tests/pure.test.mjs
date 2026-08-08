import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "obsidian-ai-chat-test-"));

await build({
  entryPoints: [
    path.join(root, "src/diffUtils.ts"),
    path.join(root, "src/contextParse.ts"),
    path.join(root, "src/activeNoteResolve.ts"),
    path.join(root, "src/turnContextSummary.ts"),
    path.join(root, "src/suggestionRank.ts"),
    path.join(root, "src/runWatchdog.ts"),
    path.join(root, "src/contextInventory.ts"),
    path.join(root, "src/imageEmbedRewrite.ts"),
    path.join(root, "src/historyFilter.ts"),
    path.join(root, "src/promptBuilder.ts"),
    path.join(root, "src/providers/sse.ts"),
    path.join(root, "src/providers/thinkFilter.ts"),
    path.join(root, "src/providers/openaiChat.ts"),
    path.join(root, "src/providers/openaiResponses.ts"),
    path.join(root, "src/providers/anthropic.ts"),
    path.join(root, "src/providers/types.ts"),
    path.join(root, "src/providers/index.ts"),
  ],
  outdir: outDir,
  format: "esm",
  platform: "node",
  bundle: true,
  packages: "external",
});

const load = (name) => import(pathToFileURL(path.join(outDir, name)).href);

const {
  extractCandidate,
  buildSimpleDiff,
  countDiffStats,
  parseProposedChanges,
  applyReplacements,
  materializeChange,
  normalizeVaultPath,
  isWritableVaultPath,
} = await load("diffUtils.js");
const { parseContextSelection, tagMatches } = await load("contextParse.js");
const { resolveActiveNotePath, activeNoteChipLabel } = await load("activeNoteResolve.js");
const { summarizeTurnContext, estimateExpansionCap, DEFAULT_CONTEXT_LIMITS } = await load(
  "turnContextSummary.js",
);
const { rankAtSuggestions, matchScore } = await load("suggestionRank.js");
const { resolveIdleTimeoutMs, RunWatchdog } = await load("runWatchdog.js");
const { buildContextInventory } = await load("contextInventory.js");
const { rewriteImageEmbeds, isHallucinatedImageName, attachmentVaultPaths } = await load(
  "imageEmbedRewrite.js",
);
const { sortConversationsForHistory, filterConversationsByQuery } = await load(
  "historyFilter.js",
);
const {
  DEFAULT_SYSTEM_PROMPT,
  hashText,
  planHistoryWindow,
  buildTurnMessages,
  collectSentHashes,
} = await load("promptBuilder.js");
const { SseParser } = await load("providers/sse.js");
const { ThinkTagFilter } = await load("providers/thinkFilter.js");
const { buildChatCompletionsBody, handleChatCompletionsData } = await load(
  "providers/openaiChat.js",
);
const { buildResponsesBody, handleResponsesData } = await load("providers/openaiResponses.js");
const { buildAnthropicBody, resolveThinkingBudget, handleAnthropicData } = await load(
  "providers/anthropic.js",
);
const {
  anthropicBudgetForEffort,
  parseExtraHeaders,
  resolveEffectiveEffort,
  normalizeReasoningEffort,
  profileForPersistence,
  sanitizeProviderErrorText,
} = await load("providers/types.js");
const { buildHeaders, validateProfile } = await load("providers/index.js");

// ── helpers ──────────────────────────────────────────────────────────────

function profile(overrides = {}) {
  return {
    id: "p1",
    name: "测试",
    kind: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    rememberSensitiveFields: false,
    model: "gpt-test",
    reasoningEffort: "default",
    reasoningSummary: "",
    verbosity: "",
    ...overrides,
  };
}

function textMessage(role, text) {
  return { role, content: [{ type: "text", text }] };
}

// ── diffUtils (kept behavior) ────────────────────────────────────────────

test("extractCandidate prefers whole-message fenced markdown", () => {
  assert.equal(extractCandidate("```md\n# Title\nbody\n```"), "# Title\nbody");
});

test("extractCandidate picks largest fenced block when mixed prose", () => {
  const text = [
    "Here is the edit:",
    "```markdown",
    "line1",
    "line2",
    "line3",
    "```",
    "Also a tiny one:",
    "```md",
    "x",
    "```",
  ].join("\n");
  assert.equal(extractCandidate(text), "line1\nline2\nline3");
});

test("buildSimpleDiff highlights changed middle", () => {
  const diff = buildSimpleDiff("a\nb\nc", "a\nB\nc");
  assert.match(diff, /^- b$/m);
  assert.match(diff, /^\+ B$/m);
});

test("countDiffStats counts added and removed lines", () => {
  const stats = countDiffStats("a\nb\nc", "a\nx\ny\nc");
  assert.equal(stats.removed, 1);
  assert.equal(stats.added, 2);
});

test("normalizeVaultPath cleans wiki links and slashes", () => {
  assert.equal(normalizeVaultPath("[[Notes/A.md|Alias]]"), "Notes/A.md");
  assert.equal(normalizeVaultPath(".\\Notes\\B.md"), "Notes/B.md");
});

test("normalizeVaultPath rejects traversal, absolute, and Obsidian internals", () => {
  assert.equal(normalizeVaultPath("../outside.md"), "");
  assert.equal(normalizeVaultPath("Notes/../../outside.md"), "");
  assert.equal(normalizeVaultPath("/absolute.md"), "");
  assert.equal(normalizeVaultPath("C:\\outside.md"), "");
  assert.equal(normalizeVaultPath(".trash/removed.md"), "");
  assert.equal(isWritableVaultPath(".obsidian/plugins/example/main.js", ".obsidian"), false);
  assert.equal(isWritableVaultPath("_config/plugins/example/main.js", "_config"), false);
  assert.equal(isWritableVaultPath("Notes/safe.md", ".obsidian"), true);
});

test("parseProposedChanges reads multi-file fenced paths", () => {
  const text = ["```md:Notes/a.md", "# A", "```", "```md:Notes/b.md", "# B", "```"].join("\n");
  const changes = parseProposedChanges(text);
  assert.equal(changes.length, 2);
  assert.equal(changes.find((c) => c.path === "Notes/a.md")?.content, "# A");
});

test("parseProposedChanges reads SEARCH/REPLACE partials", () => {
  const text = [
    "### Notes/a.md",
    "<<<<<<< SEARCH",
    "old",
    "=======",
    "new",
    ">>>>>>> REPLACE",
  ].join("\n");
  const changes = parseProposedChanges(text);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "partial");
  assert.deepEqual(changes[0].replacements, [{ search: "old", replace: "new" }]);
});

test("applyReplacements requires unique match", () => {
  assert.equal(applyReplacements("a\nb\nc", [{ search: "b", replace: "B" }]).ok, true);
  assert.equal(applyReplacements("a", [{ search: "z", replace: "Z" }]).ok, false);
  assert.equal(applyReplacements("x x", [{ search: "x", replace: "y" }]).ok, false);
});

test("materializeChange creates full file and applies partial", () => {
  const created = materializeChange("", { path: "n.md", kind: "full", content: "hi" }, false);
  assert.equal(created.ok && created.kind, "create");
  const partial = materializeChange(
    "hello world",
    { path: "n.md", kind: "partial", replacements: [{ search: "world", replace: "vault" }] },
    true,
  );
  assert.equal(partial.ok && partial.after, "hello vault");
});

// ── context parsing / summary (kept behavior) ───────────────────────────

test("parseContextSelection extracts tags only (ignores @ file/folder tokens)", () => {
  const parsed = parseContextSelection("see @[[Notes/A.md]] and @{Projects} #work/todo more #work");
  assert.deepEqual(parsed.filePaths, []);
  assert.deepEqual(parsed.folderPaths, []);
  assert.deepEqual(parsed.tags, ["work/todo", "work"]);
});

test("tagMatches supports hierarchical tags", () => {
  assert.equal(tagMatches("work/todo", "work"), true);
  assert.equal(tagMatches("play", "work"), false);
});

test("resolveActiveNotePath prefers current Markdown then last-focused", () => {
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: true,
      currentMarkdownPath: null,
      lastMarkdownPath: "Notes/old.md",
    }),
    "Notes/old.md",
  );
  assert.equal(
    resolveActiveNotePath({
      includeActiveNote: false,
      currentMarkdownPath: "Notes/now.md",
      lastMarkdownPath: null,
    }),
    null,
  );
});

test("activeNoteChipLabel shows basename or none", () => {
  assert.equal(activeNoteChipLabel("Folder/周报.md"), "周报");
  assert.equal(activeNoteChipLabel(null), "无笔记");
});

test("summarizeTurnContext reports truncation", () => {
  const summary = summarizeTurnContext({
    includeActiveNote: true,
    activeNotePath: "Notes/a.md",
    draftMessage: "#work",
    attachmentCount: 1,
    expandedPathCount: 32,
    expansionCapped: true,
  });
  assert.equal(summary.truncated, true);
  assert.match(summary.line, /已截断/);
  assert.match(summary.line, /\ba\b/);
  assert.match(summary.line, /#1/);
  assert.match(summary.line, /图1/);
  assert.equal(summary.fileCount, 0);
  assert.equal(summary.folderCount, 0);
});

test("estimateExpansionCap enforces limits", () => {
  const selection = parseContextSelection("#work");
  const result = estimateExpansionCap(selection, [], [25]);
  assert.equal(result.expansionCapped, true);
  assert.ok(result.expandedPathCount <= DEFAULT_CONTEXT_LIMITS.maxExpandedPaths);
});

test("buildContextInventory exposes removable tag items and reasons", () => {
  const inventory = buildContextInventory({
    includeActiveNote: true,
    activeNotePath: "Notes/a.md",
    openTabPaths: ["Notes/b.md"],
    draftMessage: "@[[c.md]] @{Projects} #work",
    attachmentCount: 1,
    expandedPaths: Array.from({ length: 40 }, (_, index) => `Notes/${index}.md`),
    expansionCapped: true,
    limits: { maxExpandedPaths: 32, maxFilesPerFolder: 20, maxFilesPerTag: 20 },
  });
  assert.equal(inventory.truncated, true);
  assert.ok(inventory.items.some((item) => item.token === "#work" && item.removable));
  assert.ok(!inventory.items.some((item) => item.kind === "file" || item.kind === "folder"));
});

test("rankAtSuggestions prefers recent files for empty query", () => {
  const ranked = rankAtSuggestions(
    [
      { kind: "file", key: "old.md", title: "old.md", subtitle: "", mtime: 1 },
      { kind: "file", key: "new.md", title: "new.md", subtitle: "", mtime: 99 },
    ],
    "",
    { limit: 10, recentBiasMaxQueryLen: 1 },
  );
  assert.equal(ranked[0].key, "new.md");
  assert.equal(matchScore("alpha.md", "root", "alp"), 0);
  assert.equal(matchScore("beta.md", "root", "zzz"), 99);
});

test("historyFilter sorts pinned first and searches bodies", () => {
  const conversations = [
    { id: "a", title: "普通", messages: [{ text: "hello" }], updatedAt: 2 },
    { id: "b", title: "置顶", messages: [], pinned: true, updatedAt: 1 },
  ];
  assert.equal(sortConversationsForHistory(conversations)[0].id, "b");
  assert.equal(filterConversationsByQuery(conversations, "hello")[0].id, "a");
});

test("RunWatchdog fires idle timeout and touch resets it", async () => {
  let fired = "";
  const dog = new RunWatchdog(60_000, 40, (_reason, message) => {
    fired = message;
  });
  dog.touch();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, "");
  dog.touch();
  await new Promise((r) => setTimeout(r, 70));
  assert.match(fired, /无进度/);
  dog.dispose();
});

test("resolveIdleTimeoutMs caps idle by total and floors at 5s", () => {
  assert.equal(resolveIdleTimeoutMs(600_000, 120_000), 120_000);
  assert.equal(resolveIdleTimeoutMs(30_000, 120_000), 30_000);
  assert.equal(resolveIdleTimeoutMs(60_000, 1_000), 5_000);
});

// ── image embed rewrite (kept behavior) ─────────────────────────────────

test("isHallucinatedImageName detects session-style image ids", () => {
  assert.equal(isHallucinatedImageName("image-ca30f9c0-0de2-406c-9a7c-b534140f21b4.png"), true);
  assert.equal(isHallucinatedImageName("AI Chat Screenshot 2026-07-20-06-07-17-56-1.png"), false);
});

test("rewriteImageEmbeds fixes hallucinated embeds to real vault paths", () => {
  const known = ["AI Chat Screenshot 2026-07-20-06-07-17-56-1.png"];
  const result = rewriteImageEmbeds("![[image-ca30f9c0-0de2-406c-9a7c-b534140f21b4.png]]", known);
  assert.match(result.text, /AI Chat Screenshot/);
  assert.equal(result.rewrites.length, 1);
});

test("attachmentVaultPaths dedupes and skips empty", () => {
  assert.deepEqual(
    attachmentVaultPaths([{ path: "a.png" }, { path: "a.png" }, { path: "" }, null, { path: "b.png" }]),
    ["a.png", "b.png"],
  );
});

// ── SSE parser ───────────────────────────────────────────────────────────

test("SseParser handles chunk boundaries and event names", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push("event: message_start\nda");
  parser.push('ta: {"a":1}\n\ndata: {"b":2}\n');
  parser.push("\ndata: [DO");
  parser.push("NE]\n\n");
  parser.flush();
  assert.deepEqual(events, [
    { event: "message_start", data: '{"a":1}' },
    { event: undefined, data: '{"b":2}' },
    { event: undefined, data: "[DONE]" },
  ]);
});

test("SseParser joins multi-line data and skips comments", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push(": keep-alive\n\ndata: line1\ndata: line2\n\n");
  assert.deepEqual(events, [{ event: undefined, data: "line1\nline2" }]);
});

// ── think tag filter ─────────────────────────────────────────────────────

test("ThinkTagFilter splits think segments across chunks", () => {
  const filter = new ThinkTagFilter();
  let text = "";
  let reasoning = "";
  for (const chunk of ["<thi", "nk>思考", "内容</th", "ink>正式", "回答"]) {
    const out = filter.push(chunk);
    text += out.text;
    reasoning += out.reasoning;
  }
  const tail = filter.flush();
  text += tail.text;
  reasoning += tail.reasoning;
  assert.equal(text, "正式回答");
  assert.equal(reasoning, "思考内容");
});

test("ThinkTagFilter passes plain text through", () => {
  const filter = new ThinkTagFilter();
  const out = filter.push("hello world");
  const tail = filter.flush();
  assert.equal(out.text + tail.text, "hello world");
  assert.equal(out.reasoning + tail.reasoning, "");
});

// ── OpenAI Chat Completions adapter ──────────────────────────────────────

test("buildChatCompletionsBody sends effort, cache key and plain string content", () => {
  const body = buildChatCompletionsBody(
    profile({ reasoningEffort: "default", maxOutputTokens: 2048, temperature: 0.7 }),
    {
      messages: [textMessage("system", "sys"), textMessage("user", "hi")],
      effort: "high",
      cacheKey: "chat-1",
    },
  );
  assert.equal(body.model, "gpt-test");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.prompt_cache_key, "chat-1");
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.messages[1], { role: "user", content: "hi" });
});

test("buildChatCompletionsBody uses local-friendly fields for localhost", () => {
  const body = buildChatCompletionsBody(
    profile({
      baseUrl: "http://127.0.0.1:11434/v1",
      maxOutputTokens: 512,
    }),
    {
      messages: [textMessage("user", "hi")],
      effort: "default",
      cacheKey: "chat-local",
    },
  );
  assert.equal(body.max_tokens, 512);
  assert.equal("max_completion_tokens" in body, false);
  assert.equal("stream_options" in body, false);
  assert.equal("prompt_cache_key" in body, false);
});

test("buildChatCompletionsBody omits unset params and uses parts for images", () => {
  const body = buildChatCompletionsBody(profile(), {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", mimeType: "image/png", dataBase64: "AAA" },
          { type: "text", text: "看图" },
        ],
      },
    ],
    effort: "default",
  });
  assert.equal("reasoning_effort" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal("max_completion_tokens" in body, false);
  const content = body.messages[0].content;
  assert.equal(content[0].type, "image_url");
  assert.match(content[0].image_url.url, /^data:image\/png;base64,AAA$/);
  assert.deepEqual(content[1], { type: "text", text: "看图" });
});

test("handleChatCompletionsData routes deltas, reasoning and usage", () => {
  const got = { text: "", reasoning: "", usage: null };
  const handlers = {
    onTextDelta: (t) => (got.text += t),
    onReasoningDelta: (t) => (got.reasoning += t),
    onUsage: (u) => (got.usage = u),
  };
  handleChatCompletionsData({ choices: [{ delta: { reasoning_content: "想" } }] }, handlers);
  handleChatCompletionsData({ choices: [{ delta: { content: "答" } }] }, handlers);
  handleChatCompletionsData(
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens: 20,
      },
    },
    handlers,
  );
  assert.equal(got.text, "答");
  assert.equal(got.reasoning, "想");
  assert.equal(got.usage.inputTokens, 100);
  assert.equal(got.usage.cachedInputTokens, 80);
  assert.throws(() => handleChatCompletionsData({ error: { message: "boom" } }, handlers), /boom/);
});

// ── OpenAI Responses adapter ─────────────────────────────────────────────

test("buildResponsesBody maps roles, reasoning and store=false", () => {
  const body = buildResponsesBody(
    profile({ kind: "openai-responses", reasoningSummary: "auto", verbosity: "low" }),
    {
      messages: [
        textMessage("system", "sys"),
        textMessage("user", "hi"),
        textMessage("assistant", "prev"),
      ],
      effort: "xhigh",
      cacheKey: "chat-9",
    },
  );
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.deepEqual(body.text, { verbosity: "low" });
  assert.equal(body.prompt_cache_key, "chat-9");
  assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "sys" }]);
  assert.deepEqual(body.input[2].content, [{ type: "output_text", text: "prev" }]);
});

test("buildResponsesBody sends max reasoning effort", () => {
  const body = buildResponsesBody(profile({ kind: "openai-responses" }), {
    messages: [textMessage("user", "hard")],
    effort: "max",
  });
  assert.deepEqual(body.reasoning, { effort: "max" });
});

test("handleResponsesData handles deltas, summary and completion usage", () => {
  const got = { text: "", reasoning: "", usage: null };
  const handlers = {
    onTextDelta: (t) => (got.text += t),
    onReasoningDelta: (t) => (got.reasoning += t),
    onUsage: (u) => (got.usage = u),
  };
  handleResponsesData({ type: "response.output_text.delta", delta: "你好" }, handlers);
  handleResponsesData({ type: "response.reasoning_summary_text.delta", delta: "推理" }, handlers);
  handleResponsesData(
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
    handlers,
  );
  assert.equal(got.text, "你好");
  assert.equal(got.reasoning, "推理");
  assert.equal(got.usage.cachedInputTokens, 30);
  assert.equal(got.usage.reasoningTokens, 4);
  assert.throws(
    () => handleResponsesData({ type: "response.failed", response: { error: { message: "bad" } } }, handlers),
    /bad/,
  );
});

// ── Anthropic adapter ────────────────────────────────────────────────────

test("anthropic budgets map effort levels", () => {
  assert.equal(anthropicBudgetForEffort("low"), 4096);
  assert.equal(anthropicBudgetForEffort("high"), 24576);
  assert.equal(anthropicBudgetForEffort("max"), 65536);
  assert.equal(anthropicBudgetForEffort("default"), null);
  assert.equal(
    resolveThinkingBudget(profile({ kind: "anthropic", thinkingBudgetTokens: 5000 }), "default"),
    5000,
  );
  // Explicit budget wins even when the chat chip picks a named level.
  assert.equal(
    resolveThinkingBudget(profile({ kind: "anthropic", thinkingBudgetTokens: 5000 }), "low"),
    5000,
  );
  assert.equal(resolveThinkingBudget(profile({ kind: "anthropic" }), "low"), 4096);
});

test("normalizeReasoningEffort drops legacy none/minimal to low", () => {
  assert.equal(normalizeReasoningEffort("none"), "low");
  assert.equal(normalizeReasoningEffort("minimal"), "low");
  assert.equal(normalizeReasoningEffort("max"), "max");
  assert.equal(normalizeReasoningEffort("bogus"), "default");
});

test("resolveEffectiveEffort follows profile when chat override is default", () => {
  assert.equal(resolveEffectiveEffort(undefined, "high"), "high");
  assert.equal(resolveEffectiveEffort("default", "medium"), "medium");
  assert.equal(resolveEffectiveEffort("low", "high"), "low");
  assert.equal(resolveEffectiveEffort("max", "high"), "max");
});

test("buildAnthropicBody places cache breakpoints and thinking budget", () => {
  const body = buildAnthropicBody(
    profile({ kind: "anthropic", model: "claude-test", temperature: 0.5 }),
    {
      messages: [
        textMessage("system", "sys"),
        textMessage("user", "第一问"),
        textMessage("assistant", "第一答"),
        textMessage("user", "第二问"),
      ],
      effort: "medium",
    },
  );
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  const last = body.messages[body.messages.length - 1];
  assert.deepEqual(last.content[last.content.length - 1].cache_control, { type: "ephemeral" });
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 10240 });
  // temperature must be omitted while thinking is on
  assert.equal("temperature" in body, false);
  assert.ok(body.max_tokens > 10240);
});

test("buildAnthropicBody coalesces consecutive same-role turns", () => {
  const body = buildAnthropicBody(profile({ kind: "anthropic" }), {
    messages: [
      textMessage("assistant", "孤儿助手消息"),
      textMessage("user", "一"),
      textMessage("user", "二"),
      textMessage("assistant", "答"),
      textMessage("user", "三"),
    ],
    effort: "default",
  });
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages.length, 3);
  assert.match(body.messages[0].content[0].text, /一\n\n二/);
  assert.equal("thinking" in body, false);
});

test("handleAnthropicData maps thinking/text deltas and normalized usage", () => {
  const got = { text: "", reasoning: "", usage: {} };
  const handlers = {
    onTextDelta: (t) => (got.text += t),
    onReasoningDelta: (t) => (got.reasoning += t),
    onUsage: (u) => Object.assign(got.usage, u),
  };
  handleAnthropicData(
    {
      type: "message_start",
      message: {
        usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
      },
    },
    handlers,
  );
  handleAnthropicData(
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思" } },
    handlers,
  );
  handleAnthropicData(
    { type: "content_block_delta", delta: { type: "text_delta", text: "答" } },
    handlers,
  );
  handleAnthropicData({ type: "message_delta", usage: { output_tokens: 7 } }, handlers);
  assert.equal(got.reasoning, "思");
  assert.equal(got.text, "答");
  assert.equal(got.usage.inputTokens, 105);
  assert.equal(got.usage.cachedInputTokens, 90);
  assert.equal(got.usage.outputTokens, 7);
  assert.throws(
    () => handleAnthropicData({ type: "error", error: { message: "overloaded" } }, handlers),
    /overloaded/,
  );
});

test("parseExtraHeaders parses name:value lines", () => {
  assert.deepEqual(parseExtraHeaders("X-A: 1\n bad line \nX-B: two words "), {
    "x-a": "1",
    "x-b": "two words",
  });
});

test("parseExtraHeaders blocks request-smuggling and session headers", () => {
  assert.deepEqual(
    parseExtraHeaders(
      "Host: attacker.invalid\nContent-Length: 1\nTransfer-Encoding: chunked\nCookie: session=value\nAuthorization: Custom token",
    ),
    { authorization: "Custom token" },
  );
});

test("buildHeaders keeps built-in authentication authoritative", () => {
  const headers = buildHeaders(
    profile({ extraHeaders: "Authorization: Custom value\nHost: attacker.invalid" }),
  );
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.equal(headers.host, undefined);
});

test("provider validation requires HTTPS except on loopback", () => {
  assert.doesNotThrow(() => validateProfile(profile()));
  assert.doesNotThrow(() =>
    validateProfile(profile({ baseUrl: "http://127.0.0.1:11434/v1" })),
  );
  assert.throws(
    () => validateProfile(profile({ baseUrl: "http://api.example.com/v1" })),
    /HTTPS/,
  );
  assert.throws(
    () => validateProfile(profile({ baseUrl: "file:///tmp/provider" })),
    /HTTP/,
  );
  assert.throws(
    () =>
      validateProfile(
        profile({ baseUrl: ["https://user", "pass@api.example.com/v1"].join(":") }),
      ),
    /用户名或密码/,
  );
});

test("sensitive profile fields are memory-only unless explicitly remembered", () => {
  const transient = profileForPersistence(
    profile({ extraHeaders: "Authorization: Custom value" }),
  );
  assert.equal(transient.apiKey, "");
  assert.equal(transient.extraHeaders, "");
  const remembered = profileForPersistence(
    profile({ rememberSensitiveFields: true, extraHeaders: "X-Relay: value" }),
  );
  assert.equal(remembered.apiKey, "sk-test");
  assert.equal(remembered.extraHeaders, "X-Relay: value");
});

test("provider errors redact common credential forms", () => {
  const synthetic = ["Bear", "er token-value-123456", " ", "sk-", "example123456789"].join("");
  const safe = sanitizeProviderErrorText(synthetic);
  assert.doesNotMatch(safe, /token-value/);
  assert.doesNotMatch(safe, /example123/);
  assert.match(safe, /redacted/);
});

// ── prompt builder ───────────────────────────────────────────────────────

test("hashText is stable and length-aware", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("planHistoryWindow keeps start until budget exceeded, then jumps", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? "assistant" : "user",
    text: "x".repeat(100),
    createdAt: index,
    status: "complete",
  }));
  const fits = planHistoryWindow(messages, undefined, 10_000);
  assert.equal(fits.window.length, 10);
  assert.equal(fits.startMessageId, "m0");
  assert.equal(fits.dropped, false);

  // Same start remains while under budget → stable prefix.
  const again = planHistoryWindow(messages, "m2", 10_000);
  assert.equal(again.startMessageId, "m2");
  assert.equal(again.window.length, 8);

  // Over budget → jump toward the ~60% target, but never below the 4-message floor.
  const over = planHistoryWindow(messages, undefined, 450);
  assert.equal(over.dropped, true);
  assert.equal(over.window.length, 4);
  assert.equal(over.startMessageId, "m6");

  // A roomier budget trims down to the 60% target exactly.
  const roomy = planHistoryWindow(messages, undefined, 900);
  assert.equal(roomy.dropped, true);
  assert.ok(roomy.window.reduce((sum, m) => sum + m.text.length, 0) <= 900 * 0.6);
});

test("buildTurnMessages dedupes unchanged files and records attachments", () => {
  const noteBody = "# 笔记\n正文内容";
  const hash = hashText(noteBody);
  const history = [
    {
      id: "u1",
      role: "user",
      text: "第一问",
      apiText: "第一问",
      createdAt: 1,
      status: "complete",
      contextAttachments: [{ path: "Notes/a.md", hash, full: true }],
    },
    { id: "a1", role: "assistant", text: "第一答", createdAt: 2, status: "complete" },
  ];
  const out = buildTurnMessages({
    windowMessages: history,
    userText: "第二问",
    contextFiles: [
      { path: "Notes/a.md", title: "a", content: noteBody },
      { path: "Notes/b.md", title: "b", content: "新文件" },
    ],
    imagePaths: [],
    imageParts: new Map(),
    maxCharsTotal: 10_000,
  });
  assert.match(out.apiText, /referenced_file_unchanged path="Notes\/a\.md"/);
  assert.match(out.apiText, /<referenced_file path="Notes\/b\.md"/);
  assert.match(out.apiText, /第二问/);
  const records = Object.fromEntries(out.contextAttachments.map((r) => [r.path, r.full]));
  assert.equal(records["Notes/a.md"], false);
  assert.equal(records["Notes/b.md"], true);
  // System prompt leads; history replays verbatim; current turn is last.
  assert.equal(out.messages[0].role, "system");
  assert.match(out.messages[0].content[0].text, /Obsidian vault/);
  assert.equal(out.messages[1].content[0].text, "第一问");
  assert.equal(out.messages[3].role, "user");
});

test("buildTurnMessages re-attaches changed files and respects total budget", () => {
  const oldHash = hashText("旧内容");
  const out = buildTurnMessages({
    windowMessages: [
      {
        id: "u1",
        role: "user",
        text: "q",
        apiText: "q",
        createdAt: 1,
        status: "complete",
        contextAttachments: [{ path: "Notes/a.md", hash: oldHash, full: true }],
      },
    ],
    userText: "再看看",
    contextFiles: [
      { path: "Notes/a.md", title: "a", content: "新内容不一样了" },
      { path: "Notes/big.md", title: "big", content: "x".repeat(500) },
    ],
    imagePaths: [],
    imageParts: new Map(),
    maxCharsTotal: 100,
  });
  assert.match(out.apiText, /<referenced_file path="Notes\/a\.md"/);
  assert.equal(out.contentTruncated, true);
  const record = out.contextAttachments.find((r) => r.path === "Notes/big.md");
  // Truncated bodies must not be recorded as fully sent.
  assert.equal(record, undefined);
});

test("buildTurnMessages skips empty history and appends selection + images info", () => {
  const out = buildTurnMessages({
    windowMessages: [
      { id: "e1", role: "assistant", text: "", createdAt: 1, status: "error" },
    ],
    userText: "",
    contextFiles: [],
    selectionText: "选中的文字",
    imagePaths: ["shots/a.png"],
    imageParts: new Map([
      ["shots/a.png", { type: "image", mimeType: "image/png", dataBase64: "AA" }],
    ]),
    maxCharsTotal: 1000,
  });
  // system + current user only (empty error turn dropped)
  assert.equal(out.messages.length, 2);
  const current = out.messages[1];
  assert.equal(current.content[0].type, "image");
  assert.match(out.apiText, /<selection/);
  assert.match(out.apiText, /shots\/a\.png/);
  assert.match(out.apiText, /请分析附加的图片。/);
});

test("collectSentHashes takes the latest full copy", () => {
  const sent = collectSentHashes([
    {
      id: "1",
      role: "user",
      text: "",
      createdAt: 1,
      status: "complete",
      contextAttachments: [{ path: "a.md", hash: "h1", full: true }],
    },
    {
      id: "2",
      role: "user",
      text: "",
      createdAt: 2,
      status: "complete",
      contextAttachments: [
        { path: "a.md", hash: "h2", full: true },
        { path: "b.md", hash: "hb", full: false },
      ],
    },
  ]);
  assert.equal(sent.get("a.md"), "h2");
  assert.equal(sent.has("b.md"), false);
});

test("DEFAULT_SYSTEM_PROMPT keeps the edit-proposal contract", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /SEARCH/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /md:Notes\/example\.md/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /referenced_file_unchanged/);
});

// ── source wiring ────────────────────────────────────────────────────────

test("source wiring: view, runner, providers and main are connected", () => {
  const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
  const view = readFileSync(path.join(root, "src/chatView.ts"), "utf8");
  const runner = readFileSync(path.join(root, "src/apiRunner.ts"), "utf8");
  const providers = readFileSync(path.join(root, "src/providers/index.ts"), "utf8");
  const settings = readFileSync(path.join(root, "src/settings.ts"), "utf8");

  assert.match(main, /planHistoryWindow|buildTurn/);
  assert.match(main, /prompt_cache_key|cacheKey/);
  assert.match(main, /updateMessageIn/);
  assert.match(main, /setPinned/);
  assert.match(main, /runningConversationId/);
  assert.match(main, /rewriteImageEmbeds|rewriteAssistantImageEmbeds/);
  assert.match(view, /aichat-toolbar/);
  assert.match(view, /openModelMenu/);
  assert.match(view, /openReasoningMenu/);
  assert.match(view, /formatUsageLine/);
  assert.match(view, /isComposing/);
  assert.match(runner, /ThinkTagFilter/);
  assert.match(runner, /RunWatchdog/);
  assert.match(runner, /AbortController/);
  assert.match(providers, /resolveEndpoint/);
  assert.match(providers, /testConnection/);
  assert.match(providers, /listModels/);
  assert.match(settings, /测试连接/);
  assert.match(settings, /bindNumberField/);
});

test.after(() => {
  rmSync(outDir, { recursive: true, force: true });
});
