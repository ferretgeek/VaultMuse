<div align="center">

# Obsidian AI 写作助手

中文 · [English](./README_EN.md)

[![CI](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/codeql.yml/badge.svg)](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/codeql.yml)
[![MIT](https://img.shields.io/badge/license-MIT-3f8268.svg)](./LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.8.7%2B-7c5ce7.svg)](https://obsidian.md/)

[在线演示](https://ferretgeek.github.io/obsidian-ai-writer/) · [隐私边界](./docs/PRIVACY.md) · [安装与部署](./docs/DEPLOYMENT.md)

</div>

![界面预览](./docs/images/dashboard.png)

> 就着你指定的那几篇笔记和 AI 聊。它想改什么，先给你看。

## 为什么会需要它

大部分 AI 笔记插件有两个让人不敢用的地方：

**一是它读了你整个库。** 你只想聊今天这篇会议记录，它把三年的日记、财务表格和私人清单一起当成了上下文。

**二是它直接改了你的文件。** 你说"帮我理一下这段"，回头发现整篇被重写了，而且没有 diff 可看。

这个插件反过来做。

**上下文是你挑的。** 这几篇笔记、这个标签、这段选中的文字、这张图——每一项都列在对话旁边，随时能删掉。**它不会扫描整个 Vault。**

**写回有一道门。** 插入、追加、覆盖、新建、多文件修改，都先给你一份 diff，确认了才落盘。改错了能撤销，删除只进 Obsidian 废纸篓，不做永久删除。

## 它能做什么

- **上下文透明** — 本轮用了什么，逐项可见、可移除。
- **写回有门** — 插入、追加、覆盖、新建与多文件 Diff 都需要确认，误操作可撤销。
- **接口自由** — 支持 OpenAI Responses、任何 OpenAI 兼容的 Chat Completions、Anthropic Messages，以及本地跑的 Ollama。
- **敏感信息克制** — API Key 与自定义 Header 默认仅驻留内存；远程接口强制 HTTPS；危险 Header 会被拒绝。
- **完整工作台** — 流式回复、思考过程折叠、图片理解、历史搜索 / 置顶 / 导出、斜杠工作流与提示词缓存。
- **四套全局主题** — 天青、翡翠、晚霞、深灰；右上角切换并持久保存，深灰背景固定为 `#17191d`。

## 安装

从 [Releases](https://github.com/ferretgeek/obsidian-ai-writer/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进：

```text
<你的 Vault>/.obsidian/plugins/vault-muse/
```

重启 Obsidian，在「设置 → 社区插件」中启用。然后添加模型配置。

> **建议保持"在本地保存敏感配置"关闭**——这样 API Key 只在内存里，Obsidian 重启后重新输入。如果你更看重方便，可以打开，但要清楚这意味着 Key 会写进 Vault 的插件数据。

完整步骤见[安装与部署](./docs/DEPLOYMENT.md)。

## 技术上值得一提的地方

**写入路径是白名单式的。** 路径穿越、绝对路径、`.trash` 和 Vault 配置目录都被禁止写入。一个能被诱导写 `.obsidian/` 的插件，等于能改你的所有配置。

**API Key 与自定义 Header 默认只在内存。** 远程接口强制 HTTPS；能用来做请求走私或权限提升的危险 Header 直接拒绝，而不是原样转发。

**删除只进废纸篓。** 不做永久删除——AI 判断错了一次，代价不该是一篇不可恢复的笔记。

**四种接口协议是分别实现的。** OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages 和 Ollama 各有自己的请求 / 流式解析路径，不是靠一个"兼容层"硬套，所以每家的思考过程、缓存和图片语义都能正确对上。

**`npm run check` 是真门禁。** 依次跑 ESLint、55 个纯逻辑测试、严格类型检查和生产构建。构建默认只生成本地 `main.js`，只有开发者显式设置 `VAULT_MUSE_DEPLOY_DIR` 时才复制到测试 Vault——避免"跑一下测试就把你的真实 Vault 改了"。

## 它不做什么

- 聊天本身不会修改任何文件，只有你明确确认的动作会写入。
- 不扫描整个 Vault。
- **不代理、不托管、不隐藏你的模型请求。** 你选的接口服务商仍然会收到你主动发送的内容——这一点没有任何插件能替你规避，说清楚比含糊更重要。
- 对话与设置保存在当前 Vault 的插件数据里，可在高级设置一键清除。

## 开发

```bash
npm ci
npm run check
npm run package:release
```

## 更多文档

[安装与部署](./docs/DEPLOYMENT.md) · [架构](./docs/ARCHITECTURE.md) · [隐私与数据流](./docs/PRIVACY.md) · [发布审计](./docs/发布审计.md) · [版本变更](./CHANGELOG.md) · [参与开发](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

## 来源与许可

本项目是基于 MIT 项目 `grok-obsidian` 的独立衍生作品，保留原作者版权与来源说明，详见 [NOTICE](./NOTICE.md)。

以 [MIT License](./LICENSE) 发布。与 Obsidian、OpenAI、Anthropic 均无隶属或背书关系。
