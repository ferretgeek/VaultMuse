# Installation and deployment

## Install the plugin locally

1. Download matching `main.js`, `manifest.json`, and `styles.css` files from [Releases](https://github.com/ferretgeek/VaultMuse/releases).
2. Create `<Vault>/.obsidian/plugins/vault-muse/` and place all three files inside.
3. Restart Obsidian and enable VaultMuse under Community plugins.
4. Add a model profile. Use HTTPS remotely; local Ollama may use `http://127.0.0.1:11434/v1`.

The plugin runs inside desktop Obsidian and is not a web service. Do not expose it as a public server. For portfolio hosting, deploy only the synthetic, no-network demo below.

## Run the demo locally

```bash
npm run demo
```

Open `http://127.0.0.1:4173`. The server binds to loopback only.

## Host the demo on a server

```bash
docker compose up -d --build
```

The container maps to `127.0.0.1:4173` by default; place an HTTPS reverse proxy in front. The demo has no API, accounts, persistence, or network calls.

## Optional development vault

Set `VAULT_MUSE_DEPLOY_DIR` to an existing absolute test-plugin directory before building. Without that explicit variable, builds never copy files into a vault.
