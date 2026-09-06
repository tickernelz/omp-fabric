type DiffBackgroundIntensity = "off" | "subtle" | "medium";
type DiffWordEmphasis = "all" | "smart" | "off";
type ToolCallBackgroundMode = "on" | "border" | "off";
type PathIconMode = "unicode" | "nerd" | "off";
type CodePreviewToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export interface CodePreviewSettings {
  // Shiki theme preference: "auto" follows OMP's resolved light/dark variant,
  // "<light>/<dark>" pins both variants, and any other value is a fixed theme id.
  shikiTheme: string;
  diffIntensity: DiffBackgroundIntensity;
  wordEmphasis: DiffWordEmphasis;
  toolCallBackground: ToolCallBackgroundMode;
  toolCallTiming: boolean;
  readCollapsedLines: number;
  readContentPreview: boolean;
  writeContentPreview: boolean;
  writeCollapsedLines: number;
  editDiffPreview: boolean;
  editCollapsedLines: number | "all";
  grepCollapsedLines: number;
  grepResultPreview: boolean;
  findResultPreview: boolean;
  lsResultPreview: boolean;
  pathListCollapsedLines: number;
  readLineNumbers: boolean;
  bashResultPreview: boolean;
  bashWarnings: boolean;
  syntaxHighlighting: boolean;
  secretWarnings: boolean;
  pathIcons: PathIconMode;
  tools: CodePreviewToolName[];
}

export type ShikiThemeVariant = "light" | "dark";

const AUTO_SHIKI_THEME = "auto";
const DEFAULT_LIGHT_SHIKI_THEME = "github-light";
const DEFAULT_DARK_SHIKI_THEME = "dark-plus";

/**
 * Parse a shiki theme preference into per-variant theme ids. "auto" resolves to
 * the built-in pair and tracks OMP's resolved variant at render time; a
 * "<light>/<dark>" pair fixes both variants explicitly; anything else is a
 * single variant-independent theme id.
 */
export const parseShikiThemePreference = (
  preference: string,
): { lightTheme: string; darkTheme: string; followsVariant: boolean } => {
  const trimmed = preference.trim();
  if (!trimmed || trimmed === AUTO_SHIKI_THEME) {
    return {
      lightTheme: DEFAULT_LIGHT_SHIKI_THEME,
      darkTheme: DEFAULT_DARK_SHIKI_THEME,
      followsVariant: true,
    };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const lightTheme = trimmed.slice(0, slash).trim();
    const darkTheme = trimmed.slice(slash + 1).trim();
    if (lightTheme && darkTheme) {
      return { lightTheme, darkTheme, followsVariant: true };
    }
  }
  return { lightTheme: trimmed, darkTheme: trimmed, followsVariant: false };
};

/** Resolve the effective shiki theme id for a preference and variant. */
export const resolveShikiTheme = (
  preference: string,
  variant: ShikiThemeVariant,
): string => {
  const parsed = parseShikiThemePreference(preference);
  return variant === "light" ? parsed.lightTheme : parsed.darkTheme;
};

const TOOLS: CodePreviewToolName[] = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const booleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name]?.toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
};
const positiveEnv = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const optionEnv = <T extends string>(name: string, options: readonly T[], fallback: T): T => {
  const value = process.env[name] as T | undefined;
  return value && options.includes(value) ? value : fallback;
};

