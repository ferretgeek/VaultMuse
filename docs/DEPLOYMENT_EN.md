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

## Upgrade, backup, and restore

Exit Obsidian and create a consistent vault snapshot before upgrading. Keep `data.json`; replace only the matching `main.js`, `manifest.json`, and `styles.css`, then verify the plugin version, profiles, and a synthetic chat. Rollback restores the previous build files and, when a data schema changed, the paired pre-upgrade `data.json`.

Settings and conversations live in `<Vault>/.obsidian/plugins/vault-muse/data.json`; screenshot attachments and confirmed note edits live in the vault. If API-key persistence is enabled, `data.json` contains plaintext secrets, so backups must be encrypted and kept out of untrusted sync/public repositories. Test a full-vault restore on a copy before overwriting newer notes.

## Health, troubleshooting, and uninstall

- A healthy plugin can be enabled, opens its chat view, loads profiles, and never edits a note without confirmation. `npm run check` is a source gate, not a substitute for testing in Obsidian.
- For provider failures, verify the HTTPS/loopback endpoint, model, protocol, and in-memory key; redact prompts, notes, headers, and deployment identifiers before sharing diagnostics.
- Rejected edits usually indicate a forbidden config/trash path, an absolute path, or traversal outside the vault.
- The hosted demo is healthy when its static page and icons load. It has no API, model calls, plugin state, or user data and cannot validate real plugin behavior.
- To uninstall, disable the plugin, exit Obsidian, and remove `.obsidian/plugins/vault-muse/`. This removes settings/history but does not undo confirmed note edits or automatically delete vault attachments.
- Server removal only stops/deletes the synthetic demo. There is no deployable VaultMuse backend, sync service, or AI relay; hosting the demo is not a server edition.
