export type UiTheme = "sky" | "jade" | "sunset" | "graphite";

export const UI_THEME_OPTIONS: Array<{
  id: UiTheme;
  label: string;
  description: string;
}> = [
  { id: "sky", label: "天青", description: "清透的雾蓝浅色" },
  { id: "jade", label: "翡翠", description: "柔和的青绿浅色" },
  { id: "sunset", label: "晚霞", description: "温暖的杏粉浅色" },
  { id: "graphite", label: "深灰", description: "背景 #17191d" },
];

export function normalizeUiTheme(value: unknown): UiTheme {
  return UI_THEME_OPTIONS.some((option) => option.id === value) ? (value as UiTheme) : "sky";
}
