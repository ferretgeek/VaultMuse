import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

/**
 * Optional development-only deployment target.
 *
 * Builds stay inside the repository unless VAULT_MUSE_DEPLOY_DIR is set
 * explicitly. Never infer a personal vault path: that leaks workstation
 * details and can overwrite an unrelated plugin installation.
 */
const VAULT_PLUGIN_DIR = process.env.VAULT_MUSE_DEPLOY_DIR?.trim();

function deployToVault() {
  if (!VAULT_PLUGIN_DIR) return;
  if (!path.isAbsolute(VAULT_PLUGIN_DIR)) {
    throw new Error("VAULT_MUSE_DEPLOY_DIR must be an absolute path");
  }
  if (!fs.existsSync(path.dirname(VAULT_PLUGIN_DIR))) {
    throw new Error("VAULT_MUSE_DEPLOY_DIR parent directory does not exist");
  }
  fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  for (const file of ["main.js", "styles.css", "manifest.json"]) {
    const from = path.resolve(file);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(VAULT_PLUGIN_DIR, file));
  }
  console.log("[deploy] copied plugin assets to VAULT_MUSE_DEPLOY_DIR");
}

const deployPlugin = {
  name: "deploy-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) deployToVault();
    });
  },
};

const nodeBuiltins = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "punycode",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "vm",
  "zlib",
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...nodeBuiltins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
  plugins: [deployPlugin],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}
