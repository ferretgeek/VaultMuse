import { Editor, MarkdownView, Menu, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  deleteVaultFiles,
  encodeVaultImage,
  isPluginManagedScreenshot,
  saveImageFiles,
} from "./attachments";
import { ChatStore } from "./chatStore";
import { activeNoteChipLabel, resolveActiveNotePath } from "./activeNoteResolve";
import { parseContextSelection, tagMatches } from "./contextParse";
import {
  createId,
  type ChatAttachment,
  type ChatMessage,
  type ChatSource,
  type ContextSelection,
  type PersistedChatState,
} from "./chatTypes";
import { ApplyDiffModal } from "./diffModal";
import { ApiRunner, type RunProgressEvent } from "./apiRunner";
import {
  PROVIDER_KIND_LABELS,
  normalizeReasoningEffort,
  profileForPersistence,
  resolveEffectiveEffort,
  type NeutralContentImage,
  type ProviderProfile,
  type ReasoningEffort,
} from "./providers";
import {
  buildTurnMessages,
  planHistoryWindow,
  type ContextFileInput,
} from "./promptBuilder";
import { ChatHistoryModal } from "./historyModal";
import { ContextInventoryModal } from "./contextInventoryModal";
import { ConfirmModal } from "./confirmModal";
import { ChatPanelView, AI_CHAT_VIEW_TYPE, type ModelChoice } from "./chatView";
import {
  activeProfile,
  profileDisplayName,
  AiChatSettingTab,
  DEFAULT_SETTINGS,
  type PluginSettings,
} from "./settings";
import {
  DEFAULT_CONTEXT_LIMITS,
  mergeContextLimits,
  estimateExpansionCap,
  summarizeTurnContext,
} from "./turnContextSummary";
import { buildContextInventory, type ContextInventoryItem } from "./contextInventory";
import {
  createApplyUndoEntry,
  isUndoEntryValid,
  planUndoActions,
  type ApplyUndoEntry,
} from "./applyUndo";
import { attachmentVaultPaths, rewriteImageEmbeds } from "./imageEmbedRewrite";
import { normalizeUiTheme, type UiTheme } from "./uiTheme";

const TEXT_CONTEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "jsonc", "yaml", "yml", "toml", "csv", "tsv",
  "js", "jsx", "ts", "tsx", "css", "scss", "html", "xml", "py", "java",
  "c", "h", "cpp", "hpp", "cs", "go", "rs", "sh", "ps1", "sql", "canvas",
]);

interface StoredPluginData extends Partial<PluginSettings> {
  chatState?: PersistedChatState;
}

function isDesktop(): boolean {
  return Platform.isDesktopApp;
}

