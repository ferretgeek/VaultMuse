# 安装与部署

## 安装插件（本地）

1. 从 [Releases](https://github.com/ferretgeek/VaultMuse/releases) 下载同一版本的 `main.js`、`manifest.json`、`styles.css`。
2. 新建 `<Vault>/.obsidian/plugins/vault-muse/`，放入这三个文件。
3. 重启 Obsidian，在“设置 → 社区插件”启用 VaultMuse。
4. 在 VaultMuse 设置添加模型。远程接口使用 HTTPS；本地 Ollama 可用 `http://127.0.0.1:11434/v1`。

插件运行于桌面 Obsidian，不是 Web 服务，因此无需也不应部署到公网服务器。若希望在服务器展示界面，只部署下面的**无网络、合成数据演示页**。

## 运行演示页（本地）

```bash
npm run demo
```

浏览器打开 `http://127.0.0.1:4173`。服务仅绑定回环地址。

## 部署演示页（服务器）

```bash
docker compose up -d --build
```

默认映射 `127.0.0.1:4173`，请通过 HTTPS 反向代理访问。演示页无接口、无账号、无持久数据且不联网。生产环境建议直接托管 `demo/` 静态文件，保留仓库提供的 CSP 与安全响应头。

## 开发者测试 Vault（显式可选）

```powershell
$env:VAULT_MUSE_DEPLOY_DIR = 'D:\path\to\test-vault\.obsidian\plugins\vault-muse'
npm run build
```

没有这个变量时，构建绝不会复制到 Vault。变量必须是绝对路径且父目录已存在。

## 升级、备份与恢复

升级前退出 Obsidian，并用你现有的 Vault 备份工具创建一致快照。保留 `data.json`，只替换同一版本的 `main.js`、`manifest.json`、`styles.css`，再启动 Obsidian 核对插件版本、模型配置和一段合成对话。回滚时退出 Obsidian，恢复上一组构建文件；若新版本改变了数据结构，应连同升级前的 `data.json` 一起恢复。

插件设置与对话位于 `<Vault>/.obsidian/plugins/vault-muse/data.json`，截图附件和已确认写入的笔记位于 Vault 自身。若开启“保存 API Key”，`data.json` 会包含明文秘密，备份必须加密且不得公开或同步到不可信位置。恢复整个 Vault 前先在副本中验证，避免覆盖更新的笔记。

## 健康检查、排错与卸载

- 插件健康：Obsidian 能启用插件、打开对话视图、加载模型配置，并在未确认时不写入笔记；`npm run check` 是源码门禁，不替代实际 Obsidian 检查。
- 模型请求失败：核对 HTTPS/本机回环端点、模型名、Provider 协议和当前会话 Key；公开诊断前删除提示词、笔记内容、Headers 和错误中的部署标识。
- 写入提案失败：确认目标是 Vault 内允许的相对路径，且不是 `.obsidian`、`.trash` 或越界路径。
- 演示页健康：静态首页和图标返回成功即可；它没有 API、模型请求、插件状态或用户数据，不能用于验证真实插件功能。
- 卸载：先在 Obsidian 禁用插件并退出，再删除 `.obsidian/plugins/vault-muse/`。这会删除 `data.json` 中的对话/设置，但不会回滚已确认写入的笔记或自动删除 Vault 附件；按备份决定另行处理。
- 服务器只需停止并删除合成演示页/容器。不存在可部署的 VaultMuse 服务端、同步端或 AI 中继；把演示页上线不等于服务器版产品。
