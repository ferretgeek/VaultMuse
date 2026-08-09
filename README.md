<div align="center">

# 卷语 / VaultMuse — Obsidian AI 对话与写作

**在笔记与灵感之间，让 AI 成为克制、透明的同行者。**

[![CI](https://github.com/ferretgeek/VaultMuse/actions/workflows/ci.yml/badge.svg)](https://github.com/ferretgeek/VaultMuse/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ferretgeek/VaultMuse/actions/workflows/codeql.yml/badge.svg)](https://github.com/ferretgeek/VaultMuse/actions/workflows/codeql.yml)
[![MIT](https://img.shields.io/badge/license-MIT-3f8268.svg)](./LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.8.7%2B-7c5ce7.svg)](https://obsidian.md/)

[English](./README_EN.md) · [隐私边界](./docs/PRIVACY.md) · [安装与部署](./docs/DEPLOYMENT.md) · [在线演示](https://ferretgeek.github.io/VaultMuse/)

</div>

![VaultMuse 界面预览](./docs/images/dashboard.png)

VaultMuse 是一款桌面端 Obsidian AI 对话插件。它只读取你主动选择的笔记、标签、选区或图片；回答先成为可审阅的提案，经确认后才写回 Vault。

## 一眼看懂

- **上下文透明**：本轮用了什么，逐项可见、可移除；不会扫描整个 Vault。
- **写回有门**：插入、追加、覆盖、新建与多文件 Diff 都需确认，误操作可撤销。
- **接口自由**：支持 OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages 与本地 Ollama。
- **敏感信息克制**：API Key 与自定义 Headers 默认仅驻留内存；远程接口强制 HTTPS；危险 Headers 会被拒绝。
- **完整工作台**：流式回复、思考折叠、图片理解、历史搜索/置顶/导出、斜杠工作流与提示词缓存。
- **四套全局主题**：天青、翡翠、晚霞、深灰；右上角切换并持久保存，深灰背景固定为 `#17191d`。

## 安装

从 [Releases](https://github.com/ferretgeek/VaultMuse/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入：

```text
<你的 Vault>/.obsidian/plugins/vault-muse/
```

重启 Obsidian，在“设置 → 社区插件”中启用 **VaultMuse**。随后添加模型配置；API Key 建议保持“在本地保存敏感配置”关闭。完整步骤见[安装与部署](./docs/DEPLOYMENT.md)。

## 安全边界

- 聊天不会自行修改文件；只有明确确认的动作会写入。
- 路径穿越、绝对路径、`.trash` 与 Vault 配置目录被禁止写入。
- 删除操作进入 Obsidian 废纸篓，不做永久删除。
- 对话与设置保存在当前 Vault 的插件数据中；可在高级设置一键清除。
- 本项目不会代理、托管或隐藏你的模型请求。你选择的接口服务商仍会接收主动发送的内容。

发布前请阅读[隐私与数据流](./docs/PRIVACY.md)和[安全策略](./SECURITY.md)。

## 开发

```bash
npm ci
npm run check
npm run package:release
```

`npm run check` 会依次执行 ESLint、55 个纯逻辑测试、严格类型检查与生产构建。构建默认只生成本地 `main.js`；仅当开发者显式设置 `VAULT_MUSE_DEPLOY_DIR` 时才复制到测试 Vault。

## 来源与许可

VaultMuse 是基于 MIT 项目 `grok-obsidian` 的独立衍生作品，已保留原作者版权与来源说明，详见 [NOTICE](./NOTICE.md)。本项目以 [MIT License](./LICENSE) 发布。
