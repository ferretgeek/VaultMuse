import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "main.js",
    "release-assets",
    "esbuild.config.mjs",
    "versions.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mts",
            "manifest.json",
            "tests/*.mjs",
            "tools/*.mjs",
            "demo/*.js",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    files: ["src/settings.ts", "src/confirmModal.ts"],
    rules: {
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      "@typescript-eslint/no-deprecated": "off",
    },
  },
  {
    files: ["tests/*.mjs"],
    rules: {
      "no-unsanitized/method": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-global-this": "off",
    },
  },
  {
    files: ["tools/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    files: ["demo/*.js"],
    rules: {
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-global-this": "off",
      "no-restricted-globals": "off",
    },
  },
);