export default class AiChatPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private runner = new ApiRunner();
  private chatStore!: ChatStore;
  private pendingAttachments: ChatAttachment[] = [];
  /** Conversation + message currently receiving a streamed reply. */
  private streaming: { conversationId: string; messageId: string } | null = null;
  /** Prevent a second Enter/click from racing while context is being prepared. */
  private sendInFlight = false;
  private saveTimer: number | null = null;
  private lastApplyUndo: ApplyUndoEntry | null = null;
  /** Last focused Markdown file path — used when the chat panel has focus. */
  private lastMarkdownPath: string | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(AI_CHAT_VIEW_TYPE, (leaf) => {
      const view = new ChatPanelView(leaf);
      this.bindView(view);
      return view;
    });

    this.addRibbonIcon("messages-square", "打开 AI 对话", () => {
      void this.activateChatView();
    });

    this.addCommand({
      id: "open-ai-chat",
      name: "打开 AI 对话",
      callback: () => void this.activateChatView().then(() => this.getChatView()?.focusComposer()),
    });
    this.addCommand({
      id: "ai-chat-new-conversation",
      name: "开始新对话",
      callback: () => this.startNewChat(),
    });
    this.addCommand({
      id: "ai-chat-cancel",
      name: "停止正在生成的回复",
      callback: () => this.cancelRun(),
    });
    this.addCommand({
      id: "ai-chat-cleanup-screenshots",
      name: "清理孤立截图",
      callback: () =>
        void this.cleanupOrphanScreenshots().then((count) => {
          new Notice(count > 0 ? `已清理 ${count} 个孤立截图` : "没有可清理的孤立截图");
        }),
    });
    this.addCommand({
      id: "ai-chat-send-editor-selection",
      name: "发送编辑器选区",
      editorCallback: (editor, view) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("请先在编辑器中选择文本");
          return;
        }
        this.captureMarkdownFocus(view.file?.path);
        void this.activateChatView().then(() => {
          this.getChatView()?.setComposerText(selection);
        });
      },
    });
    this.addSettingTab(new AiChatSettingTab(this.app, this));

    this.captureMarkdownFocus(this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (md?.file) this.captureMarkdownFocus(md.file.path);
        this.refreshContextUi();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.captureMarkdownFocus(file.path);
          this.refreshContextUi();
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view) => {
        const selection = editor.getSelection().trim();
        if (!selection) return;
        menu.addItem((item) =>
          item
            .setTitle("发送选区到 AI 对话")
            .setIcon("messages-square")
            .onClick(() => {
              this.captureMarkdownFocus(view.file?.path);
              void this.activateChatView().then(() => {
                this.getChatView()?.setComposerText(selection);
              });
            }),
        );
      }),
    );

    if (!isDesktop()) new Notice("AI 对话插件仅支持桌面端 Obsidian");
  }

  onunload(): void {
    this.runner.cancel();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    void this.persistData();
  }

  // ── settings / persistence ────────────────────────────────────────────

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as StoredPluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});

    if (!Array.isArray(this.settings.profiles)) this.settings.profiles = [];
    this.settings.profiles = this.settings.profiles
      .filter((profile) => profile && typeof profile === "object")
      .map((profile) => this.sanitizeProfile(profile));
    if (typeof this.settings.activeProfileId !== "string") this.settings.activeProfileId = "";
    if (typeof this.settings.systemPrompt !== "string") this.settings.systemPrompt = "";
    if (typeof this.settings.extraInstructions !== "string") this.settings.extraInstructions = "";
    this.settings.uiTheme = normalizeUiTheme(this.settings.uiTheme);
    if (!Array.isArray(this.settings.customPrompts)) {
      this.settings.customPrompts = DEFAULT_SETTINGS.customPrompts;
    }
    if (typeof this.settings.deleteAttachmentsOnCleanup !== "boolean") {
      this.settings.deleteAttachmentsOnCleanup = DEFAULT_SETTINGS.deleteAttachmentsOnCleanup;
    }
    if (!Number.isFinite(this.settings.timeoutMs) || this.settings.timeoutMs < 10_000) {
      this.settings.timeoutMs = DEFAULT_SETTINGS.timeoutMs;
    }
    if (!Number.isFinite(this.settings.idleTimeoutMs) || this.settings.idleTimeoutMs < 5_000) {
      this.settings.idleTimeoutMs = DEFAULT_SETTINGS.idleTimeoutMs;
    }
    if (!Number.isFinite(this.settings.maxHistoryChars) || this.settings.maxHistoryChars < 10_000) {
      this.settings.maxHistoryChars = DEFAULT_SETTINGS.maxHistoryChars;
    }
    if (!Number.isFinite(this.settings.historyLimit) || this.settings.historyLimit < 1) {
      this.settings.historyLimit = DEFAULT_SETTINGS.historyLimit;
    }
    this.settings.contextLimits = mergeContextLimits(this.settings.contextLimits);

    this.chatStore = new ChatStore(
      stored?.chatState,
      this.settings.historyLimit,
      this.settings.includeActiveNoteByDefault,
    );
  }

  private sanitizeProfile(raw: Partial<ProviderProfile>): ProviderProfile {
    const kind =
      raw.kind === "openai-responses" || raw.kind === "anthropic" ? raw.kind : "openai-chat";
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : createId("profile"),
      name: typeof raw.name === "string" ? raw.name : "",
      kind,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      rememberSensitiveFields: raw.rememberSensitiveFields === true,
      model: typeof raw.model === "string" ? raw.model : "",
      reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort),
      thinkingBudgetTokens:
        typeof raw.thinkingBudgetTokens === "number" && raw.thinkingBudgetTokens >= 1024
          ? Math.floor(raw.thinkingBudgetTokens)
          : undefined,
      reasoningSummary:
        raw.reasoningSummary === "auto" || raw.reasoningSummary === "detailed"
          ? raw.reasoningSummary
          : "",
      verbosity:
        raw.verbosity === "low" || raw.verbosity === "medium" || raw.verbosity === "high"
          ? raw.verbosity
          : "",
      maxOutputTokens:
        typeof raw.maxOutputTokens === "number" && raw.maxOutputTokens > 0
          ? Math.floor(raw.maxOutputTokens)
          : undefined,
      temperature:
        typeof raw.temperature === "number" && raw.temperature >= 0 && raw.temperature <= 2
          ? raw.temperature
          : undefined,
      extraHeaders: typeof raw.extraHeaders === "string" ? raw.extraHeaders : "",
    };
  }

  async saveSettings(): Promise<void> {
    await this.persistData();
    this.pushSettingsToView();
  }

  /** In-memory mutation is immediate; disk write is debounced (heavy chat-state serialize). */
  saveSettingsDebounced(): void {
    this.schedulePersist();
    this.pushSettingsToView();
  }

  private pushSettingsToView(): void {
    const view = this.getChatView();
    if (view) {
      view.setCustomPrompts(this.settings.customPrompts);
      this.pushModelState(view);
    }
  }

  applyHistoryLimit(limit: number): void {
    this.chatStore.setHistoryLimit(limit);
    const current = this.chatStore.current;
    this.getChatView()?.setConversation(current.messages, current.includeActiveNote);
    this.schedulePersist();
  }

  /** Remove every locally persisted setting, model profile, and conversation. */
  async resetLocalData(): Promise<void> {
    this.runner.cancel();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingAttachments = [];
    this.streaming = null;
    this.lastApplyUndo = null;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.chatStore = new ChatStore(
      undefined,
      this.settings.historyLimit,
      this.settings.includeActiveNoteByDefault,
    );
    await this.persistData();
    const current = this.chatStore.current;
    this.getChatView()?.setConversation(current.messages, current.includeActiveNote);
    this.pushSettingsToView();
  }

  private async persistData(): Promise<void> {
    const profiles = this.settings.profiles.map(profileForPersistence);
    await this.saveData({ ...this.settings, profiles, chatState: this.chatStore.serialize() });
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persistData();
    }, 350);
  }

  // ── profile / view state ──────────────────────────────────────────────

  private get activeProfile(): ProviderProfile | null {
    return activeProfile(this.settings);
  }

  private get contextLimits(): typeof DEFAULT_CONTEXT_LIMITS {
    return mergeContextLimits(this.settings.contextLimits);
  }

  private get runningConversationId(): string | null {
    return this.runner.isRunning ? (this.streaming?.conversationId ?? null) : null;
  }

  openPluginSettings(): void {
    // Obsidian exposes the settings modal on app.setting at runtime, but it is not in public typings.
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (setting?.open) {
      setting.open();
      setting.openTabById?.(this.manifest.id);
      return;
    }
    new Notice("请打开 Obsidian 设置 → 社区插件 → AI 对话");
  }

  private pushModelState(view: ChatPanelView): void {
    const active = this.activeProfile;
    const models: ModelChoice[] = this.settings.profiles.map((profile) => ({
      id: profile.id,
      label: profileDisplayName(profile),
      detail: `${PROVIDER_KIND_LABELS[profile.kind]} · ${profile.model || "未填模型"}`,
      active: profile.id === active?.id,
    }));
    view.setModels(models);
    const missing: string[] = [];
    if (!active) missing.push("还没有模型配置");
    else {
      // API Key 允许留空（本地端点如 Ollama 不需要）。
      if (!active.baseUrl.trim()) missing.push("Base URL 未填写");
      if (!active.model.trim()) missing.push("模型 ID 未填写");
    }
    view.setConfigStatus(
      missing.length === 0,
      missing.length ? `${missing.join("、")}。请在设置中完成模型配置。` : null,
    );
    view.setProfileReasoningEffort(active?.reasoningEffort ?? "default");
    view.setReasoningOverride(this.chatStore.current.reasoningOverride ?? "default");
  }

  private captureMarkdownFocus(path: string | null | undefined): void {
    if (path && path.endsWith(".md")) this.lastMarkdownPath = path;
  }

  private resolvedActiveNotePath(): string | null {
    const currentMarkdownPath =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
    return resolveActiveNotePath({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      currentMarkdownPath,
      lastMarkdownPath: this.lastMarkdownPath,
    });
  }

  private refreshContextUi(): void {
    const view = this.getChatView();
    if (!view) return;
    const activePath = this.resolvedActiveNotePath();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activePath
        ? activeView.editor.getSelection().trim()
        : "";
    view.setActiveNotePath(activePath);
    view.setActiveNoteChipLabel(
      this.chatStore.current.includeActiveNote ? activeNoteChipLabel(activePath) : "当前笔记",
    );
    view.setSelectionChars(selectionText.length || null);
    const openPaths = this.getOpenMarkdownPaths();
    const selected = this.chatStore.current.openTabPaths ?? [];
    const stillOpen = selected.filter((path) => openPaths.includes(path));
    if (stillOpen.length !== selected.length) {
      this.chatStore.setOpenTabPaths(stillOpen);
    }
    view.setOpenTabs(
      openPaths.map((path) => ({
        path,
        label: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
        selected: stillOpen.includes(path),
      })),
    );
    const draft = view.getComposerText();
    const summary = this.estimateDraftContext(draft, this.pendingAttachments.length, selectionText.length);
    view.setTurnContextSummary(summary.line, summary.truncated);
    view.setContextInventory(this.computeContextInventory());
  }

  private computeContextInventory(): ReturnType<typeof buildContextInventory> {
    const activePath = this.resolvedActiveNotePath();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activePath
        ? activeView.editor.getSelection().trim()
        : "";
    const draft = this.getChatView()?.getComposerText() ?? "";
    const selection = parseContextSelection(draft, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    return buildContextInventory({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      activeNotePath: activePath,
      openTabPaths: this.chatStore.current.openTabPaths ?? [],
      draftMessage: draft,
      attachmentCount: this.pendingAttachments.length,
      expandedPaths: expanded.paths,
      expansionCapped: expanded.expansionCapped,
      selectionChars: selectionText.length,
      limits: this.contextLimits,
    });
  }

  private toggleOpenTab(path: string, selected: boolean): void {
    const current = new Set(this.chatStore.current.openTabPaths ?? []);
    if (selected) {
      if (current.size >= 3 && !current.has(path)) {
        new Notice("最多选择 3 个打开中的标签作为上下文");
        this.refreshContextUi();
        return;
      }
      current.add(path);
    } else {
      current.delete(path);
    }
    this.chatStore.setOpenTabPaths(Array.from(current));
    this.refreshContextUi();
    this.schedulePersist();
  }

  private bindView(view: ChatPanelView): void {
    view.setCustomPrompts(this.settings.customPrompts);
    view.setHandlers({
      onCancel: () => this.cancelRun(),
      onSendMessage: (message, attachments) => void this.sendChatMessage(message, attachments),
      onNewChat: () => this.startNewChat(),
      onOpenHistory: () => this.openHistory(),
      onPasteImages: (files) => void this.addImages(files),
      onRemoveAttachment: (id) => void this.removePendingAttachment(id),
      onToggleActiveNote: (value) => this.setIncludeActiveNote(value),
      onOpenContextInventory: () => this.openContextInventory(),
      onOpenSettings: () => this.openPluginSettings(),
      onUndoLastApply: () => this.undoLastApply(),
      onCopyMessage: (message) => void this.copyMessage(message),
      onEditMessage: (message) => this.editMessage(message),
      onRegenerateMessage: (message) => void this.regenerateMessage(message),
      onRetryMessage: (message) => void this.retryMessage(message),
      onApplyMessage: (message) => this.previewApply(message),
      onWriteBackMessage: (action, text) => void this.writeBackResponse(action, text),
      onOpenSource: (path) => void this.openSource(path),
      onDraftContextChange: () => this.refreshContextUi(),
      onToggleOpenTab: (path, selected) => this.toggleOpenTab(path, selected),
      onSelectModel: (id) => void this.selectProfile(id),
      onSelectReasoning: (effort) => this.selectReasoning(effort),
      onSelectTheme: (theme) => this.selectTheme(theme),
      onCollapsePanel: () => this.collapseChatPanel(),
    });
    view.setConversation(this.chatStore.current.messages, this.chatStore.current.includeActiveNote);
    view.setPendingAttachments(this.pendingAttachments);
    view.setPendingUndoAvailable(isUndoEntryValid(this.lastApplyUndo));
    view.setTheme(this.settings.uiTheme);
    this.pushModelState(view);
    this.refreshContextUi();
  }

  private async selectProfile(id: string): Promise<void> {
    if (this.settings.activeProfileId === id) return;
    this.settings.activeProfileId = id;
    await this.saveSettings();
    const profile = this.activeProfile;
    if (profile) new Notice(`已切换到 ${profileDisplayName(profile)}`);
  }

  private selectReasoning(effort: ReasoningEffort): void {
    this.chatStore.setReasoningOverride(effort);
    this.getChatView()?.setReasoningOverride(effort);
    this.schedulePersist();
  }

  private selectTheme(theme: UiTheme): void {
    this.settings.uiTheme = normalizeUiTheme(theme);
    this.getChatView()?.setTheme(this.settings.uiTheme);
    this.schedulePersist();
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: AI_CHAT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof ChatPanelView) this.bindView(leaf.view);
  }

  private collapseChatPanel(): void {
    const leaves = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    for (const leaf of leaves) leaf.detach();
  }

  private getChatView(): ChatPanelView | null {
    const view = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)[0]?.view;
    return view instanceof ChatPanelView ? view : null;
  }

  // ── run lifecycle ─────────────────────────────────────────────────────

  private get isRunning(): boolean {
    return this.runner.isRunning;
  }

  cancelRun(): void {
    if (!this.isRunning) {
      new Notice("没有正在生成的回复");
      return;
    }
    this.runner.cancel();
    new Notice("正在停止…已生成内容将保留");
  }

  private applyProgress(conversationId: string, messageId: string, event: RunProgressEvent): void {
    const view = this.getChatView();
    view?.update({
      stage: event.stage,
      message: event.message,
      running: !["done", "error", "cancelled", "idle"].includes(event.stage),
    });
    if (event.partialText === undefined && event.partialThought === undefined) return;
    const patch: Partial<ChatMessage> = { status: "streaming" };
    if (event.partialText !== undefined) patch.text = event.partialText;
    if (event.partialThought !== undefined) patch.thoughtText = event.partialThought;
    this.chatStore.updateMessageIn(conversationId, messageId, patch);
    if (this.chatStore.current.id === conversationId) {
      view?.updateChatMessage(messageId, patch);
    }
  }

  /** Markdown files currently open in workspace leaves (deduped). */
  private getOpenMarkdownPaths(): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        const path = view.file.path;
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    });
    return paths;
  }

  private findMarkdownView(path: string | null | undefined): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file && (!path || activeView.file.path === path)) return activeView;

    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && (!path || view.file.path === path)) {
        found = view;
      }
    });
    return found;
  }

  private getWriteBackTarget(): { view: MarkdownView | null; file: TFile | null } {
    const targetPath = this.resolvedActiveNotePath() ?? this.lastMarkdownPath;
    const view = this.findMarkdownView(targetPath) ?? this.findMarkdownView(null);
    if (view?.file) return { view, file: view.file };

    const fallbackPath = targetPath ?? this.app.workspace.getActiveFile()?.path ?? null;
    const abstract = fallbackPath ? this.app.vault.getAbstractFileByPath(fallbackPath) : null;
    return {
      view: null,
      file: abstract instanceof TFile && abstract.extension === "md" ? abstract : null,
    };
  }

  private getFilesForTag(tag: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      const inline = (cache?.tags ?? []).some((item) =>
        tagMatches(item.tag.replace(/^#/, ""), tag),
      );
      const frontmatterData: unknown = cache?.frontmatter;
      const frontmatter =
        frontmatterData && typeof frontmatterData === "object"
          ? (frontmatterData as Record<string, unknown>).tags
          : undefined;
      const values: unknown[] = Array.isArray(frontmatter)
        ? frontmatter
        : frontmatter
          ? [frontmatter]
          : [];
      return (
        inline || values.some((value) => tagMatches(String(value).replace(/^#/, ""), tag))
      );
    });
  }

  private expandContextFiles(selection: ContextSelection): {
    paths: string[];
    sources: ChatSource[];
    expansionCapped: boolean;
  } {
    const paths = new Set(selection.filePaths);
    const sources: ChatSource[] = selection.filePaths.map((path) => ({
      path,
      label: path.split("/").pop() ?? path,
      kind: "file",
    }));
    let expansionCapped = false;
    const folderHits: number[] = [];
    const tagHits: number[] = [];

    for (const folder of selection.folderPaths) {
      sources.push({ path: folder, label: folder.split("/").pop() ?? folder, kind: "folder" });
      const matches = this.app.vault
        .getFiles()
        .filter(
          (file) =>
            file.path.startsWith(`${folder}/`) &&
            TEXT_CONTEXT_EXTENSIONS.has(file.extension.toLowerCase()),
        );
      folderHits.push(matches.length);
      if (matches.length > this.contextLimits.maxFilesPerFolder) expansionCapped = true;
      matches.slice(0, this.contextLimits.maxFilesPerFolder).forEach((file) => paths.add(file.path));
    }
    for (const tag of selection.tags) {
      sources.push({ path: `#${tag}`, label: `#${tag}`, kind: "tag" });
      const matches = this.getFilesForTag(tag);
      tagHits.push(matches.length);
      if (matches.length > this.contextLimits.maxFilesPerTag) expansionCapped = true;
      matches.slice(0, this.contextLimits.maxFilesPerTag).forEach((file) => paths.add(file.path));
    }

    const all = Array.from(paths);
    if (all.length > this.contextLimits.maxExpandedPaths) expansionCapped = true;
    const estimate = estimateExpansionCap(selection, folderHits, tagHits, this.contextLimits);
    expansionCapped = expansionCapped || estimate.expansionCapped;

    return {
      paths: all.slice(0, this.contextLimits.maxExpandedPaths),
      sources,
      expansionCapped,
    };
  }

  private async readContextFiles(paths: string[]): Promise<ContextFileInput[]> {
    const files: ContextFileInput[] = [];
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        files.push({ path, title: path, content: "", error: "File not found" });
        continue;
      }
      if (!TEXT_CONTEXT_EXTENSIONS.has(file.extension.toLowerCase())) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const capped = content.slice(0, this.contextLimits.maxCharsPerFile);
        files.push({
          path: file.path,
          title: file.basename,
          content: capped,
          truncated: capped.length < content.length,
        });
      } catch (error) {
        files.push({
          path,
          title: path,
          content: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return files;
  }

  /** Gather context, plan the cache-friendly window, and assemble API messages. */
  private async buildTurn(
    message: string,
    attachments: ChatAttachment[],
    historyMessages: ChatMessage[],
    previousStartId: string | undefined,
  ): Promise<{
    output: ReturnType<typeof buildTurnMessages>;
    sources: ChatSource[];
    startMessageId?: string;
  }> {
    const selection = parseContextSelection(message, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeNotePath = resolveActiveNotePath({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      currentMarkdownPath: activeView?.file?.path ?? null,
      lastMarkdownPath: this.lastMarkdownPath,
    });
    if (activeNotePath) {
      expanded.paths.unshift(activeNotePath);
      const label = activeNotePath.split("/").pop()?.replace(/\.md$/i, "") ?? activeNotePath;
      expanded.sources.unshift({ path: activeNotePath, label, kind: "active-note" });
    }
    for (const tabPath of this.chatStore.current.openTabPaths ?? []) {
      if (!tabPath || tabPath === activeNotePath) continue;
      expanded.paths.unshift(tabPath);
      expanded.sources.unshift({
        path: tabPath,
        label: tabPath.split("/").pop()?.replace(/\.md$/i, "") ?? tabPath,
        kind: "open-tab",
      });
    }
    const uniquePaths = Array.from(new Set(expanded.paths));
    const contextFiles = await this.readContextFiles(uniquePaths);
    const selectionText =
      this.chatStore.current.includeActiveNote && activeView?.file?.path === activeNotePath
        ? activeView.editor.getSelection().trim()
        : "";

    const plan = planHistoryWindow(historyMessages, previousStartId, this.settings.maxHistoryChars);

    // Encode images for the current turn and every window message that has them.
    const imageParts = new Map<string, NeutralContentImage>();
    const encode = async (path: string, mimeType: string) => {
      if (imageParts.has(path)) return;
      const part = await encodeVaultImage(this.app, path, mimeType);
      if (part) imageParts.set(path, part);
    };
    for (const attachment of attachments) await encode(attachment.path, attachment.mimeType);
    for (const item of plan.window) {
      for (const attachment of item.attachments ?? []) {
        await encode(attachment.path, attachment.mimeType);
      }
    }

    const output = buildTurnMessages({
      systemPrompt: this.settings.systemPrompt,
      extraInstructions: this.settings.extraInstructions,
      windowMessages: plan.window,
      userText: message,
      contextFiles,
      selectionText,
      imagePaths: attachmentVaultPaths(attachments).filter((path) => imageParts.has(path)),
      imageParts,
      maxCharsTotal: this.contextLimits.maxCharsTotal,
    });

    const dedupedSources = expanded.sources.filter(
      (source, index, array) => array.findIndex((item) => item.path === source.path) === index,
    );
    return { output, sources: dedupedSources, startMessageId: plan.startMessageId };
  }

  private async sendChatMessage(
    message: string,
    attachments: ChatAttachment[],
    reuseLastUser = false,
  ): Promise<void> {
    if (this.isRunning || this.sendInFlight) {
      new Notice("已有回复正在生成，请先停止或等待完成");
      return;
    }
    const profile = this.activeProfile;
    const view = this.getChatView();
    if (!profile || !profile.model.trim() || !profile.baseUrl.trim()) {
      if (view) this.pushModelState(view);
      new Notice("请先在设置中完成模型配置（Base URL / 模型 ID）");
      return;
    }
    if (!isDesktop()) return;

    this.sendInFlight = true;
    const conversation = this.chatStore.current;
    const conversationId = conversation.id;
    let assistantId: string | null = null;
    try {
      let userMessage: ChatMessage;
      if (reuseLastUser) {
        const last = conversation.messages[conversation.messages.length - 1];
        if (last && last.role === "user") {
          userMessage = last;
          message = message || last.text;
          attachments = attachments.length ? attachments : (last.attachments ?? []);
        } else {
          reuseLastUser = false;
          userMessage = this.appendUserMessage(conversationId, message, attachments);
        }
      } else {
        this.pendingAttachments = [];
        view?.setPendingAttachments([]);
        userMessage = this.appendUserMessage(conversationId, message, attachments);
      }

      const historyMessages = conversation.messages.filter((item) => item.id !== userMessage.id);
      const built = await this.buildTurn(
        message,
        attachments,
        historyMessages,
        conversation.historyStartMessageId,
      );

      // Persist the exact sent content so future turns replay it verbatim (cache hits).
      this.chatStore.updateMessageIn(conversationId, userMessage.id, {
        apiText: built.output.apiText,
        contextAttachments: built.output.contextAttachments,
      });
      this.chatStore.setHistoryStart(conversationId, built.startMessageId);

      const assistant: ChatMessage = {
        id: createId("message"),
        role: "assistant",
        text: "",
        createdAt: Date.now(),
        status: "streaming",
        model: profile.model || profileDisplayName(profile),
        sources: built.sources,
        retryUserText: message,
        retryAttachments: attachments,
      };
      this.chatStore.addMessageTo(conversationId, assistant);
      assistantId = assistant.id;
      this.streaming = { conversationId, messageId: assistant.id };
      if (this.chatStore.current.id === conversationId) view?.addChatMessage(assistant);
      this.schedulePersist();

      const effort = resolveEffectiveEffort(conversation.reasoningOverride, profile.reasoningEffort);
      view?.update({ running: true, stage: "starting" });
      const result = await this.runner.run({
        profile,
        request: {
          messages: built.output.messages,
          effort,
          cacheKey: conversationId,
        },
        timeoutMs: this.settings.timeoutMs,
        idleTimeoutMs: this.settings.idleTimeoutMs,
        onProgress: (event) => this.applyProgress(conversationId, assistant.id, event),
      });

      // If the request never reached the model, forget dedupe records so the
      // context files are attached again on the next attempt.
      if (!result.ok && !result.gotFirstByte) {
        this.chatStore.updateMessageIn(conversationId, userMessage.id, {
          contextAttachments: [],
        });
      }

      const usage = result.usage
        ? { ...result.usage, durationMs: result.durationMs }
        : { durationMs: result.durationMs };
      const patch: Partial<ChatMessage> = { usage };
      if (result.ok) {
        patch.status = "complete";
        patch.text = this.rewriteAssistantImageEmbeds(result.text, attachments);
        patch.thoughtText = result.thought;
        patch.errorDetails = undefined;
      } else if (result.error === "cancelled") {
        patch.status = "cancelled";
        patch.text = result.text.trim() ? result.text : "";
        patch.thoughtText = result.thought;
        patch.errorDetails = undefined;
      } else {
        patch.status = "error";
        patch.text = result.text.trim() ? result.text : "";
        patch.thoughtText = result.thought;
        patch.errorDetails = [result.error, result.errorDetails]
          .filter(Boolean)
          .join("\n\n");
      }
      this.chatStore.updateMessageIn(conversationId, assistant.id, patch);
      this.getChatView()?.update({
        running: false,
        stage: result.ok ? "done" : result.error === "cancelled" ? "cancelled" : "error",
      });
      if (this.chatStore.current.id === conversationId) {
        this.getChatView()?.updateChatMessage(assistant.id, patch);
      }
      this.streaming = null;
      await this.persistData();
    } catch (error) {
      const details = error instanceof Error ? error.stack || error.message : String(error);
      if (assistantId) {
        const patch: Partial<ChatMessage> = {
          status: "error",
          errorDetails: details,
        };
        this.chatStore.updateMessageIn(conversationId, assistantId, patch);
        if (this.chatStore.current.id === conversationId) {
          this.getChatView()?.updateChatMessage(assistantId, patch);
        }
      }
      this.streaming = null;
      this.getChatView()?.update({ running: false, stage: "error", message: details });
      await this.persistData();
    } finally {
      this.sendInFlight = false;
    }
  }

  private appendUserMessage(
    conversationId: string,
    message: string,
    attachments: ChatAttachment[],
  ): ChatMessage {
    const userMessage: ChatMessage = {
      id: createId("message"),
      role: "user",
      text: message,
      createdAt: Date.now(),
      status: "complete",
      attachments,
    };
    this.chatStore.addMessageTo(conversationId, userMessage);
    if (this.chatStore.current.id === conversationId) {
      this.getChatView()?.addChatMessage(userMessage);
    }
    return userMessage;
  }

  // ── attachments ───────────────────────────────────────────────────────

  private async addImages(files: File[]): Promise<void> {
    try {
      const activePath = this.app.workspace.getActiveFile()?.path;
      const saved = await saveImageFiles(this.app, files, activePath);
      this.pendingAttachments = [...this.pendingAttachments, ...saved].slice(0, 4);
      this.getChatView()?.setPendingAttachments(this.pendingAttachments);
      if (saved.length === 0) new Notice("没有找到可用图片");
    } catch (error) {
      new Notice(`图片处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async removePendingAttachment(id: string): Promise<void> {
    const removed = this.pendingAttachments.find((item) => item.id === id);
    this.pendingAttachments = this.pendingAttachments.filter((item) => item.id !== id);
    this.getChatView()?.setPendingAttachments(this.pendingAttachments);
    if (removed && this.settings.deleteAttachmentsOnCleanup && isPluginManagedScreenshot(removed.path)) {
      await deleteVaultFiles(this.app, [removed.path]);
    }
  }

  private setIncludeActiveNote(value: boolean): void {
    this.chatStore.setIncludeActiveNote(value);
    this.getChatView()?.setConversation(this.chatStore.current.messages, value);
    this.refreshContextUi();
    this.schedulePersist();
  }

  /** Used by the chat view to estimate turn context without re-reading file bodies. */
  estimateDraftContext(
    draftMessage: string,
    attachmentCount: number,
    selectionChars = 0,
  ): ReturnType<typeof summarizeTurnContext> {
    const selection = parseContextSelection(draftMessage, {
      files: this.contextLimits.maxFilesInMessage,
      folders: this.contextLimits.maxFoldersInMessage,
      tags: this.contextLimits.maxTagsInMessage,
    });
    const expanded = this.expandContextFiles(selection);
    const activeNotePath = this.resolvedActiveNotePath();
    let expandedPathCount = expanded.paths.length;
    if (activeNotePath && !expanded.paths.includes(activeNotePath)) {
      expandedPathCount += 1;
    }
    for (const tab of this.chatStore.current.openTabPaths ?? []) {
      if (tab !== activeNotePath && !expanded.paths.includes(tab)) expandedPathCount += 1;
    }
    const summary = summarizeTurnContext({
      includeActiveNote: this.chatStore.current.includeActiveNote,
      activeNotePath,
      draftMessage,
      attachmentCount,
      expandedPathCount,
      expansionCapped: expanded.expansionCapped,
      selectionChars,
      limits: this.contextLimits,
    });
    const tabCount = (this.chatStore.current.openTabPaths ?? []).length;
    if (tabCount > 0) {
      summary.line =
        summary.line === "本轮无额外上下文"
          ? `打开标签 ${tabCount}`
          : `${summary.line} · 标签 ${tabCount}`;
    }
    return summary;
  }

  // ── history ───────────────────────────────────────────────────────────

  private openHistory(): void {
    new ChatHistoryModal(
      this.app,
      this.chatStore.list(),
      (conversation) => {
        this.chatStore.select(conversation.id);
        this.pendingAttachments = [];
        const view = this.getChatView();
        view?.setConversation(conversation.messages, conversation.includeActiveNote);
        view?.setPendingAttachments([]);
        view?.setReasoningOverride(conversation.reasoningOverride ?? "default");
        this.refreshContextUi();
        this.schedulePersist();
      },
      async (conversation) => {
        if (conversation.id === this.runningConversationId) {
          new Notice("该对话正在生成回复，请先停止再删除");
          return;
        }
        const removed = this.chatStore.takeDeleted(
          conversation.id,
          this.settings.includeActiveNoteByDefault,
        );
        if (!removed) return;
        if (this.settings.deleteAttachmentsOnCleanup) {
          const paths = this.chatStore
            .collectAttachmentPaths(removed)
            .filter((path) => isPluginManagedScreenshot(path));
          const stillUsed = this.chatStore.allReferencedAttachmentPaths();
          const orphans = paths.filter((path) => !stillUsed.has(path));
          if (orphans.length) await deleteVaultFiles(this.app, orphans);
        }
        const current = this.chatStore.current;
        this.pendingAttachments = [];
        const view = this.getChatView();
        view?.setConversation(current.messages, current.includeActiveNote);
        view?.setPendingAttachments([]);
        view?.setReasoningOverride(current.reasoningOverride ?? "default");
        this.refreshContextUi();
        await this.persistData();
        new Notice("对话已删除");
      },
      (conversation, title) => {
        const ok = this.chatStore.rename(conversation.id, title);
        if (ok) this.schedulePersist();
        return ok;
      },
      async (conversation) => {
        const md = this.chatStore.exportMarkdown(conversation.id);
        if (!md) {
          new Notice("导出失败");
          return;
        }
        const safeTitle = (conversation.title || "对话")
          .replace(/[\\/:*?"<>|]/g, "-")
          .slice(0, 40);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const path = await this.app.fileManager.getAvailablePathForAttachment(
          `AI Chat ${safeTitle} ${stamp}.md`,
        );
        await this.app.vault.create(path, md);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
        new Notice(`已导出：${path}`);
      },
      (conversation, pinned) => {
        const ok = this.chatStore.setPinned(conversation.id, pinned);
        if (ok) this.schedulePersist();
        return ok;
      },
      { runningConversationId: this.runningConversationId },
    ).open();
  }

  startNewChat(): void {
    // A background stream keeps writing into its own conversation, so starting
    // a fresh conversation is safe even while one reply is still generating.
    const conversation = this.chatStore.create(this.settings.includeActiveNoteByDefault);
    this.pendingAttachments = [];
    void this.activateChatView().then(() => {
      const view = this.getChatView();
      view?.setConversation(conversation.messages, conversation.includeActiveNote);
      view?.setPendingAttachments([]);
      view?.setReasoningOverride("default");
      view?.focusComposer();
    });
    this.schedulePersist();
  }

  // ── message actions ───────────────────────────────────────────────────

  private async copyMessage(message: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.text);
      new Notice(message.role === "assistant" ? "回答已复制" : "消息已复制");
    } catch (error) {
      new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private editMessage(message: ChatMessage): void {
    if (this.isRunning || this.sendInFlight) {
      new Notice("请先停止或等待当前回复完成");
      return;
    }
    if (message.role !== "user") return;
    this.chatStore.truncateFrom(message.id);
    this.pendingAttachments = [...(message.attachments ?? [])];
    const view = this.getChatView();
    view?.setConversation(this.chatStore.current.messages, this.chatStore.current.includeActiveNote);
    view?.setPendingAttachments(this.pendingAttachments);
    view?.setComposerText(message.text);
    this.schedulePersist();
  }

  /** Regenerate an assistant turn: drop it (and anything after) and resend the same user turn. */
  private async regenerateMessage(message: ChatMessage): Promise<void> {
    if (this.isRunning || this.sendInFlight) {
      new Notice("请先停止或等待当前回复完成");
      return;
    }
    const messages = this.chatStore.current.messages;
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    let userIndex = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor]?.role === "user") {
        userIndex = cursor;
        break;
      }
    }
    if (userIndex < 0) {
      await this.retryWithStoredContext(message);
      return;
    }
    const user = messages[userIndex];
    if (!user) return;
    const firstDropped = messages[userIndex + 1];
    if (firstDropped) this.chatStore.truncateFrom(firstDropped.id);
    this.getChatView()?.setConversation(
      this.chatStore.current.messages,
      this.chatStore.current.includeActiveNote,
    );
    await this.sendChatMessage(user.text, user.attachments ?? [], true);
  }

  /** Retry a failed assistant turn with the same user text/attachments. */
  private async retryMessage(message: ChatMessage): Promise<void> {
    await this.regenerateMessage(message);
  }

  private async retryWithStoredContext(message: ChatMessage): Promise<void> {
    const text = message.retryUserText;
    if (!text && !message.retryAttachments?.length) return;
    this.chatStore.removeMessage(message.id);
    this.getChatView()?.setConversation(
      this.chatStore.current.messages,
      this.chatStore.current.includeActiveNote,
    );
    await this.sendChatMessage(text ?? "", message.retryAttachments ?? []);
  }

  // ── apply / write back ────────────────────────────────────────────────

  private previewApply(message: ChatMessage): void {
    const active = this.app.workspace.getActiveFile();
    const fallbackPath = active && !active.path.includes("..") ? active.path : undefined;
    const responseText = this.rewriteAssistantImageEmbeds(
      message.text,
      message.retryAttachments ?? [],
    );
    new ApplyDiffModal(this.app, responseText, fallbackPath, (summary, undo) => {
      const notice = new Notice(summary, 6000);
      if (undo && isUndoEntryValid(undo)) {
        this.lastApplyUndo = undo;
        this.getChatView()?.setPendingUndoAvailable(true);
        const undoButton = notice.messageEl.createEl("button", {
          cls: "aichat-undo-button",
          text: "撤销",
          attr: { type: "button" },
        });
        undoButton.addEventListener("click", () => void this.undoApply(undo));
      }
    }, (action, text) => this.writeBackResponse(action, text)).open();
  }

  private rewriteAssistantImageEmbeds(text: string, attachments: ChatAttachment[]): string {
    const knownPaths = attachmentVaultPaths(attachments);
    if (!text || knownPaths.length === 0) return text;
    const { text: fixed } = rewriteImageEmbeds(text, knownPaths, {
      pathExists: (vaultRelativePath) => this.vaultPathResolves(vaultRelativePath),
    });
    return fixed;
  }

  private vaultPathResolves(vaultRelativePath: string): boolean {
    const normalized = vaultRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return false;
    if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) return true;
    try {
      const dest = this.app.metadataCache.getFirstLinkpathDest(normalized, "");
      return dest instanceof TFile;
    } catch {
      return false;
    }
  }

  private async undoApply(entry: ApplyUndoEntry): Promise<void> {
    if (!isUndoEntryValid(entry)) {
      this.lastApplyUndo = null;
      this.getChatView()?.setPendingUndoAvailable(false);
      new Notice("撤销已过期");
      return;
    }
    const actions = planUndoActions(entry);
    for (const action of actions) {
      const abstract = this.app.vault.getAbstractFileByPath(action.path);
      if (action.action === "delete") {
        if (abstract instanceof TFile) {
          await this.app.fileManager.trashFile(abstract);
        }
      } else if (abstract instanceof TFile) {
        await this.app.vault.modify(abstract, action.content);
      } else {
        await this.app.vault.create(action.path, action.content);
      }
    }
    if (this.lastApplyUndo?.id === entry.id) {
      this.lastApplyUndo = null;
      this.getChatView()?.setPendingUndoAvailable(false);
    }
    new Notice("已撤销最近一次应用");
  }

  private async undoLastApply(): Promise<void> {
    const entry = this.lastApplyUndo;
    if (!entry || !isUndoEntryValid(entry)) {
      this.lastApplyUndo = null;
      this.getChatView()?.setPendingUndoAvailable(false);
      new Notice("没有可撤销的最近应用");
      return;
    }
    await this.undoApply(entry);
  }

  private openContextInventory(): void {
    new ContextInventoryModal(
      this.app,
      this.computeContextInventory(),
      (path) => this.openSource(path),
      (item) => this.removeContextInventoryItem(item),
      () => this.computeContextInventory(),
    ).open();
  }

  private removeContextInventoryItem(item: ContextInventoryItem): void {
    const view = this.getChatView();
    if (item.kind === "active-note") {
      this.setIncludeActiveNote(false);
      new Notice("已关闭当前笔记上下文");
      return;
    }
    if (item.kind === "open-tab" && item.path) {
      this.toggleOpenTab(item.path, false);
      new Notice("已移除打开标签上下文");
      return;
    }
    if (item.kind === "image") {
      this.pendingAttachments = [];
      view?.setPendingAttachments([]);
      this.refreshContextUi();
      new Notice("已移除待发送图片");
      return;
    }
    if (item.token && view) {
      const draft = view.getComposerText();
      const next = draft
        .replace(item.token, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+\n/g, "\n")
        .trimStart();
      view.setComposerText(next);
      this.refreshContextUi();
      new Notice("已移除此上下文");
    }
  }

  private async writeBackResponse(
    action: "insert" | "append" | "replace" | "create",
    text: string,
  ): Promise<void> {
    const target = this.getWriteBackTarget();
    const activeFile = target.file ?? this.app.workspace.getActiveFile();
    if ((action === "insert" || action === "append" || action === "replace") && activeFile) {
      const titles = {
        insert: "插入到当前笔记",
        append: "追加到当前笔记",
        replace: "覆盖当前笔记",
      } as const;
      const confirms = {
        insert: "确认插入",
        append: "确认追加",
        replace: "确认覆盖",
      } as const;
      const body =
        action === "replace"
          ? `将完整替换：${activeFile.path}\n\n原内容会被整篇覆盖（短时间内可撤销）。请确认。`
          : `将写入：${activeFile.path}\n\n请确认要写入这段回答。`;
      const ok = await new ConfirmModal(
        this.app,
        titles[action],
        body,
        confirms[action],
        "取消",
      ).wait();
      if (!ok) return;
    }
    if (action === "insert") {
      let editor = target.view?.editor ?? null;
      if (!editor && target.file) {
        await this.app.workspace.getLeaf("tab").openFile(target.file);
        editor = this.findMarkdownView(target.file.path)?.editor ?? null;
      }
      if (!editor) {
        new Notice("当前没有可写入的 Markdown 编辑器");
        return;
      }
      editor.replaceSelection(text);
      new Notice("已插入到当前笔记");
      return;
    }
    if (action === "append") {
      const editor = target.view?.editor ?? null;
      if (editor) {
        const prefix = editor.getValue().trimEnd().length > 0 ? "\n\n" : "";
        const lastLine = editor.lastLine();
        const end = { line: lastLine, ch: editor.getLine(lastLine).length };
        editor.replaceRange(`${prefix}${text}`, end);
        new Notice("已追加到当前笔记");
        return;
      }
      if (!activeFile) {
        new Notice("当前没有可写入的 Markdown 文件");
        return;
      }
      const current = await this.app.vault.read(activeFile);
      const prefix = current.trimEnd().length > 0 ? "\n\n" : "";
      await this.app.vault.modify(activeFile, `${current}${prefix}${text}`);
      await this.app.workspace.getLeaf("tab").openFile(activeFile);
      new Notice("已追加到当前笔记");
      return;
    }
    if (action === "replace") {
      if (!activeFile) {
        new Notice("当前没有可覆盖的 Markdown 文件");
        return;
      }
      const editor = target.view?.editor ?? this.findMarkdownView(activeFile.path)?.editor ?? null;
      const before = editor ? editor.getValue() : await this.app.vault.read(activeFile);
      if (editor) {
        editor.setValue(text);
      } else {
        await this.app.vault.modify(activeFile, text);
        await this.app.workspace.getLeaf("tab").openFile(activeFile);
      }
      const undo = createApplyUndoEntry([{ path: activeFile.path, before }]);
      this.lastApplyUndo = undo;
      this.getChatView()?.setPendingUndoAvailable(true);
      const notice = new Notice("已覆盖当前笔记", 6000);
      const undoButton = notice.messageEl.createEl("button", {
        cls: "aichat-undo-button",
        text: "撤销",
        attr: { type: "button" },
      });
      undoButton.addEventListener("click", () => void this.undoApply(undo));
      return;
    }
    const parent = activeFile?.parent?.path ?? target.view?.file?.parent?.path ?? "";
    const stem = activeFile?.basename ? `${activeFile.basename} - AI` : "AI note";
    const path = await this.app.fileManager.getAvailablePathForAttachment(
      parent ? `${parent}/${stem}.md` : `${stem}.md`,
    );
    await this.app.vault.create(path, text);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
    new Notice("已新建笔记");
  }

  private async openSource(path: string): Promise<void> {
    if (path.startsWith("#")) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: "search",
        active: true,
        state: { query: `tag:${path.slice(1)}` },
      });
      return;
    }
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(abstract);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: "search",
      active: true,
      state: { query: `path:"${path}"` },
    });
  }

  /** Delete plugin-managed screenshot files not referenced by any conversation. */
  async cleanupOrphanScreenshots(): Promise<number> {
    if (!this.settings.deleteAttachmentsOnCleanup) {
      new Notice("已关闭「清理时删除截图附件」");
      return 0;
    }
    const referenced = this.chatStore.allReferencedAttachmentPaths();
    for (const pending of this.pendingAttachments) referenced.add(pending.path);

    const candidates = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          isPluginManagedScreenshot(file.name) &&
          ["png", "jpg", "jpeg", "webp", "gif"].includes(file.extension.toLowerCase()) &&
          !referenced.has(file.path),
      )
      .map((file) => file.path);

    return deleteVaultFiles(this.app, candidates);
  }
}
