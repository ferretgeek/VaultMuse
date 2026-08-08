import { App, Menu, Notice, PluginSettingTab, Setting } from "obsidian";
import type AiChatPlugin from "./main";
import type { CustomPrompt } from "./chatTypes";
import { createId } from "./chatTypes";
import {
  DEFAULT_CONTEXT_LIMITS,
  type ContextLimitOverrides,
  mergeContextLimits,
} from "./contextLimits";
import { minutesInputToMs, msToMinutesDisplay } from "./timeoutFormat";
import {
  createDefaultProfile,
  listModels,
  testConnection,
  EFFORT_LABELS,
  EFFORT_ORDER,
  PROVIDER_KIND_LABELS,
  type ProviderKind,
  type ProviderProfile,
  type ReasoningEffort,
} from "./providers";
import { normalizeUiTheme, type UiTheme } from "./uiTheme";
import { ConfirmModal } from "./confirmModal";

export interface PluginSettings {
  uiTheme: UiTheme;
  profiles: ProviderProfile[];
  activeProfileId: string;
  /** Custom system prompt; empty = built-in chat-assistant prompt. */
  systemPrompt: string;
  /** Appended to the system prompt (stable per conversation → cache friendly). */
  extraInstructions: string;
  includeActiveNoteByDefault: boolean;
  historyLimit: number;
  /** Char budget for the replayed conversation window sent to the API. */
  maxHistoryChars: number;
  /** Absolute wall-clock timeout for one turn. */
  timeoutMs: number;
  /** Abort when no bytes arrive for this long (capped by timeoutMs). */
  idleTimeoutMs: number;
  /** Delete vault screenshot files when removing attachments / conversations. */
  deleteAttachmentsOnCleanup: boolean;
  customPrompts: CustomPrompt[];
  /** Optional overrides for vault context caps. */
  contextLimits?: ContextLimitOverrides;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  uiTheme: "sky",
  profiles: [],
  activeProfileId: "",
  systemPrompt: "",
  extraInstructions: "",
  includeActiveNoteByDefault: true,
  historyLimit: 20,
  maxHistoryChars: 200_000,
  timeoutMs: 10 * 60 * 1000,
  idleTimeoutMs: 5 * 60 * 1000,
  deleteAttachmentsOnCleanup: true,
  customPrompts: [
    {
      id: "summarize",
      name: "总结",
      prompt: "帮我总结下面的内容：提炼核心结论、关键论据和可执行的行动项。",
      description: "提炼结论与行动项",
      isWorkflow: true,
    },
    {
      id: "polish",
      name: "润色",
      prompt: "帮我把下面的内容润色成清晰、自然的中文，保留 Markdown 结构，不改变原意。",
      description: "润色为清晰中文",
      isWorkflow: true,
    },
    {
      id: "translate",
      name: "翻译",
      prompt: "把下面的内容翻译成地道的简体中文，保留 Markdown 结构与术语准确性。",
      description: "译为中文并保留结构",
      isWorkflow: true,
    },
    {
      id: "meeting-notes",
      name: "会议纪要",
      prompt:
        "把下面的内容整理成会议纪要：议题、讨论要点、决议、待办（能确定时标注负责人和截止日期），用清晰的 Markdown。",
      description: "工作流：会议纪要",
      isWorkflow: true,
    },
    {
      id: "weekly-review",
      name: "周报复盘",
      prompt:
        "把下面的内容整理成周报复盘：本周进展、阻塞、下周计划、风险，条目化，适合直接贴进笔记。",
      description: "工作流：周报复盘",
      isWorkflow: true,
    },
  ],
  contextLimits: { ...DEFAULT_CONTEXT_LIMITS },
};

export function activeProfile(settings: PluginSettings): ProviderProfile | null {
  return (
    settings.profiles.find((profile) => profile.id === settings.activeProfileId) ??
    settings.profiles[0] ??
    null
  );
}

