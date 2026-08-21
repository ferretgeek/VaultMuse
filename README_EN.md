<div align="center">

# Obsidian AI writer

[中文](./README.md) · English

[![CI](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/codeql.yml/badge.svg)](https://github.com/ferretgeek/obsidian-ai-writer/actions/workflows/codeql.yml)
[![MIT](https://img.shields.io/badge/license-MIT-3f8268.svg)](./LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.8.7%2B-7c5ce7.svg)](https://obsidian.md/)

[Live demo](https://ferretgeek.github.io/obsidian-ai-writer/) · [Privacy](./docs/PRIVACY.md) · [Installation](./docs/DEPLOYMENT.md)

</div>

![Interface preview](./docs/images/dashboard.png)

> Chat with a model over the notes *you* picked. Whatever it wants to change, you see first.

## Why this exists

Most AI note plugins do two things that make them hard to trust.

**They read your whole vault.** You wanted to talk about today's meeting note, and three years of journals, financial tables, and private lists went along as context.

**They edit your files directly.** You asked it to tidy up a paragraph and came back to a rewritten note with no diff to review.

This plugin inverts both.

**You choose the context.** These notes, this tag, this selection, this image — every item is listed beside the conversation and can be removed at any time. **It never scans the vault.**

**Write-back has a gate.** Insert, append, overwrite, create, and multi-file edits all show a diff first and only land after you confirm. Mistakes are undoable, and deletions go to Obsidian's trash rather than being destroyed.

## What it does

- **Transparent context** — everything used this turn is visible and removable, item by item.
- **Gated write-back** — insert, append, overwrite, create, and multi-file diffs all require confirmation, and mistakes are undoable.
- **Bring your own endpoint** — OpenAI Responses, any OpenAI-compatible Chat Completions API, Anthropic Messages, or a local Ollama.
- **Restrained with secrets** — API keys and custom headers stay in memory by default, remote endpoints are forced to HTTPS, and dangerous headers are rejected.
- **A complete workbench** — streaming replies, collapsible reasoning, image understanding, searchable / pinned / exportable history, slash workflows, and prompt caching.
- **Four global themes** — Azure, Emerald, Sunset, and deep gray, switchable from the top right and persisted, with the dark background fixed at `#17191d`.

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/ferretgeek/obsidian-ai-writer/releases) into:

```text
<your vault>/.obsidian/plugins/vault-muse/
```

Restart Obsidian and enable the plugin under Settings → Community plugins, then add a model configuration.

> **Leave "store sensitive settings locally" off** if you can — that keeps API keys in memory only, re-entered after an Obsidian restart. Turning it on is a reasonable convenience trade, as long as you know it means the key is written into the vault's plugin data.

Full steps in [installation and deployment](./docs/DEPLOYMENT.md).

## Worth noting technically

**Write paths are allowlisted.** Path traversal, absolute paths, `.trash`, and the vault config directory are all blocked. A plugin that can be talked into writing to `.obsidian/` can rewrite every setting you have.

**API keys and custom headers stay in memory by default.** Remote endpoints are forced to HTTPS, and headers usable for request smuggling or privilege escalation are rejected rather than forwarded verbatim.

**Deletions only go to trash.** Nothing is permanently destroyed — the cost of one bad model call shouldn't be an unrecoverable note.

**The four protocols are implemented separately.** OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, and Ollama each have their own request and stream-parsing paths rather than being forced through one "compatibility layer," so each provider's reasoning, caching, and image semantics map correctly.

**`npm run check` is a real gate.** It runs ESLint, 55 pure-logic tests, strict type checking, and a production build in sequence. The build emits a local `main.js` only; it copies into a test vault solely when the developer explicitly sets `VAULT_MUSE_DEPLOY_DIR` — so running the tests never touches your real vault.

## What it doesn't do

- Chatting alone never modifies a file; only actions you confirm are written.
- It doesn't scan the vault.
- **It doesn't proxy, host, or hide your model requests.** Whichever provider you choose still receives whatever you deliberately send — no plugin can change that, and saying so plainly matters more than being vague about it.
- Conversations and settings live in the current vault's plugin data and can be cleared in one action from advanced settings.

## Development

```bash
npm ci
npm run check
npm run package:release
```

## More documentation

[Installation and deployment](./docs/DEPLOYMENT_EN.md) · [Architecture](./docs/ARCHITECTURE.md) · [Privacy and data flow](./docs/PRIVACY.md) · [Release audit](./docs/发布审计.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## Provenance and license

This is an independent derivative of the MIT-licensed `grok-obsidian`, retaining the original author's copyright and attribution — see [NOTICE](./NOTICE.md).

Released under the [MIT License](./LICENSE). No affiliation with or endorsement by Obsidian, OpenAI, or Anthropic.
