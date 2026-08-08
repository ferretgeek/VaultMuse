import {
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  setIcon,
} from "obsidian";
import type { ChatStage } from "./apiRunner";
import type { ChatAttachment, ChatMessage, CustomPrompt, MessageUsage } from "./chatTypes";
import type { ContextInventory } from "./contextInventory";
import { EFFORT_LABELS, EFFORT_ORDER, type ReasoningEffort } from "./providers/types";
import { rankAtSuggestions, rankTagSuggestions } from "./suggestionRank";
import { formatStreamingMarkdownPreview } from "./streamingMarkdown";
import { UI_THEME_OPTIONS, type UiTheme } from "./uiTheme";
import {
  shouldAutoScrollOnUpdate,
  shouldShowJumpToLatest,
} from "./scrollPolicy";

export const AI_CHAT_VIEW_TYPE = "ai-chat-panel";

type SuggestionKind = "tag" | "prompt";
interface ContextSuggestion {
  kind: SuggestionKind;
  key: string;
  title: string;
  subtitle: string;
  prompt?: string;
}

export interface ModelChoice {
  id: string;
  label: string;
  detail: string;
  active: boolean;
}

export interface ChatViewState {
  stage: ChatStage;
  message: string;
  messages: ChatMessage[];
  attachments: ChatAttachment[];
  includeActiveNote: boolean;
  running: boolean;
}

const STAGE_LABEL: Record<ChatStage, string> = {
  idle: "就绪",
  starting: "连接中",
  thinking: "思考中",
  writing: "回复中",
  done: "就绪",
  error: "出错",
  cancelled: "已停止",
};

