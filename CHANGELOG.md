# Changelog

## Unreleased

- Applied the same HTTPS and loopback validation to model discovery before any credential-bearing request.
- Prevented model-authored Markdown from loading remote images or embedded resources automatically; remote URLs are restored only as explicit click links.
- Reduced structured JSON, SSE, and network errors to persistence-safe summaries at the common provider-error boundary.
- Pinned every privileged GitHub Pages action to a reviewed immutable commit.

## 1.0.1 — 2026-08-09

- Reissued the public history after an adversarial scan found a deliberately invalid credential-bearing URL in a rejection test; no real credential was present.
- Retired the immutable `1.0.0` tag and moved the supported release to `1.0.1`, eliminating the scanner-shaped fixture from every reachable commit and tag.
- Includes the release-packaging race fix, security hardening, provider safeguards, UI polish, and updated release assets from the final audit.

## 1.0.0 — 2026-08-09

- Rebuilt the plugin with explicit context, guarded note editing, recoverable deletion, and independent provider profiles.
- Added OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, local endpoints, streaming, reasoning controls, image context, history, and prompt-cache-aware requests.
- Hardened endpoint, header, response, file-path, persistence, and error-redaction boundaries.
- Made API keys and custom headers memory-only by default and added a full local-data reset.
- Added four global themes, a top-right picker, bilingual documentation, an interactive no-network demo, release packaging, CI, CodeQL, and supply-chain checks.
