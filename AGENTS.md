# Obsidian AI writer — project rules

- Read the workspace root `README.md`, this file, and both project READMEs before changes.
- Preserve the product boundary: desktop Obsidian only; explicit per-turn context; confirm-before-write; recoverable trash; no whole-vault crawling, background indexing, telemetry, remote assets, credential collection, or hidden proxy.
- API keys and custom headers remain memory-only unless the user explicitly opts into local persistence. Never add a default endpoint containing credentials, an inferred personal vault path, or automatic deployment to a user directory.
- Block traversal, absolute paths, `.trash`, the active vault configuration directory, URL credentials, remote plaintext HTTP, and unsafe request headers. Keep request, response, context, and history bounds.
- Maintain Sky, Jade, Sunset, and Graphite themes, top-right theme selection, global persistence, responsive UI, and Graphite background exactly `#17191d`.
- Keep `main.js` out of Git; publish it only as a release asset alongside `manifest.json` and `styles.css`. Obsidian release tags must match the manifest version exactly, without a `v` prefix.
- Use synthetic notes, reserved domains, and placeholder keys in tests, docs, screenshots, and issues. Keep SVG, PNG, and ICO favicons for the browser demo.
- Update Chinese and English documentation together. Any public change also requires checking and synchronizing the workspace root README and profile repository.
- Before release run lint, tests, strict type/build checks, npm audit, Gitleaks tree/history, detect-secrets, release-asset inspection, fresh-clone verification, browser QA at desktop and mobile sizes, Markdown/link/image checks, and online GitHub verification.
