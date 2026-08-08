import type { ApiUsage, ReasoningEffort } from "./providers/types";

export type ChatRole = "user" | "assistant";
export type MessageStatus = "complete" | "streaming" | "error" | "cancelled";

export interface ChatAttachment {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
}

export interface ChatSource {
  path: string;
  label: string;
  kind: "file" | "folder" | "tag" | "active-note" | "open-tab";
}

/** Record of a context file included with a user message (for cache-friendly dedupe). */
export interface ContextAttachmentRecord {
  path: string;
  hash: string;
  /** True when the full body was attached; false when only referenced as unchanged. */
  full: boolean;
}

export interface MessageUsage extends ApiUsage {
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** User-visible text (what the user typed / the assistant's answer). */
  text: string;
  createdAt: number;
  status: MessageStatus;
  model?: string;
  errorDetails?: string;
  /** Accumulated model thought/reasoning for collapsible UI. */
  thoughtText?: string;
  attachments?: ChatAttachment[];
  sources?: ChatSource[];
  /** Exact content sent to the API for this user turn (kept verbatim for prompt caching). */
  apiText?: string;
  /** Context files attached with this user turn. */
  contextAttachments?: ContextAttachmentRecord[];
  /** Token usage and timing reported by the provider for this assistant turn. */
  usage?: MessageUsage;
  /** User message text that produced this assistant turn (for retry). */
  retryUserText?: string;
  retryAttachments?: ChatAttachment[];
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  includeActiveNote: boolean;
  /** Vault paths of open-tab notes included as context (max 3). */
  openTabPaths?: string[];
  /** Pinned conversations stay at the top of history and resist auto-trim. */
  pinned?: boolean;
  /** First message included in the API window (older ones are dropped for length). */
  historyStartMessageId?: string;
  /** Per-conversation reasoning override; "default" follows the model profile. */
  reasoningOverride?: ReasoningEffort;
  messages: ChatMessage[];
}

export interface PersistedChatState {
  currentConversationId: string;
  conversations: ChatConversation[];
}

export interface CustomPrompt {
  id: string;
  name: string;
  prompt: string;
  /** Optional short description shown in / menu and settings. */
  description?: string;
  /** Workflow templates get a clearer label in the slash menu. */
  isWorkflow?: boolean;
}

export interface ContextSelection {
  filePaths: string[];
  folderPaths: string[];
  tags: string[];
}

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createConversation(includeActiveNote = true): ChatConversation {
  const now = Date.now();
  return {
    id: createId("chat"),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    includeActiveNote,
    messages: [],
  };
}

export function createInitialChatState(includeActiveNote = true): PersistedChatState {
  const conversation = createConversation(includeActiveNote);
  return {
    currentConversationId: conversation.id,
    conversations: [conversation],
  };
}