/** Environment-backed defaults; fabric.json "codePreview" layers override these. */
export const defaultCodePreviewSettings = (): CodePreviewSettings => ({
  shikiTheme: process.env.CODE_PREVIEW_THEME || AUTO_SHIKI_THEME,
  diffIntensity: optionEnv("CODE_PREVIEW_DIFF_INTENSITY", ["off", "subtle", "medium"], "subtle"),
  wordEmphasis: optionEnv("CODE_PREVIEW_WORD_EMPHASIS", ["all", "smart", "off"], "all"),
  toolCallBackground: optionEnv("CODE_PREVIEW_TOOL_CALL_BACKGROUND", ["on", "border", "off"], "on"),
  toolCallTiming: booleanEnv("CODE_PREVIEW_TOOL_CALL_TIMING", true),
  readCollapsedLines: positiveEnv("CODE_PREVIEW_READ_LINES", 10),
  readContentPreview: booleanEnv("CODE_PREVIEW_READ_CONTENT", true),
  writeContentPreview: booleanEnv("CODE_PREVIEW_WRITE_CONTENT", true),
  writeCollapsedLines: positiveEnv("CODE_PREVIEW_WRITE_LINES", 10),
  editDiffPreview: booleanEnv("CODE_PREVIEW_EDIT_DIFF", true),
  editCollapsedLines: process.env.CODE_PREVIEW_EDIT_LINES === "all" ? "all" : positiveEnv("CODE_PREVIEW_EDIT_LINES", 160),
  grepCollapsedLines: positiveEnv("CODE_PREVIEW_GREP_LINES", 15),
  grepResultPreview: booleanEnv("CODE_PREVIEW_GREP_RESULTS", true),
  findResultPreview: booleanEnv("CODE_PREVIEW_FIND_RESULTS", true),
  lsResultPreview: booleanEnv("CODE_PREVIEW_LS_RESULTS", true),
  pathListCollapsedLines: positiveEnv("CODE_PREVIEW_PATH_LIST_LINES", 20),
  readLineNumbers: booleanEnv("CODE_PREVIEW_READ_LINE_NUMBERS", true),
  bashResultPreview: booleanEnv("CODE_PREVIEW_BASH_RESULTS", true),
  bashWarnings: booleanEnv("CODE_PREVIEW_BASH_WARNINGS", true),
  syntaxHighlighting: booleanEnv("CODE_PREVIEW_SYNTAX", true),
  secretWarnings: booleanEnv("CODE_PREVIEW_SECRET_WARNINGS", true),
  pathIcons: optionEnv("CODE_PREVIEW_PATH_ICONS", ["unicode", "nerd", "off"], "unicode"),
  tools: [...TOOLS],
});

/**
 * Validate a fabric.json "codePreview" section on top of the environment-backed
 * defaults. Unknown or mistyped values are ignored.
 */
export const normalizeCodePreviewSettings = (raw: unknown): CodePreviewSettings => {
  const settings = defaultCodePreviewSettings();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return settings;
  const source = raw as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(settings) as [keyof CodePreviewSettings, unknown][]) {
    const value = source[key];
    if (typeof fallback === "boolean" && typeof value === "boolean") {
      (settings as unknown as Record<string, unknown>)[key] = value;
    } else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      (settings as unknown as Record<string, unknown>)[key] = Math.floor(value);
    } else if (key === "editCollapsedLines" && value === "all") settings.editCollapsedLines = "all";
    else if (key === "tools" && Array.isArray(value)) settings.tools = value.filter((tool): tool is CodePreviewToolName => typeof tool === "string" && TOOLS.includes(tool as CodePreviewToolName));
    else if (key === "diffIntensity" && ["off", "subtle", "medium"].includes(String(value))) {
      settings.diffIntensity = value as DiffBackgroundIntensity;
    } else if (key === "wordEmphasis" && ["all", "smart", "off"].includes(String(value))) {
      settings.wordEmphasis = value as DiffWordEmphasis;
    } else if (key === "toolCallBackground" && ["on", "border", "off"].includes(String(value))) {
      settings.toolCallBackground = value as ToolCallBackgroundMode;
    } else if (key === "pathIcons" && ["unicode", "nerd", "off"].includes(String(value))) {
      settings.pathIcons = value as PathIconMode;
    } else if (key === "shikiTheme" && typeof value === "string" && value) {
      settings.shikiTheme = value;
    }
  }
  return { ...settings, tools: [...new Set(settings.tools)] };
};
