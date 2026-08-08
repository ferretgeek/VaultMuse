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
