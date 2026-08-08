# Security policy / 安全策略

Security fixes are provided for the latest release on `main`. 最新 `main` 与最新 Release 接收安全修复。

## Report privately / 私下报告

Use GitHub **Private Vulnerability Reporting**. Do not place API keys, custom headers, private endpoints, real note content, vault paths, screenshots, or provider responses in a public issue.

请使用 GitHub **Private Vulnerability Reporting**。不要在公开 Issue 中提交 API Key、自定义 Headers、私人接口、真实笔记、Vault 路径、截图或服务商响应。

Include the affected version, Obsidian version, provider protocol, a minimal reproduction using `example.invalid` and placeholder tokens, and the expected impact. Maintainers never need a working credential.

## Baseline / 基线

- Keep sensitive profile fields memory-only unless local plaintext persistence is explicitly accepted.
- Use HTTPS for remote endpoints; loopback HTTP is allowed for local models.
- Review every context item and diff before sending or applying it.
- Keep Obsidian, Node/Electron, the plugin, and provider SDK-compatible endpoints patched.
- Treat `data.json`, exported chats, screenshots, prompts, and model responses as private.

The complete trust boundary is in [`docs/PRIVACY.md`](./docs/PRIVACY.md).