export interface OpenTabChip {
  path: string;
  label: string;
  selected: boolean;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatUsageLine(usage: MessageUsage | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    let input = `↑${formatTokens(usage.inputTokens)}`;
    if (usage.cachedInputTokens && usage.inputTokens > 0) {
      const pct = Math.round((usage.cachedInputTokens / usage.inputTokens) * 100);
      input += ` 缓存${pct}%`;
    }
    parts.push(input);
  }
  if (usage.outputTokens !== undefined) parts.push(`↓${formatTokens(usage.outputTokens)}`);
  if (usage.reasoningTokens) parts.push(`思考${formatTokens(usage.reasoningTokens)}`);
  if (usage.durationMs !== undefined) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export class ChatPanelView extends ItemView {
  private state: ChatViewState = {
    stage: "idle",
    message: "",
    messages: [],
    attachments: [],
    includeActiveNote: true,
    running: false,
  };

  private stageDotEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private chatEl!: HTMLElement;
  private contextBarEl!: HTMLElement;
  private contextExtrasEl!: HTMLElement;
  private truncationWarnEl!: HTMLElement;
  private inventoryBtn!: HTMLButtonElement;
  private jumpToLatestBtn!: HTMLButtonElement;
  private mentionMenuEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private fileInputEl!: HTMLInputElement;
  private attachBtn!: HTMLButtonElement;
  private modelChipEl!: HTMLButtonElement;
  private reasoningChipEl!: HTMLButtonElement;
  private actionBtn!: HTMLButtonElement;
  private newChatBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private activeNoteBtn!: HTMLButtonElement;
  private dropTargetEl!: HTMLElement;

  private mentionResults: ContextSuggestion[] = [];
  private mentionIndex = 0;
  private mentionStart = -1;
  private lastInsertedContextEnd = -1;
  private customPrompts: CustomPrompt[] = [];
  private activeNotePath: string | null = null;
  private activeNoteChipText = "无笔记";
  private selectionChars: number | null = null;
  private turnSummaryTruncated = false;
  private contextInventory: ContextInventory | null = null;
  private openTabs: OpenTabChip[] = [];
  private models: ModelChoice[] = [];
  private reasoningOverride: ReasoningEffort = "default";
  private profileReasoningEffort: ReasoningEffort = "default";
  private configReady = true;
  private configBanner: string | null = null;
  private pendingUndoAvailable = false;
  private draftChangeTimer: number | null = null;
  private tagIndex: string[] | null = null;
  /** DOM handles for incremental streaming updates (avoid full chat re-render). */
  private messageNodeMap = new Map<
    string,
    { row: HTMLElement; textEl: HTMLElement; status: ChatMessage["status"] }
  >();

  private onCancel: (() => void) | null = null;
  private onSendMessage: ((message: string, attachments: ChatAttachment[]) => void) | null = null;
  private onNewChat: (() => void) | null = null;
  private onOpenHistory: (() => void) | null = null;
  private onPasteImages: ((files: File[]) => void) | null = null;
  private onRemoveAttachment: ((id: string) => void) | null = null;
  private onToggleActiveNote: ((value: boolean) => void) | null = null;
  private onOpenContextInventory: (() => void) | null = null;
  private onOpenSettings: (() => void | Promise<void>) | null = null;
  private onUndoLastApply: (() => void | Promise<void>) | null = null;
  private onCopyMessage: ((message: ChatMessage) => void) | null = null;
  private onEditMessage: ((message: ChatMessage) => void) | null = null;
  private onRegenerateMessage: ((message: ChatMessage) => void) | null = null;
  private onRetryMessage: ((message: ChatMessage) => void) | null = null;
  private onApplyMessage: ((message: ChatMessage) => void) | null = null;
  private onWriteBackMessage:
    | ((action: "insert" | "append" | "replace" | "create", text: string) => void | Promise<void>)
    | null = null;
  private onOpenSource: ((path: string) => void) | null = null;
  private onDraftContextChange: (() => void) | null = null;
  private onToggleOpenTab: ((path: string, selected: boolean) => void) | null = null;
  private onSelectModel: ((id: string) => void) | null = null;
  private onSelectReasoning: ((effort: ReasoningEffort) => void) | null = null;
  private onSelectTheme: ((theme: UiTheme) => void) | null = null;
  private onCollapsePanel: (() => void) | null = null;
  /** User-dragged composer height; null means auto-grow from content. */
  private manualInputHeight: number | null = null;
  private uiTheme: UiTheme = "sky";

  getViewType(): string {
    return AI_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 对话";
  }

  getIcon(): string {
    return "messages-square";
  }

  setHandlers(handlers: {
    onCancel: () => void;
    onSendMessage?: (message: string, attachments: ChatAttachment[]) => void;
    onNewChat?: () => void;
    onOpenHistory?: () => void;
    onPasteImages?: (files: File[]) => void;
    onRemoveAttachment?: (id: string) => void;
    onToggleActiveNote?: (value: boolean) => void;
    onOpenContextInventory?: () => void;
    onOpenSettings?: () => void | Promise<void>;
    onUndoLastApply?: () => void | Promise<void>;
    onCopyMessage?: (message: ChatMessage) => void;
    onEditMessage?: (message: ChatMessage) => void;
    onRegenerateMessage?: (message: ChatMessage) => void;
    onRetryMessage?: (message: ChatMessage) => void;
    onApplyMessage?: (message: ChatMessage) => void;
    onWriteBackMessage?: (
      action: "insert" | "append" | "replace" | "create",
      text: string,
    ) => void | Promise<void>;
    onOpenSource?: (path: string) => void;
    onDraftContextChange?: () => void;
    onToggleOpenTab?: (path: string, selected: boolean) => void;
    onSelectModel?: (id: string) => void;
    onSelectReasoning?: (effort: ReasoningEffort) => void;
    onSelectTheme?: (theme: UiTheme) => void;
    onCollapsePanel?: () => void;
  }): void {
    this.onCancel = handlers.onCancel;
    this.onSendMessage = handlers.onSendMessage ?? null;
    this.onNewChat = handlers.onNewChat ?? null;
    this.onOpenHistory = handlers.onOpenHistory ?? null;
    this.onPasteImages = handlers.onPasteImages ?? null;
    this.onRemoveAttachment = handlers.onRemoveAttachment ?? null;
    this.onToggleActiveNote = handlers.onToggleActiveNote ?? null;
    this.onOpenContextInventory = handlers.onOpenContextInventory ?? null;
    this.onOpenSettings = handlers.onOpenSettings ?? null;
    this.onUndoLastApply = handlers.onUndoLastApply ?? null;
    this.onCopyMessage = handlers.onCopyMessage ?? null;
    this.onEditMessage = handlers.onEditMessage ?? null;
    this.onRegenerateMessage = handlers.onRegenerateMessage ?? null;
    this.onRetryMessage = handlers.onRetryMessage ?? null;
    this.onApplyMessage = handlers.onApplyMessage ?? null;
    this.onWriteBackMessage = handlers.onWriteBackMessage ?? null;
    this.onOpenSource = handlers.onOpenSource ?? null;
    this.onDraftContextChange = handlers.onDraftContextChange ?? null;
    this.onToggleOpenTab = handlers.onToggleOpenTab ?? null;
    this.onSelectModel = handlers.onSelectModel ?? null;
    this.onSelectReasoning = handlers.onSelectReasoning ?? null;
    this.onSelectTheme = handlers.onSelectTheme ?? null;
    this.onCollapsePanel = handlers.onCollapsePanel ?? null;
  }

  // ── external state setters ────────────────────────────────────────────

  setModels(models: ModelChoice[]): void {
    this.models = models;
    this.renderModelChip();
  }

  setReasoningOverride(effort: ReasoningEffort): void {
    this.reasoningOverride = effort;
    this.renderReasoningChip();
  }

  setProfileReasoningEffort(effort: ReasoningEffort): void {
    this.profileReasoningEffort = effort;
    this.renderReasoningChip();
  }

  setTheme(theme: UiTheme): void {
    this.uiTheme = theme;
    this.contentEl.setAttr("data-vault-muse-theme", theme);
  }

  setOpenTabs(tabs: OpenTabChip[]): void {
    this.openTabs = tabs;
    if (this.contextBarEl) this.renderContextBar();
  }

  setActiveNotePath(path: string | null): void {
    this.activeNotePath = path;
  }

  setActiveNoteChipLabel(label: string): void {
    this.activeNoteChipText = label || "无笔记";
    if (this.activeNoteBtn) this.renderContextBar();
  }

  setSelectionChars(chars: number | null): void {
    this.selectionChars = chars && chars > 0 ? chars : null;
    if (this.contextBarEl) this.renderContextBar();
  }

  setContextInventory(inventory: ContextInventory): void {
    this.contextInventory = inventory;
    if (this.inventoryBtn) {
      this.inventoryBtn.setAttr(
        "title",
        inventory.line ? `上下文明细 · ${inventory.line}` : "查看本轮上下文明细",
      );
    }
  }

  setConfigStatus(ready: boolean, banner: string | null): void {
    const changed = this.configReady !== ready || this.configBanner !== banner;
    this.configReady = ready;
    this.configBanner = banner;
    this.updateComposerPlaceholder();
    if (changed && this.chatEl) this.renderChat();
  }

  setPendingUndoAvailable(value: boolean): void {
    if (this.pendingUndoAvailable === value) return;
    this.pendingUndoAvailable = value;
    if (this.chatEl && this.state.messages.length > 0) this.renderChat();
  }

  setTurnContextSummary(_line: string, truncated: boolean): void {
    this.turnSummaryTruncated = truncated;
    if (this.truncationWarnEl) {
      this.truncationWarnEl.hidden = !truncated;
      this.truncationWarnEl.setAttr(
        "title",
        truncated ? "上下文达到上限，部分内容会被截断" : "",
      );
    }
  }

  getComposerText(): string {
    return this.inputEl?.value ?? "";
  }

  setCustomPrompts(prompts: CustomPrompt[]): void {
    this.customPrompts = prompts;
    if (this.chatEl && this.state.messages.length === 0) this.renderChat();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("aichat-view");
    root.setAttr("data-vault-muse-theme", this.uiTheme);

    const header = root.createDiv({ cls: "aichat-header" });
    const identity = header.createDiv({ cls: "aichat-identity" });
    const mark = identity.createDiv({ cls: "aichat-brand-mark" });
    setIcon(mark, "sparkles");
    const identityText = identity.createDiv({ cls: "aichat-identity-text" });
    identityText.createDiv({ cls: "aichat-title", text: "AI 对话" });
    const stageRow = identityText.createDiv({ cls: "aichat-stage-row" });
    this.stageDotEl = stageRow.createSpan({ cls: "aichat-stage-dot" });
    this.stageEl = stageRow.createSpan({ cls: "aichat-stage" });

    const headerActions = header.createDiv({ cls: "aichat-header-actions" });
    const themeBtn = headerActions.createEl("button", {
      cls: "aichat-icon-button clickable-icon",
      attr: { "aria-label": "切换主题", title: "切换主题", type: "button" },
    });
    setIcon(themeBtn, "palette");
    themeBtn.addEventListener("click", (event) => this.openThemeMenu(event));
    this.historyBtn = this.makeIconButton(headerActions, "history", "对话历史", () =>
      this.onOpenHistory?.(),
    );
    this.newChatBtn = this.makeIconButton(headerActions, "plus", "新对话", () =>
      this.onNewChat?.(),
    );
    this.makeIconButton(headerActions, "chevrons-right", "收起面板", () =>
      this.onCollapsePanel?.(),
    );

    this.chatEl = root.createDiv({ cls: "aichat-chat" });
    this.chatEl.setAttr("aria-live", "polite");
    this.chatEl.addEventListener("scroll", () => this.updateJumpToLatestVisibility());

    this.dropTargetEl = root.createDiv({ cls: "aichat-drop-target", text: "松开以添加图片" });
    this.dropTargetEl.hidden = true;

    const composerShell = root.createDiv({ cls: "aichat-composer-shell" });

    this.mentionMenuEl = composerShell.createDiv({ cls: "aichat-mention-menu" });
    this.mentionMenuEl.hidden = true;

    this.contextBarEl = composerShell.createDiv({
      cls: "aichat-context-bar",
      attr: { "aria-label": "本轮上下文" },
    });
    this.contextExtrasEl = this.contextBarEl.createDiv({ cls: "aichat-context-extras" });
    const contextActions = this.contextBarEl.createDiv({ cls: "aichat-context-actions" });
    this.truncationWarnEl = contextActions.createSpan({
      cls: "aichat-context-warn",
      text: "已截断",
      attr: { title: "上下文达到上限，部分内容会被截断" },
    });
    this.truncationWarnEl.hidden = !this.turnSummaryTruncated;
    this.inventoryBtn = this.makeIconButton(contextActions, "list-tree", "查看本轮上下文明细", () =>
      this.onOpenContextInventory?.(),
    );
    this.jumpToLatestBtn = this.makeIconButton(contextActions, "arrow-down", "跳到最新", () =>
      this.scrollChatToBottom(true),
    );
    this.jumpToLatestBtn.addClass("aichat-jump-latest");

    // Resize grip sits flush on the composer card (no gap).
    const resizeHandle = composerShell.createDiv({
      cls: "aichat-composer-resize",
      attr: { title: "拖动调整输入框高度", role: "separator", "aria-orientation": "horizontal" },
    });
    resizeHandle.createDiv({ cls: "aichat-composer-resize-bar" });
    this.bindComposerResize(resizeHandle);

    const composer = composerShell.createDiv({ cls: "aichat-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "aichat-input",
      attr: { rows: "1", placeholder: "", "aria-label": "消息" },
    });
    this.inputEl.addEventListener("input", () => {
      this.resizeInput();
      this.updateSuggestionMenu();
      this.renderContextBar();
      this.scheduleDraftContextChange();
    });
    this.inputEl.addEventListener("blur", () =>
      window.setTimeout(() => this.closeSuggestionMenu(), 120),
    );
    this.inputEl.addEventListener("paste", (event) => this.handlePaste(event));
    this.inputEl.addEventListener("keydown", (event) => this.handleKeyDown(event));
    // Double-click resets to auto height.
    this.inputEl.addEventListener("dblclick", (event) => {
      if (event.target !== this.inputEl) return;
      this.manualInputHeight = null;
      this.resizeInput();
    });

    this.fileInputEl = composer.createEl("input", {
      cls: "aichat-file-input",
      attr: {
        type: "file",
        accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp",
        multiple: "true",
      },
    });
    this.fileInputEl.addEventListener("change", () => {
      const files = Array.from(this.fileInputEl.files ?? []);
      if (files.length > 0) this.onPasteImages?.(files);
      this.fileInputEl.value = "";
    });

    const toolbar = composer.createDiv({ cls: "aichat-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "aichat-toolbar-left" });
    this.attachBtn = this.makeIconButton(toolbarLeft, "paperclip", "上传图片", () =>
      this.fileInputEl.click(),
    );
    this.attachBtn.addClass("aichat-attach-button");
    this.modelChipEl = toolbarLeft.createEl("button", {
      cls: "aichat-toolbar-chip aichat-model-chip",
      attr: { type: "button", title: "切换模型配置" },
    });
    this.modelChipEl.addEventListener("click", (event) => this.openModelMenu(event));
    this.reasoningChipEl = toolbarLeft.createEl("button", {
      cls: "aichat-toolbar-chip aichat-reasoning-chip",
      attr: { type: "button", title: "本对话的推理强度（覆盖模型配置）" },
    });
    this.reasoningChipEl.addEventListener("click", (event) => this.openReasoningMenu(event));

    this.actionBtn = toolbar.createEl("button", { cls: "aichat-action" });
    this.actionBtn.addEventListener("click", () =>
      this.state.running ? this.onCancel?.() : this.submitMessage(),
    );

    root.addEventListener("dragover", (event) => this.handleDragOver(event));
    root.addEventListener("dragleave", (event) => this.handleDragLeave(event));
    root.addEventListener("drop", (event) => void this.handleDrop(event));

    this.registerEvent(this.app.vault.on("create", () => this.invalidateSuggestionIndex()));
    this.registerEvent(this.app.vault.on("delete", () => this.invalidateSuggestionIndex()));
    this.registerEvent(this.app.vault.on("rename", () => this.invalidateSuggestionIndex()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.invalidateSuggestionIndex()));

    this.renderChat();
    this.renderContextBar();
    this.renderStatus();
    this.renderModelChip();
    this.renderReasoningChip();
    this.updateComposerPlaceholder();
    this.updateJumpToLatestVisibility();
    this.resizeInput();
    this.onDraftContextChange?.();
  }

  async onClose(): Promise<void> {
    if (this.draftChangeTimer !== null) window.clearTimeout(this.draftChangeTimer);
    this.contentEl.empty();
  }

  // ── conversation state ────────────────────────────────────────────────

  setConversation(messages: ChatMessage[], includeActiveNote: boolean): void {
    this.state.messages = [...messages];
    this.state.includeActiveNote = includeActiveNote;
    this.renderChat();
    this.renderContextBar();
  }

  setPendingAttachments(attachments: ChatAttachment[]): void {
    this.state.attachments = attachments;
    this.renderContextBar();
    this.scheduleDraftContextChange();
  }

  update(partial: Partial<ChatViewState>): void {
    if (partial.stage !== undefined) this.state.stage = partial.stage;
    if (partial.message !== undefined) this.state.message = partial.message;
    if (partial.running !== undefined) this.state.running = partial.running;
    if (partial.messages) this.state.messages = [...partial.messages];
    if (partial.attachments) this.state.attachments = partial.attachments;
    if (partial.includeActiveNote !== undefined) {
      this.state.includeActiveNote = partial.includeActiveNote;
      this.renderContextBar();
    }
    this.renderStatus();
  }

  addChatMessage(message: ChatMessage): void {
    const wasEmpty = this.state.messages.length === 0;
    const shouldStick = this.shouldAutoScroll();
    this.state.messages.push(message);
    if (this.state.messages.length > 240) {
      this.state.messages = this.state.messages.slice(-240);
      this.renderChat();
      return;
    }
    if (wasEmpty) {
      this.renderChat();
      return;
    }
    this.appendMessageNode(message, shouldStick);
  }

  updateChatMessage(id: string, patch: Partial<ChatMessage>): void {
    const message = this.state.messages.find((item) => item.id === id);
    if (!message) return;
    const prevStatus = message.status;
    const shouldStick = this.shouldAutoScroll();
    Object.assign(message, patch);

    const node = this.messageNodeMap.get(id);
    // Fast path: streaming updates patch existing DOM instead of rebuilding the row.
    if (
      node &&
      message.status === "streaming" &&
      prevStatus === "streaming" &&
      patch.status !== "complete" &&
      patch.status !== "error" &&
      patch.status !== "cancelled"
    ) {
      let handled = true;
      if (patch.thoughtText !== undefined) {
        const thoughtBody = node.row.querySelector<HTMLElement>(".aichat-thought-body");
        const summary = node.row.querySelector<HTMLElement>(".aichat-thought > summary");
        if (thoughtBody && summary) {
          thoughtBody.setText(message.thoughtText ?? "");
          thoughtBody.scrollTop = thoughtBody.scrollHeight;
          const preview = (message.thoughtText ?? "").trim().replace(/\s+/g, " ").slice(0, 72);
          summary.setText(`思考中 · ${preview}${(message.thoughtText?.length ?? 0) > 72 ? "…" : ""}`);
        } else {
          // Thought element does not exist yet — rebuild once to create it.
          handled = false;
        }
      }
      if (handled && patch.text !== undefined) {
        node.textEl.setText(formatStreamingMarkdownPreview(message.text || ""));
        if (message.text) {
          node.row.querySelector(".aichat-thinking-placeholder")?.remove();
        }
      }
      if (handled) {
        if (shouldStick) this.scrollChatToBottom(true);
        else this.updateJumpToLatestVisibility();
        return;
      }
    }

    // Status transition, thought update, or missing node: rebuild this message row.
    if (node && this.chatEl.contains(node.row)) {
      const next = this.buildMessageRow(message);
      node.row.replaceWith(next.row);
      this.messageNodeMap.set(id, next);
      if (shouldStick) this.scrollChatToBottom(true);
      else this.updateJumpToLatestVisibility();
      return;
    }
    this.renderChat();
  }

  focusComposer(): void {
    this.inputEl?.focus();
  }

  setComposerText(text: string): void {
    this.inputEl.value = text;
    this.resizeInput();
    this.renderContextBar();
    this.scheduleDraftContextChange();
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
  }

  // ── toolbar menus ─────────────────────────────────────────────────────

  private renderModelChip(): void {
    if (!this.modelChipEl) return;
    const active = this.models.find((model) => model.active);
    this.modelChipEl.empty();
    const icon = this.modelChipEl.createSpan({ cls: "aichat-chip-icon" });
    setIcon(icon, "box");
    this.modelChipEl.createSpan({
      cls: "aichat-chip-label",
      text: active ? active.label : "未配置模型",
    });
    const chevron = this.modelChipEl.createSpan({ cls: "aichat-chip-chevron" });
    setIcon(chevron, "chevron-up");
    this.modelChipEl.classList.toggle("is-warning", !active);
    this.modelChipEl.setAttr(
      "title",
      active ? `${active.label} · ${active.detail}` : "尚未配置模型，点击前往设置",
    );
  }

  private openModelMenu(event: MouseEvent): void {
    if (this.models.length === 0) {
      void this.onOpenSettings?.();
      return;
    }
    const menu = new Menu();
    for (const model of this.models) {
      menu.addItem((item) =>
        item
          .setTitle(model.label)
          .setChecked(model.active)
          .onClick(() => this.onSelectModel?.(model.id)),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("管理模型配置…")
        .setIcon("settings")
        .onClick(() => void this.onOpenSettings?.()),
    );
    menu.showAtMouseEvent(event);
  }

  private openThemeMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const theme of UI_THEME_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(`${theme.label} · ${theme.description}`)
          .setChecked(theme.id === this.uiTheme)
          .onClick(() => this.onSelectTheme?.(theme.id)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private renderReasoningChip(): void {
    if (!this.reasoningChipEl) return;
    this.reasoningChipEl.empty();
    const icon = this.reasoningChipEl.createSpan({ cls: "aichat-chip-icon" });
    setIcon(icon, "brain");
    const following = this.reasoningOverride === "default";
    const effective = following ? this.profileReasoningEffort : this.reasoningOverride;
    const label = following
      ? `推理·跟随（${EFFORT_LABELS[effective]}）`
      : `推理·${EFFORT_LABELS[this.reasoningOverride]}`;
    this.reasoningChipEl.createSpan({
      cls: "aichat-chip-label",
      text: label,
    });
    this.reasoningChipEl.classList.toggle("is-active", !following);
  }

  private openReasoningMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const effort of EFFORT_ORDER) {
      const label =
        effort === "default"
          ? `默认（跟随配置·${EFFORT_LABELS[this.profileReasoningEffort]}）`
          : `${EFFORT_LABELS[effort]}（${effort}）`;
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setChecked(this.reasoningOverride === effort)
          .onClick(() => this.onSelectReasoning?.(effort)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  // ── input handling ────────────────────────────────────────────────────

  private makeIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "aichat-icon-button clickable-icon",
      attr: { "aria-label": label, title: label, type: "button" },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  private scheduleDraftContextChange(): void {
    if (this.draftChangeTimer !== null) window.clearTimeout(this.draftChangeTimer);
    // Context estimation walks the vault; debounce so typing stays snappy.
    this.draftChangeTimer = window.setTimeout(() => {
      this.draftChangeTimer = null;
      this.onDraftContextChange?.();
    }, 180);
  }

  private handlePaste(event: ClipboardEvent): void {
    const items = Array.from(event.clipboardData?.items ?? []).filter((item) =>
      item.type.startsWith("image/"),
    );
    const files = items
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    this.onPasteImages?.(files);
  }

  private handleDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    const hasImage = Array.from(event.dataTransfer.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!hasImage) return;
    event.preventDefault();
    this.dropTargetEl.hidden = false;
  }

  private handleDragLeave(event: DragEvent): void {
    const rect = this.contentEl.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      this.dropTargetEl.hidden = true;
    }
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    if (!event.dataTransfer) return;
    event.preventDefault();
    this.dropTargetEl.hidden = true;
    const imageFiles = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length > 0) this.onPasteImages?.(imageFiles);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.mentionMenuEl.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.moveSuggestion(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.moveSuggestion(-1);
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.isComposing &&
        this.mentionResults.length > 0
      ) {
        event.preventDefault();
        this.insertSuggestion(this.mentionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSuggestionMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submitMessage();
    }
  }

  private submitMessage(): void {
    if (this.state.running) {
      new Notice("正在生成回复，请先停止或等待完成");
      return;
    }
    const message = this.inputEl.value.trim();
    if (!message && this.state.attachments.length === 0) {
      this.inputEl.focus();
      return;
    }
    const attachments = [...this.state.attachments];
    this.inputEl.value = "";
    this.state.attachments = [];
    this.resizeInput();
    this.closeSuggestionMenu();
    this.renderContextBar();
    this.onSendMessage?.(message, attachments);
  }

  private resizeInput(): void {
    if (!this.inputEl) return;
    const maxHeight = Math.round(window.innerHeight * 0.45);
    const minHeight = 22;
    if (this.manualInputHeight != null) {
      const locked = Math.max(minHeight, Math.min(this.manualInputHeight, maxHeight));
      this.inputEl.setCssProps({ height: `${locked}px` });
      return;
    }
    this.inputEl.setCssProps({ height: "auto" });
    const next = Math.min(Math.max(this.inputEl.scrollHeight, minHeight), maxHeight);
    this.inputEl.setCssProps({ height: `${next}px` });
  }

  private bindComposerResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.inputEl) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = this.inputEl.getBoundingClientRect().height;
      const maxHeight = Math.round(window.innerHeight * 0.45);
      const minHeight = 22;
      handle.classList.add("is-dragging");
      const onMove = (moveEvent: PointerEvent) => {
        // Dragging up expands the composer.
        const next = Math.max(
          minHeight,
          Math.min(maxHeight, startHeight + (startY - moveEvent.clientY)),
        );
        this.manualInputHeight = next;
        this.inputEl.setCssProps({ height: `${next}px` });
      };
      const onUp = () => {
        handle.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ── # / suggestion menu ───────────────────────────────────────────────

  private updateSuggestionMenu(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, cursor);
    const match = before.match(/(?:^|\s)([#/])([^\n]*)$/);
    if (!match) {
      this.closeSuggestionMenu();
      return;
    }
    const trigger = match[1] ?? "";
    const matchStart = (match.index ?? 0) + (match[0].startsWith(" ") ? 1 : 0);
    if (this.lastInsertedContextEnd >= 0) {
      const afterInsertedToken = before.slice(this.lastInsertedContextEnd);
      if (!/[#/]/.test(afterInsertedToken)) {
        this.closeSuggestionMenu();
        return;
      }
      this.lastInsertedContextEnd = -1;
    }
    const query = (match[2] ?? "").trimStart();
    if (trigger === "#" && query.includes(" ")) {
      this.closeSuggestionMenu();
      return;
    }
    this.mentionStart = matchStart;
    const normalized = query.toLocaleLowerCase();
    this.mentionResults = this.getSuggestions(trigger, normalized);
    this.mentionIndex = 0;
    this.renderSuggestionMenu();
  }

  private invalidateSuggestionIndex(): void {
    this.tagIndex = null;
  }

  private ensureTagIndex(): string[] {
    if (this.tagIndex) return this.tagIndex;
    const tags = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ""));
      const frontmatter: unknown = cache?.frontmatter;
      const frontmatterTags =
        frontmatter && typeof frontmatter === "object"
          ? (frontmatter as Record<string, unknown>).tags
          : undefined;
      if (Array.isArray(frontmatterTags)) {
        frontmatterTags.forEach((tag) => {
          if (typeof tag === "string") tags.add(tag.replace(/^#/, ""));
        });
      } else if (typeof frontmatterTags === "string") {
        tags.add(frontmatterTags.replace(/^#/, ""));
      }
    }
    this.tagIndex = Array.from(tags);
    return this.tagIndex;
  }

  private getSuggestions(trigger: string, query: string): ContextSuggestion[] {
    if (trigger === "/") {
      return rankAtSuggestions(
        this.customPrompts.map((item) => ({
          kind: "prompt" as const,
          key: item.id,
          title: item.name,
          subtitle: item.description || item.prompt,
          prompt: item.prompt,
        })),
        query,
        { limit: 40, recentBiasMaxQueryLen: 0 },
      ).map((item) => ({
        kind: "prompt" as const,
        key: item.key,
        title: item.title,
        subtitle: item.subtitle,
        prompt: item.prompt,
      }));
    }
    if (trigger === "#") {
      return rankTagSuggestions(this.ensureTagIndex(), query, 80).map((item) => ({
        kind: "tag" as const,
        key: item.key,
        title: item.title,
        subtitle: item.subtitle,
      }));
    }
    return [];
  }

  private renderSuggestionMenu(): void {
    this.mentionMenuEl.empty();
    this.mentionMenuEl.hidden = false;
    if (this.mentionResults.length === 0) {
      this.mentionMenuEl.createDiv({ cls: "aichat-mention-empty", text: "没有匹配内容" });
      return;
    }
    this.mentionResults.forEach((suggestion, index) => {
      const item = this.mentionMenuEl.createEl("button", {
        cls: `aichat-mention-item${index === this.mentionIndex ? " is-selected" : ""}`,
        attr: { type: "button", title: suggestion.subtitle },
      });
      const icon = item.createSpan({ cls: "aichat-mention-icon" });
      setIcon(icon, suggestion.kind === "tag" ? "hash" : "sparkles");
      const labels = item.createSpan({ cls: "aichat-mention-labels" });
      labels.createSpan({ cls: "aichat-mention-name", text: suggestion.title });
      labels.createSpan({ cls: "aichat-mention-path", text: suggestion.subtitle });
      item.addEventListener("mouseenter", () => {
        if (index === this.mentionIndex) return;
        this.mentionIndex = index;
        this.renderSuggestionMenu();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSuggestion(index);
      });
    });
  }

  private moveSuggestion(delta: number): void {
    if (this.mentionResults.length === 0) return;
    this.mentionIndex =
      (this.mentionIndex + delta + this.mentionResults.length) % this.mentionResults.length;
    this.renderSuggestionMenu();
    this.mentionMenuEl
      .querySelector<HTMLElement>(".aichat-mention-item.is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private insertSuggestion(index: number): void {
    const suggestion = this.mentionResults[index];
    if (!suggestion || this.mentionStart < 0) return;
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const token =
      suggestion.kind === "tag" ? `#${suggestion.key} ` : `${suggestion.prompt} `;
    this.inputEl.value =
      this.inputEl.value.slice(0, this.mentionStart) + token + this.inputEl.value.slice(cursor);
    const nextCursor = this.mentionStart + token.length;
    this.inputEl.setSelectionRange(nextCursor, nextCursor);
    this.lastInsertedContextEnd = nextCursor;
    this.closeSuggestionMenu();
    this.resizeInput();
    this.renderContextBar();
    this.scheduleDraftContextChange();
    this.inputEl.focus();
  }

  private closeSuggestionMenu(): void {
    if (!this.mentionMenuEl) return;
    this.mentionMenuEl.hidden = true;
    this.mentionMenuEl.empty();
    this.mentionResults = [];
    this.mentionIndex = 0;
    this.mentionStart = -1;
  }

  // ── context bar ───────────────────────────────────────────────────────

  private renderContextBar(): void {
    if (!this.contextBarEl || !this.contextExtrasEl) return;

    // Keep the note toggle as the first child; rebuild extras in place.
    const existingNote = this.activeNoteBtn;
    if (!existingNote || !this.contextBarEl.contains(existingNote)) {
      this.activeNoteBtn = this.contextBarEl.createEl("button", {
        cls: "aichat-context-chip aichat-note-chip",
        attr: { type: "button" },
      });
      this.contextBarEl.insertBefore(this.activeNoteBtn, this.contextExtrasEl);
      this.activeNoteBtn.addEventListener("click", () =>
        this.onToggleActiveNote?.(!this.state.includeActiveNote),
      );
    }

    const on = this.state.includeActiveNote;
    const chipLabel = on ? this.activeNoteChipText || "无笔记" : "笔记";
    const chipTitle = on
      ? this.activeNotePath
        ? `已附带笔记：${this.activeNotePath}（点击关闭）`
        : "尚未打开 Markdown 笔记（点击关闭）"
      : "点击开启：把最近聚焦的 Markdown 笔记作为上下文";
    this.activeNoteBtn.className = `aichat-context-chip aichat-note-chip${
      on ? " is-active" : ""
    }${on && !this.activeNotePath ? " is-empty" : ""}`;
    this.activeNoteBtn.setAttr("title", chipTitle);
    this.activeNoteBtn.empty();
    setIcon(this.activeNoteBtn, "file-text");
    this.activeNoteBtn.createSpan({ text: chipLabel });

    this.contextExtrasEl.empty();

    if (on && this.selectionChars && this.selectionChars > 0) {
      const selectionChip = this.contextExtrasEl.createDiv({ cls: "aichat-selection-chip" });
      const icon = selectionChip.createSpan();
      setIcon(icon, "scan-text");
      selectionChip.createSpan({ text: `选区 ${this.selectionChars}` });
    }

    for (const attachment of this.state.attachments) {
      const chip = this.contextExtrasEl.createDiv({ cls: "aichat-attachment-chip" });
      chip.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(attachment.path),
          alt: attachment.name,
          title: attachment.name,
        },
      });
      const remove = chip.createEl("button", {
        cls: "aichat-chip-remove",
        attr: { "aria-label": "移除图片", title: "移除图片", type: "button" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => this.onRemoveAttachment?.(attachment.id));
    }

    for (const context of this.getDraftContexts()) {
      const chip = this.contextExtrasEl.createDiv({ cls: "aichat-draft-context" });
      const icon = chip.createSpan();
      setIcon(icon, "hash");
      chip.createSpan({ text: context.label, attr: { title: context.value } });
      const remove = chip.createEl("button", {
        cls: "aichat-draft-remove",
        attr: { "aria-label": "移除标签", title: "移除标签", type: "button" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.inputEl.value = this.inputEl.value.replace(context.token, "").replace(/ {2,}/g, " ");
        this.renderContextBar();
        this.scheduleDraftContextChange();
        this.inputEl.focus();
      });
    }

    for (const tab of this.openTabs) {
      if (!tab.selected) continue;
      if (this.activeNotePath && tab.path === this.activeNotePath) continue;
      const chip = this.contextExtrasEl.createEl("button", {
        cls: "aichat-context-chip aichat-open-tab is-active",
        attr: {
          type: "button",
          title: `取消作为上下文：${tab.path}`,
        },
      });
      setIcon(chip, "layers");
      chip.createSpan({ text: tab.label });
      chip.addEventListener("click", () => this.onToggleOpenTab?.(tab.path, false));
    }

    if (this.truncationWarnEl) {
      this.truncationWarnEl.hidden = !this.turnSummaryTruncated;
    }
  }

  private getDraftContexts(): Array<{
    token: string;
    value: string;
    label: string;
  }> {
    const contexts: Array<{ token: string; value: string; label: string }> = [];
    const pattern = /(?:^|\s)(#([\p{L}\p{N}_/-]+))/gu;
    for (const match of this.inputEl?.value.matchAll(pattern) ?? []) {
      const token = match[1];
      const tag = match[2];
      if (!token || !tag) continue;
      contexts.push({
        token,
        value: tag,
        label: `#${tag}`,
      });
    }
    return contexts.filter(
      (item, index, array) => array.findIndex((other) => other.token === item.token) === index,
    );
  }

  // ── chat rendering ────────────────────────────────────────────────────

  private scrollChatToBottom(force = false): void {
    if (!this.chatEl) return;
    if (!force && !this.shouldAutoScroll()) {
      this.updateJumpToLatestVisibility();
      return;
    }
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
    this.updateJumpToLatestVisibility();
  }

  private appendMessageNode(message: ChatMessage, autoScroll = true): void {
    if (!this.chatEl) return;
    const node = this.buildMessageRow(message);
    this.chatEl.appendChild(node.row);
    this.messageNodeMap.set(message.id, node);
    if (autoScroll) this.scrollChatToBottom(true);
    else this.updateJumpToLatestVisibility();
  }

  private buildMessageRow(message: ChatMessage): {
    row: HTMLElement;
    textEl: HTMLElement;
    status: ChatMessage["status"];
  } {
    const row = createDiv();
    row.className = `aichat-message is-${message.role} is-${message.status}`;
    row.dataset.messageId = message.id;

    const body = row.createDiv({ cls: "aichat-message-body" });

    if (message.role === "assistant" && message.status === "cancelled") {
      body.createDiv({
        cls: "aichat-status-banner is-cancelled",
        text: "已停止 · 以下为已生成的部分内容",
      });
    }
    if (message.role === "assistant" && message.status === "error") {
      body.createDiv({
        cls: "aichat-status-banner is-error",
        text: "出错了 · 可查看详情或用同一上下文重试",
      });
    }

    if (message.role === "assistant" && message.thoughtText?.trim()) {
      const thought = body.createEl("details", {
        cls: `aichat-thought${message.status === "streaming" ? " is-streaming" : ""}`,
        attr: message.status === "streaming" ? { open: "true" } : {},
      });
      const preview = message.thoughtText.trim().replace(/\s+/g, " ").slice(0, 72);
      thought.createEl("summary", {
        text:
          message.status === "streaming"
            ? `思考中 · ${preview}${message.thoughtText.length > 72 ? "…" : ""}`
            : "思考过程",
      });
      thought.createEl("pre", { cls: "aichat-thought-body", text: message.thoughtText });
    } else if (message.role === "assistant" && message.status === "streaming" && !message.text) {
      const placeholder = body.createDiv({ cls: "aichat-thinking-placeholder" });
      placeholder.createSpan({ text: "思考中" });
      const dots = placeholder.createSpan({ cls: "aichat-thinking-dots" });
      dots.createSpan();
      dots.createSpan();
      dots.createSpan();
    }

    const textEl = body.createDiv({ cls: "aichat-message-text" });
    if (message.role === "assistant" && message.status !== "streaming") {
      if (message.text.trim()) {
        void MarkdownRenderer.render(this.app, message.text, textEl, "", this);
      } else if (message.status === "cancelled") {
        textEl.setText("（已停止，尚未生成内容）");
      }
    } else if (message.role === "user") {
      this.renderUserText(textEl, message.text);
    } else {
      // Streaming: plain-text preview only; the caret and the "thinking" placeholder
      // already communicate progress, so avoid a duplicate "…".
      textEl.setText(formatStreamingMarkdownPreview(message.text || ""));
    }

    if (message.status === "error" && message.errorDetails) {
      const details = body.createEl("details", { cls: "aichat-error-details" });
      details.createEl("summary", { text: "查看错误详情" });
      details.createEl("pre", { text: message.errorDetails });
    }
    if (message.attachments?.length) {
      const images = body.createDiv({ cls: "aichat-message-attachments" });
      for (const attachment of message.attachments) {
        images.createEl("img", {
          attr: {
            src: this.app.vault.adapter.getResourcePath(attachment.path),
            alt: attachment.name,
            title: attachment.name,
          },
        });
      }
    }
    if (message.sources?.length) {
      const sources = body.createDiv({ cls: "aichat-sources" });
      for (const source of message.sources) {
        const button = sources.createEl("button", {
          cls: "aichat-source-chip",
          attr: { type: "button", title: source.path },
        });
        setIcon(
          button,
          source.kind === "tag"
            ? "hash"
            : source.kind === "folder"
              ? "folder"
              : source.kind === "open-tab"
                ? "layers"
                : "file-text",
        );
        button.createSpan({ text: source.label });
        button.addEventListener("click", () => this.onOpenSource?.(source.path));
      }
    }

    if (message.role === "assistant" && message.status !== "streaming") {
      const footer = body.createDiv({ cls: "aichat-message-footer" });
      const metaParts = [message.model, formatUsageLine(message.usage)].filter(Boolean);
      if (metaParts.length) {
        footer.createDiv({ cls: "aichat-message-meta", text: metaParts.join(" · ") });
      }
      const actions = footer.createDiv({ cls: "aichat-message-actions" });
      const copy = this.makeIconButton(actions, "copy", "复制回答", () =>
        this.onCopyMessage?.(message),
      );
      copy.addClass("aichat-message-action");
      if (this.pendingUndoAvailable) {
        const undo = this.makeIconButton(actions, "undo-2", "撤销上次应用", () =>
          void this.onUndoLastApply?.(),
        );
        undo.addClass("aichat-message-action");
      }
      if (message.status === "error") {
        const retry = this.makeIconButton(actions, "rotate-cw", "用同一上下文重试", () =>
          this.onRetryMessage?.(message),
        );
        retry.addClass("aichat-message-action");
      } else {
        const regenerate = this.makeIconButton(actions, "refresh-cw", "重新生成", () =>
          this.onRegenerateMessage?.(message),
        );
        regenerate.addClass("aichat-message-action");
      }
      if (
        (message.status === "complete" || message.status === "cancelled") &&
        message.text.trim()
      ) {
        const insert = this.makeIconButton(actions, "corner-down-left", "插入到当前笔记", () =>
          void this.onWriteBackMessage?.("insert", message.text),
        );
        const append = this.makeIconButton(actions, "list-plus", "追加到当前笔记", () =>
          void this.onWriteBackMessage?.("append", message.text),
        );
        const replace = this.makeIconButton(actions, "file-pen", "覆盖当前笔记", () =>
          void this.onWriteBackMessage?.("replace", message.text),
        );
        const create = this.makeIconButton(actions, "file-plus", "新建笔记", () =>
          void this.onWriteBackMessage?.("create", message.text),
        );
        const apply = this.makeIconButton(actions, "file-diff", "预览并应用文件更改", () =>
          this.onApplyMessage?.(message),
        );
        insert.addClass("aichat-message-action");
        append.addClass("aichat-message-action");
        replace.addClass("aichat-message-action");
        create.addClass("aichat-message-action");
        apply.addClass("aichat-message-action");
      }
    } else if (message.role === "user" && message.status === "complete") {
      const footer = body.createDiv({ cls: "aichat-message-footer is-user" });
      const actions = footer.createDiv({ cls: "aichat-message-actions" });
      const edit = this.makeIconButton(actions, "pencil", "编辑并重新发送", () =>
        this.onEditMessage?.(message),
      );
      const copy = this.makeIconButton(actions, "copy", "复制消息", () =>
        this.onCopyMessage?.(message),
      );
      edit.addClass("aichat-message-action");
      copy.addClass("aichat-message-action");
    }

    return { row, textEl, status: message.status };
  }

  private renderChat(): void {
    if (!this.chatEl) return;
    if (this.state.messages.length === 0) {
      this.messageNodeMap.clear();
      this.renderEmptyState();
      return;
    }
    const shouldStick = this.shouldAutoScroll();
    this.chatEl.empty();
    this.messageNodeMap.clear();
    this.renderConfigBanner();
    for (const message of this.state.messages) {
      this.appendMessageNode(message, false);
    }
    if (shouldStick) this.scrollChatToBottom(true);
    else this.updateJumpToLatestVisibility();
  }

  private renderUserText(container: HTMLElement, text: string): void {
    const pattern = /(?:^|\s)(#([\p{L}\p{N}_/-]+))/gu;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const full = match[0];
      const index = match.index ?? 0;
      const hashStart = index + (full.startsWith(" ") || full.startsWith("\n") ? 1 : 0);
      if (hashStart > cursor) container.appendText(text.slice(cursor, hashStart));
      const tag = match[2];
      if (!tag) continue;
      const pill = container.createEl("button", {
        cls: "aichat-file-pill",
        attr: { type: "button", title: `#${tag}` },
      });
      setIcon(pill, "hash");
      pill.createSpan({ text: `#${tag}` });
      pill.addEventListener("click", () => this.onOpenSource?.(`#${tag}`));
      cursor = hashStart + (match[1]?.length ?? 0);
    }
    if (cursor < text.length) container.appendText(text.slice(cursor));
  }

  private shouldAutoScroll(): boolean {
    if (!this.chatEl) return true;
    return shouldAutoScrollOnUpdate({
      scrollTop: this.chatEl.scrollTop,
      clientHeight: this.chatEl.clientHeight,
      scrollHeight: this.chatEl.scrollHeight,
    });
  }

  private updateJumpToLatestVisibility(): void {
    if (!this.jumpToLatestBtn || !this.chatEl) return;
    const metrics = {
      scrollTop: this.chatEl.scrollTop,
      clientHeight: this.chatEl.clientHeight,
      scrollHeight: this.chatEl.scrollHeight,
    };
    this.jumpToLatestBtn.hidden = !shouldShowJumpToLatest(metrics, this.state.messages.length > 0);
  }

  private updateComposerPlaceholder(): void {
    if (!this.inputEl) return;
    this.inputEl.placeholder = this.configReady
      ? "输入消息，# 标签，/ 提示词"
      : "先在设置中添加模型配置，再开始对话";
  }

  private renderEmptyState(): void {
    if (!this.chatEl) return;
    this.chatEl.empty();
    if (!this.configReady) {
      this.renderConfigBanner();
    }
    const empty = this.chatEl.createDiv({ cls: "aichat-empty-state" });
    const mark = empty.createDiv({ cls: "aichat-empty-mark" });
    setIcon(mark, "sparkles");
    empty.createDiv({
      cls: "aichat-empty-title",
      text: this.configReady ? "开始新的对话" : "先完成模型配置",
    });
    empty.createDiv({
      cls: "aichat-empty-text",
      text: this.configReady
        ? "和你的笔记库对话：提问、写作、总结、翻译，或让它提出可预览的笔记修改。"
        : this.configBanner || "在设置中添加一个模型配置即可开始。",
    });
    if (this.configReady) {
      empty.createDiv({
        cls: "aichat-empty-hint",
        text: "# 引用标签 · / 使用提示词 · 支持粘贴与拖入图片",
      });
      const workflows = this.customPrompts.filter((item) => item.isWorkflow).slice(0, 4);
      if (workflows.length > 0) {
        const grid = empty.createDiv({ cls: "aichat-empty-grid" });
        for (const prompt of workflows) {
          const card = grid.createEl("button", {
            cls: "aichat-empty-card",
            attr: { type: "button", title: prompt.prompt },
          });
          card.createDiv({ cls: "aichat-empty-card-title", text: prompt.name });
          card.createDiv({
            cls: "aichat-empty-card-desc",
            text: prompt.description || prompt.prompt.slice(0, 40),
          });
          card.addEventListener("click", () => {
            this.setComposerText(`${prompt.prompt}\n`);
          });
        }
      }
    }
    this.updateJumpToLatestVisibility();
  }

  private renderConfigBanner(): void {
    if (!this.chatEl || this.configReady) return;
    const banner = this.chatEl.createDiv({ cls: "aichat-config-banner" });
    banner.createDiv({
      cls: "aichat-config-banner-text",
      text: this.configBanner || "还没有可用的模型配置。",
    });
    const actions = banner.createDiv({ cls: "aichat-config-banner-actions" });
    const settings = actions.createEl("button", {
      cls: "mod-cta",
      text: "打开设置",
      attr: { type: "button" },
    });
    settings.addEventListener("click", () => void this.onOpenSettings?.());
  }

  private lastStatusKey = "";

  private renderStatus(): void {
    if (!this.stageEl) return;
    const { stage, running } = this.state;
    this.stageEl.setAttr("title", this.state.message || STAGE_LABEL[stage]);
    const key = `${stage}|${running}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.stageEl.setText(STAGE_LABEL[stage]);
    this.stageDotEl.className = `aichat-stage-dot is-${stage}${running ? " is-running" : ""}`;
    if (running) this.closeSuggestionMenu();
    this.actionBtn.empty();
    setIcon(this.actionBtn, running ? "square" : "arrow-up");
    this.actionBtn.className = `aichat-action${running ? " is-stop" : ""}`;
    this.actionBtn.setAttr("aria-label", running ? "停止" : "发送");
    this.actionBtn.setAttr("title", running ? "停止生成" : "发送（Enter）");
  }
}
