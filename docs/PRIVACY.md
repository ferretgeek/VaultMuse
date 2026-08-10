# Privacy and data flow / 隐私与数据流

## 中文

VaultMuse 在 Obsidian 桌面端本地运行，不提供中转服务器、遥测、分析或远程前端资源。

| 数据 | 去向 | 默认持久化 |
|---|---|---|
| 主动选择的笔记、标签展开、选区、图片与提问 | 你配置的模型接口 | 服务商行为由其政策决定 |
| API Key、自定义 Headers | 目标接口请求 | **否，仅当前会话内存**；可明确选择写入本地 `data.json` |
| 对话、提示词、非敏感设置 | 当前 Vault 的插件 `data.json` | 是，可一键清除 |
| 截图附件 | 当前 Vault | 是；清理时进入 Obsidian 废纸篓 |
| 交互演示内容 | 浏览器当前页面 | 否，不发出网络请求 |

插件不会后台扫描整个 Vault。每轮上下文有文件数、单文件字符数与总字符数上限；本轮实际内容可查看和移除。远程接口只允许 HTTPS，本机回环地址可用 HTTP。模型 Markdown 中的远程资源不会自动加载，外部 URL 只恢复为需点击的链接。上游 JSON、SSE 与网络错误在进入通知与历史前统一归一为安全摘要，不保存原始错误正文。

“在本地保存敏感配置”意味着以明文写入该 Vault 的插件数据；若 Vault 会被云同步或共享，请保持关闭。卸载前可在高级设置执行“清除全部本地数据”。模型服务商仍可能记录你主动发送的内容，请独立审阅其条款。

## English

VaultMuse runs locally inside desktop Obsidian. It has no relay server, telemetry, analytics, or remote frontend assets.

Only explicitly selected notes, expanded tags, selections, images, prompts, and conversation history are sent to the configured model endpoint. API keys and custom headers remain in memory by default; opting into local storage writes them as plaintext to the vault's plugin `data.json`. Conversations and ordinary settings are local and can be cleared in one action. Screenshot attachments use the current vault and recoverable trash.

VaultMuse never indexes the whole vault in the background. Per-turn file and character limits are enforced, remote endpoints require HTTPS, and loopback HTTP remains available for local models. Remote resources in model Markdown never load automatically; external URLs are restored only as click links. Provider JSON, SSE, and network errors are reduced to safe summaries before display or persistence. Your chosen model provider may still retain explicitly sent content under its own policy.