export function profileDisplayName(profile: ProviderProfile): string {
  return profile.name.trim() || profile.model.trim() || "未命名配置";
}

/** Commit a numeric text field on blur/Enter instead of every keystroke. */
function bindNumberField(
  inputEl: HTMLInputElement,
  options: {
    get: () => string;
    parse: (raw: string) => number | null;
    apply: (value: number) => void | Promise<void>;
  },
): void {
  inputEl.value = options.get();
  const commit = async () => {
    const parsed = options.parse(inputEl.value);
    if (parsed === null) {
      inputEl.value = options.get();
      return;
    }
    await options.apply(parsed);
    inputEl.value = options.get();
  };
  inputEl.addEventListener("blur", () => void commit());
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
      inputEl.blur();
    }
  });
}

const QUICK_PRESETS: Array<{
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  name: string;
}> = [
  { label: "OpenAI 官方", kind: "openai-responses", baseUrl: "https://api.openai.com/v1", name: "OpenAI" },
  { label: "Anthropic 官方", kind: "anthropic", baseUrl: "https://api.anthropic.com", name: "Claude" },
  { label: "OpenAI 兼容中转", kind: "openai-chat", baseUrl: "", name: "" },
  { label: "本地 Ollama", kind: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", name: "Ollama" },
];

export class AiChatSettingTab extends PluginSettingTab {
  plugin: AiChatPlugin;

  constructor(app: App, plugin: AiChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("aichat-settings");
    containerEl.setAttr("data-vault-muse-theme", normalizeUiTheme(this.plugin.settings.uiTheme));

    this.renderProfiles(containerEl);
    this.renderChatSection(containerEl);
    this.renderPrompts(containerEl);
    this.renderAdvanced(containerEl);
  }

  private async save(): Promise<void> {
    this.plugin.saveSettingsDebounced();
  }

  // ── 模型配置 ────────────────────────────────────────────────────────────

  private renderProfiles(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("模型配置").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "支持 OpenAI Responses、OpenAI 兼容（Chat Completions）与 Anthropic Messages。API Key 与敏感 Headers 默认只在本次 Obsidian 会话的内存中使用。",
    });

    if (this.plugin.settings.profiles.length === 0) {
      containerEl.createDiv({
        cls: "aichat-settings-empty",
        text: "还没有模型配置。用下面的快速添加按钮创建一个，填好 Base URL、API Key 和模型 ID 即可开始对话。",
      });
    }

    for (const profile of this.plugin.settings.profiles) {
      this.renderProfile(containerEl, profile);
    }

    const addRow = new Setting(containerEl)
      .setName("添加模型配置")
      .setDesc("按服务商预设快速创建，再补全 Key 与模型 ID。");
    for (const preset of QUICK_PRESETS) {
      addRow.addButton((button) =>
        button.setButtonText(preset.label).onClick(async () => {
          const profile = createDefaultProfile(preset.kind);
          profile.baseUrl = preset.baseUrl || profile.baseUrl;
          profile.name = preset.name;
          this.plugin.settings.profiles.push(profile);
          if (!this.plugin.settings.activeProfileId) {
            this.plugin.settings.activeProfileId = profile.id;
          }
          await this.save();
          this.display();
        }),
      );
    }
  }

  private renderProfile(containerEl: HTMLElement, profile: ProviderProfile): void {
    const isActive = activeProfile(this.plugin.settings)?.id === profile.id;
    const box = containerEl.createEl("details", {
      cls: `aichat-settings-profile${isActive ? " is-active" : ""}`,
    });
    // API Key may be empty for local endpoints; only force-open when essentials are missing.
    if (!profile.baseUrl.trim() || !profile.model.trim()) box.setAttr("open", "true");

    const summary = box.createEl("summary");
    summary.createSpan({ cls: "aichat-settings-profile-name", text: profileDisplayName(profile) });
    summary.createSpan({
      cls: "aichat-settings-profile-kind",
      text: PROVIDER_KIND_LABELS[profile.kind],
    });
    if (isActive) summary.createSpan({ cls: "aichat-settings-profile-badge", text: "使用中" });

    const body = box.createDiv({ cls: "aichat-settings-profile-body" });

    new Setting(body)
      .setName("名称")
      .setDesc("显示在模型选择器中的名字。")
      .addText((text) =>
        text
          .setPlaceholder("例如：GPT-5.1")
          .setValue(profile.name)
          .onChange(async (value) => {
            profile.name = value.trim();
            await this.save();
          }),
      );

    new Setting(body)
      .setName("接口类型")
      .setDesc("决定请求协议与推理参数的写法。")
      .addDropdown((dropdown) => {
        for (const kind of Object.keys(PROVIDER_KIND_LABELS) as ProviderKind[]) {
          dropdown.addOption(kind, PROVIDER_KIND_LABELS[kind]);
        }
        dropdown.setValue(profile.kind).onChange(async (value) => {
          profile.kind = value as ProviderKind;
          await this.save();
          this.display();
        });
      });

    new Setting(body)
      .setName("Base URL")
      .setDesc(
        profile.kind === "anthropic"
          ? "例如 https://api.anthropic.com（/v1 会自动补全）。"
          : "遵循 SDK 约定，需包含 /v1，例如 https://api.openai.com/v1。也可直接填完整端点。",
      )
      .addText((text) => {
        text
          .setPlaceholder(
            profile.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
          )
          .setValue(profile.baseUrl)
          .onChange(async (value) => {
            profile.baseUrl = value.trim();
            await this.save();
          });
        text.inputEl.addClass("aichat-settings-wide-input");
      });

    new Setting(body)
      .setName("API Key")
      .setDesc(
        profile.rememberSensitiveFields
          ? "已选择保存在本地 data.json；请勿同步或公开该文件。"
          : "仅驻留当前会话内存；重启 Obsidian 后需要重新填写。",
      )
      .addText((text) => {
        text.setPlaceholder("sk-…").setValue(profile.apiKey).onChange(async (value) => {
          profile.apiKey = value.trim();
          await this.save();
        });
        text.inputEl.addClass("aichat-settings-wide-input");
        text.inputEl.type = "password";
        text.inputEl.setAttr("autocomplete", "off");
        text.inputEl.setAttr("spellcheck", "false");
      })
      .addExtraButton((button) => {
        button.setIcon("eye").setTooltip("显示或隐藏 API Key").onClick(() => {
          const input = body.querySelector<HTMLInputElement>('input[type="password"], input[data-vault-muse-key="true"]');
          if (!input) return;
          input.dataset.vaultMuseKey = "true";
          input.type = input.type === "password" ? "text" : "password";
          button.setIcon(input.type === "password" ? "eye" : "eye-off");
        });
      });

    new Setting(body)
      .setName("在本地保存敏感配置")
      .setDesc("关闭时 API Key 与自定义 Headers 不写入 data.json；推荐保持关闭。")
      .addToggle((toggle) =>
        toggle.setValue(profile.rememberSensitiveFields).onChange(async (value) => {
          profile.rememberSensitiveFields = value;
          await this.save();
          this.display();
        }),
      );

    new Setting(body)
      .setName("模型 ID")
      .setDesc("发送给接口的 model 字段。")
      .addText((text) => {
        text
          .setPlaceholder(profile.kind === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.1")
          .setValue(profile.model)
          .onChange(async (value) => {
            profile.model = value.trim();
            await this.save();
          });
        text.inputEl.addClass("aichat-settings-wide-input");
      })
      .addButton((button) =>
        button.setButtonText("获取列表").onClick(async (event) => {
          button.setDisabled(true).setButtonText("获取中…");
          try {
            const models = await listModels(profile);
            if (models.length === 0) {
              new Notice("接口没有返回模型列表");
              return;
            }
            const menu = new Menu();
            for (const model of models.slice(0, 200)) {
              menu.addItem((item) =>
                item
                  .setTitle(model)
                  .setChecked(model === profile.model)
                  .onClick(async () => {
                    profile.model = model;
                    await this.save();
                    this.display();
                  }),
              );
            }
            menu.showAtMouseEvent(event);
          } catch (error) {
            new Notice(
              `获取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
              8000,
            );
          } finally {
            button.setDisabled(false).setButtonText("获取列表");
          }
        }),
      );

    new Setting(body)
      .setName("推理强度")
      .setDesc(
        "OpenAI 系发送 reasoning_effort（low/medium/high/xhigh/max，按模型支持情况选择；GPT-5.6 等支持 max）。最低档为 low。「默认」表示不主动指定该参数。对话面板选「默认」时跟随本配置，也可按会话临时覆盖。",
      )
      .addDropdown((dropdown) => {
        for (const effort of EFFORT_ORDER) {
          dropdown.addOption(effort, effortOptionLabel(effort));
        }
        dropdown.setValue(profile.reasoningEffort).onChange(async (value) => {
          profile.reasoningEffort = value as ReasoningEffort;
          await this.save();
        });
      });

    if (profile.kind === "anthropic") {
      new Setting(body)
        .setName("思考预算（tokens）")
        .setDesc("覆盖档位映射，直接指定 thinking budget_tokens（≥1024）。只要填写就会生效（会话推理为「默认」且配置也为默认时除外）。留空按当前推理档位映射：低 4096 / 中 10240 / 高 24576 / 极高 32768 / MAX 65536。")
        .addText((text) => {
          text.setPlaceholder("留空 = 按档位");
          bindNumberField(text.inputEl, {
            get: () =>
              profile.thinkingBudgetTokens ? String(profile.thinkingBudgetTokens) : "",
            parse: (raw) => {
              const trimmed = raw.trim();
              if (!trimmed) return 0;
              const n = Number(trimmed);
              return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : null;
            },
            apply: async (value) => {
              profile.thinkingBudgetTokens = value > 0 ? value : undefined;
              await this.save();
            },
          });
        });
    }

    if (profile.kind === "openai-responses") {
      new Setting(body)
        .setName("推理摘要")
        .setDesc("在对话中展示模型的思考摘要。官方 API 需组织通过验证，否则请求会报错；报错时改回「关闭」。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("", "关闭")
            .addOption("auto", "auto")
            .addOption("detailed", "detailed")
            .setValue(profile.reasoningSummary ?? "")
            .onChange(async (value) => {
              profile.reasoningSummary = value as ProviderProfile["reasoningSummary"];
              await this.save();
            }),
        );
    }

    if (profile.kind !== "anthropic") {
      new Setting(body)
        .setName("输出详细度 verbosity")
        .setDesc("GPT-5 系列支持；其它模型请保持「默认」。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("", "默认")
            .addOption("low", "low")
            .addOption("medium", "medium")
            .addOption("high", "high")
            .setValue(profile.verbosity ?? "")
            .onChange(async (value) => {
              profile.verbosity = value as ProviderProfile["verbosity"];
              await this.save();
            }),
        );
    }

    new Setting(body)
      .setName("最大输出 tokens")
      .setDesc("留空使用服务商默认（Anthropic 必填参数，留空时按 8192 发送；开启思考时自动加大）。")
      .addText((text) => {
        text.setPlaceholder("留空 = 默认");
        bindNumberField(text.inputEl, {
          get: () => (profile.maxOutputTokens ? String(profile.maxOutputTokens) : ""),
          parse: (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) return 0;
            const n = Number(trimmed);
            return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
          },
          apply: async (value) => {
            profile.maxOutputTokens = value > 0 ? value : undefined;
            await this.save();
          },
        });
      });

    new Setting(body)
      .setName("温度 temperature")
      .setDesc("留空不发送（推理模型通常不允许该参数）。Anthropic 开启思考时自动忽略。")
      .addText((text) => {
        text.setPlaceholder("留空 = 默认");
        text.inputEl.value =
          typeof profile.temperature === "number" ? String(profile.temperature) : "";
        const commit = async () => {
          const raw = text.inputEl.value.trim();
          if (!raw) {
            profile.temperature = undefined;
            await this.save();
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0 || n > 2) {
            text.inputEl.value =
              typeof profile.temperature === "number" ? String(profile.temperature) : "";
            return;
          }
          profile.temperature = n;
          await this.save();
        };
        text.inputEl.addEventListener("blur", () => void commit());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
        });
      });

    new Setting(body)
      .setName("自定义 Headers")
      .setDesc("每行一条「Name: value」。Host、Cookie、Content-Length 等危险或逐跳请求头会被忽略。")
      .addTextArea((textarea) => {
        textarea.setPlaceholder("X-Custom: value").setValue(profile.extraHeaders ?? "");
        textarea.inputEl.rows = 2;
        textarea.inputEl.addClass("aichat-settings-wide-input");
        textarea.onChange(async (value) => {
          profile.extraHeaders = value;
          await this.save();
        });
      });

    const actions = new Setting(body);
    if (!isActive) {
      actions.addButton((button) =>
        button.setButtonText("设为当前模型").onClick(async () => {
          this.plugin.settings.activeProfileId = profile.id;
          await this.save();
          this.display();
        }),
      );
    }
    actions.addButton((button) =>
      button
        .setButtonText("测试连接")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText("测试中…");
          const result = await testConnection(profile);
          new Notice(result.message, result.ok ? 6000 : 10_000);
          button.setDisabled(false).setButtonText("测试连接");
        }),
    );
    actions.addButton((button) =>
      button
        .setButtonText("删除")
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.profiles = this.plugin.settings.profiles.filter(
            (item) => item.id !== profile.id,
          );
          if (this.plugin.settings.activeProfileId === profile.id) {
            this.plugin.settings.activeProfileId = this.plugin.settings.profiles[0]?.id ?? "";
          }
          await this.save();
          this.display();
        }),
    );
  }

  // ── 对话 ────────────────────────────────────────────────────────────────

  private renderChatSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("对话").setHeading();

    new Setting(containerEl)
      .setName("默认附带当前笔记")
      .setDesc("新对话默认把最近聚焦的 Markdown 笔记作为上下文；每个对话可在面板中单独切换。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeActiveNoteByDefault).onChange(async (value) => {
          this.plugin.settings.includeActiveNoteByDefault = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName("对话历史上限")
      .setDesc("本地最多保留多少个对话（置顶对话始终保留）。失焦或回车后生效。")
      .addText((text) =>
        bindNumberField(text.inputEl, {
          get: () => String(this.plugin.settings.historyLimit),
          parse: (raw) => {
            const n = Number(raw);
            return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
          },
          apply: async (value) => {
            this.plugin.settings.historyLimit = value;
            this.plugin.applyHistoryLimit(value);
            await this.save();
          },
        }),
      );

    new Setting(containerEl)
      .setName("自定义系统提示词")
      .setDesc("留空使用内置的聊天助手提示词（含笔记编辑协议）。修改会导致缓存前缀刷新一次。")
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder("留空 = 内置聊天助手提示词")
          .setValue(this.plugin.settings.systemPrompt);
        textarea.inputEl.rows = 4;
        textarea.inputEl.addClass("aichat-settings-wide-input");
        textarea.onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName("附加指令")
      .setDesc("追加在系统提示词之后，适合写个人偏好（语气、格式、称呼等）。")
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder("例如：回答保持简洁，代码注释用中文。")
          .setValue(this.plugin.settings.extraInstructions);
        textarea.inputEl.rows = 3;
        textarea.inputEl.addClass("aichat-settings-wide-input");
        textarea.onChange(async (value) => {
          this.plugin.settings.extraInstructions = value;
          await this.save();
        });
      });
  }

  // ── 斜杠提示词 ──────────────────────────────────────────────────────────

  private renderPrompts(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("斜杠提示词与工作流").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "在输入框输入 / 可选用；工作流条目还会出现在空对话的快速开始里。",
    });

    const prompts = this.plugin.settings.customPrompts ?? [];
    for (let index = 0; index < prompts.length; index += 1) {
      const item = prompts[index];
      if (!item) continue;
      const row = containerEl.createDiv({ cls: "aichat-settings-prompt-row" });
      new Setting(row)
        .setName(item.isWorkflow ? `工作流 · ${item.name || "未命名"}` : item.name || `提示词 ${index + 1}`)
        .setDesc(item.description || item.prompt.slice(0, 80))
        .addText((text) => {
          text.setPlaceholder("名称").setValue(item.name);
          text.onChange(async (value) => {
            item.name = value.trim() || item.name;
            await this.save();
          });
        })
        .addToggle((toggle) =>
          toggle
            .setTooltip("工作流")
            .setValue(Boolean(item.isWorkflow))
            .onChange(async (value) => {
              item.isWorkflow = value;
              await this.save();
              this.display();
            }),
        )
        .addButton((button) =>
          button
            .setButtonText("删除")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.customPrompts = prompts.filter((_, i) => i !== index);
              await this.save();
              this.display();
            }),
        );
      new Setting(row).setName("说明").addText((text) => {
        text.setPlaceholder("可选说明").setValue(item.description ?? "");
        text.onChange(async (value) => {
          item.description = value.trim();
          await this.save();
        });
      });
      new Setting(row).setName("提示词正文").addTextArea((textarea) => {
        textarea.setValue(item.prompt);
        textarea.inputEl.rows = 3;
        textarea.inputEl.addClass("aichat-settings-wide-input");
        textarea.onChange(async (value) => {
          item.prompt = value;
          await this.save();
        });
      });
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("添加提示词")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.customPrompts.push({
            id: createId("prompt"),
            name: "新提示词",
            prompt: "请根据下面的内容……",
            description: "",
            isWorkflow: false,
          });
          await this.save();
          this.display();
        }),
    );
  }

  // ── 高级 ────────────────────────────────────────────────────────────────

  private renderAdvanced(containerEl: HTMLElement): void {
    const advanced = containerEl.createEl("details", { cls: "aichat-settings-advanced" });
    advanced.createEl("summary", { text: "高级选项" });
    const body = advanced.createDiv({ cls: "aichat-settings-advanced-body" });

    new Setting(body)
      .setName("历史窗口字符上限")
      .setDesc(
        "每次请求回放的对话历史总字符预算。超限时窗口起点会一次性前移到约 60%，之后前缀保持不变以维持缓存命中。",
      )
      .addText((text) =>
        bindNumberField(text.inputEl, {
          get: () => String(this.plugin.settings.maxHistoryChars),
          parse: (raw) => {
            const n = Number(raw);
            return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : null;
          },
          apply: async (value) => {
            this.plugin.settings.maxHistoryChars = value;
            await this.save();
          },
        }),
      );

    new Setting(body)
      .setName("总超时（分钟）")
      .setDesc("单轮请求最长等待时间，最小 0.2 分钟。")
      .addText((text) =>
        bindNumberField(text.inputEl, {
          get: () => msToMinutesDisplay(this.plugin.settings.timeoutMs),
          parse: (raw) => minutesInputToMs(raw, 10_000),
          apply: async (value) => {
            this.plugin.settings.timeoutMs = value;
            await this.save();
          },
        }),
      );

    new Setting(body)
      .setName("无进度超时（分钟）")
      .setDesc("连续没有收到任何数据超过该时间则中止。高推理档位下模型可能长时间静默，建议 ≥ 5 分钟。")
      .addText((text) =>
        bindNumberField(text.inputEl, {
          get: () => msToMinutesDisplay(this.plugin.settings.idleTimeoutMs),
          parse: (raw) => minutesInputToMs(raw, 5_000),
          apply: async (value) => {
            this.plugin.settings.idleTimeoutMs = value;
            await this.save();
          },
        }),
      );

    new Setting(body)
      .setName("清理时删除截图附件")
      .setDesc("移除待发送图片、删除对话或清理孤立截图时，把插件保存的截图移到 Obsidian 配置的废纸篓。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deleteAttachmentsOnCleanup).onChange(async (value) => {
          this.plugin.settings.deleteAttachmentsOnCleanup = value;
          await this.save();
        }),
      );

    new Setting(body)
      .setName("清理孤立截图")
      .setDesc("把插件保存且未被任何对话引用的截图移到废纸篓。")
      .addButton((button) =>
        button.setButtonText("立即清理").onClick(() => {
          void this.plugin.cleanupOrphanScreenshots().then((count) => {
            button.setButtonText(count > 0 ? `已移到废纸篓 ${count} 个` : "没有可清理项");
            window.setTimeout(() => {
              button.setButtonText("立即清理");
            }, 2000);
          });
        }),
      );

    new Setting(body)
      .setName("清除全部本地数据")
      .setDesc("删除模型配置、敏感字段、对话历史、提示词与插件设置；Vault 笔记和附件不会被删除。")
      .addButton((button) =>
        button
          .setButtonText("清除本地数据")
          .setWarning()
          .onClick(async () => {
            const confirmed = await new ConfirmModal(
              this.app,
              "清除 VaultMuse 本地数据？",
              "此操作会清空模型配置、对话历史、提示词和全部插件设置，且无法撤销。Vault 中的笔记与附件不会被删除。",
              "确认清除",
              "取消",
              true,
            ).wait();
            if (!confirmed) return;
            await this.plugin.resetLocalData();
            new Notice("VaultMuse 本地数据已清除");
            this.display();
          }),
      );

    new Setting(body).setName("上下文上限").setHeading();
    body.createEl("p", {
      cls: "setting-item-description",
      text: "控制每轮读入 Vault 的规模；发送与摘要共用同一套限制。失焦或回车后生效。",
    });

    const limitFields: Array<{ key: keyof typeof DEFAULT_CONTEXT_LIMITS; name: string; desc: string }> = [
      { key: "maxTagsInMessage", name: "消息内标签数", desc: "单条消息最多解析的标签" },
      { key: "maxExpandedPaths", name: "展开路径总数", desc: "标签展开后的最大路径数" },
      { key: "maxFilesPerTag", name: "每标签文件数", desc: "单个标签最多展开的文件" },
      { key: "maxCharsPerFile", name: "单文件字符上限", desc: "每个文件最多读入的字符数" },
      { key: "maxCharsTotal", name: "总字符上限", desc: "本轮新附加的文件正文合计字符上限" },
    ];

    for (const field of limitFields) {
      new Setting(body)
        .setName(field.name)
        .setDesc(field.desc)
        .addText((text) =>
          bindNumberField(text.inputEl, {
            get: () => String(mergeContextLimits(this.plugin.settings.contextLimits)[field.key]),
            parse: (raw) => {
              const n = Number(raw);
              return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
            },
            apply: async (value) => {
              const next = {
                ...(this.plugin.settings.contextLimits ?? {}),
                [field.key]: value,
              };
              this.plugin.settings.contextLimits = mergeContextLimits(next);
              await this.save();
            },
          }),
        );
    }
  }
}

function effortOptionLabel(effort: ReasoningEffort): string {
  if (effort === "default") return "默认（不发送参数）";
  return `${EFFORT_LABELS[effort]}（${effort}）`;
}
