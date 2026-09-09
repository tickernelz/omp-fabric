import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { DynamicBorder } from "./dynamic-border.js";
import {
  Container,
  type Component,
  Input,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@oh-my-pi/pi-tui";
import { ompSymbolTheme } from "./symbol-theme.js";
import { FabricModelSelector } from "./fabric-model-selector.js";
import {
  buildClaudeModelSource,
  buildModelSource,
  INHERIT_VALUE,
  modelKey,
  type ModelSource,
} from "./model-picker.js";
import {
  clampCompactionRatioThreshold,
  clampCompactionTokenThreshold,
  loadFabricConfigForScope,
  MAX_COMPACTION_RATIO_THRESHOLD,
  MAX_COMPACTION_TOKEN_THRESHOLD,
  maxExecutorMemoryLimitBytes,
  MIN_COMPACTION_RATIO_THRESHOLD,
  MIN_COMPACTION_TOKEN_THRESHOLD,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  saveFabricConfig,
  type FabricConfig,
  type FabricConfigScope,
} from "../config.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricState } from "../fabric-state.js";
import { resolveAgentDir } from "../core/agent-dir.js";

const SUBMENU_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

const BOOLEANS = ["true", "false"] as const;
const APPROVAL_MODES = ["allow", "ask", "auto", "deny"] as const;
const RUNNERS = ["omp", "claude", "veda"] as const;
const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
const WIDGET_MODES = ["auto", "always", "hidden"] as const;
const TOOL_DISPLAY_MODES = ["full", "compact"] as const;
const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const EXECUTOR_RUNTIMES = ["quickjs", "node-process", "bun-process"] as const;
const SCHEMA_MODES = ["off", "audit", "enforce"] as const;
const COMPACTION_ENGINES = ["lcm", "omp"] as const;
const COMPACTION_THRESHOLD_SETTING_ID = "compaction.threshold";
const COMPACTION_DEFAULT_THRESHOLD_LABEL = "OMP default";
const COMPACTION_PERCENT_OPTION_LABEL = "Custom percent…";
const COMPACTION_TOKENS_OPTION_LABEL = "Custom tokens…";
const COMPACTION_PERCENT_MIN = Math.round(MIN_COMPACTION_RATIO_THRESHOLD * 100);
const COMPACTION_PERCENT_MAX = Math.round(MAX_COMPACTION_RATIO_THRESHOLD * 100);
const clampCompactionPercentThreshold = (value: number): number =>
  Math.round(clampCompactionRatioThreshold(value / 100) * 100);
const COMPACTION_TARGET_RATIOS = Array.from(
  { length: 13 },
  (_, index) => String((25 + index * 5) / 100),
);
const ACTOR_SCOPES = ["project", "session"] as const;
const DIFF_INTENSITIES = ["off", "subtle", "medium"] as const;
const WORD_EMPHASES = ["all", "smart", "off"] as const;
const TOOL_CALL_BACKGROUNDS = ["on", "border", "off"] as const;
const PATH_ICON_MODES = ["unicode", "nerd", "off"] as const;
const CODE_PREVIEW_EDIT_LINES_ID = "codePreview.editCollapsedLines";
const CODE_PREVIEW_ALL_LINES = "All lines";
const SHIKI_THEME_PRESETS = [
  "auto",
  "github-light/github-dark",
  "light-plus/dark-plus",
  "solarized-light/solarized-dark",
  "catppuccin-latte/catppuccin-mocha",
  "github-light",
  "light-plus",
  "solarized-light",
  "dark-plus",
  "github-dark",
  "solarized-dark",
  "nord",
  "one-dark-pro",
] as const;
const RISKS = ["read", "write", "execute", "network", "agent"] as const;
const CORE_RISK_TOOLS = ["read", "grep", "find", "edit", "write", "bash"] as const;
const CORE_DEFAULT_TOOL_CANDIDATES = ["read", "bash", "edit", "write", "grep", "find"];
const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
const PREWALK_MODEL_UNSET_LABEL = "Ask each time";
const PREWALK_THINKING_INHERIT_LABEL = "Agents default";
const PREWALK_MODES = ["in-place", "trajectory"] as const;
const ROOT_ITEM_IDS = [
  "fullCodeMode",
  "executor",
  "schema",
  "approvals",
  "mcp",
  "prewalk",
  "agents",
  "capture",
  "ui",
  "compaction",
  "retention",
  "mesh",
  "codePreview",
] as const;
const RELOAD_SECTIONS = new Set(["mesh", "agents", "mcp", "retention"]);
const SAVE_SCOPE_SHORTCUT = Key.ctrl("g");

const unique = (values: readonly string[]): string[] => [...new Set(values)];

type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => Component;

const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg("accent", text) : text),
  value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
  description: (text) => theme.fg("dim", text),
  cursor: theme.fg("accent", "→ "),
  hint: (text) => theme.fg("dim", text),
});

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
  symbols: ompSymbolTheme,
});

const formatDebounce = (ms: number): string =>
  ms === 0 ? "Off" : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;

const formatMs = (ms: number): string =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
      : ms < 3_600_000
        ? `${ms / 60_000}m`
        : `${ms / 3_600_000}h`;

const formatRetention = (ms: number): string =>
  ms >= 24 * 60 * 60 * 1_000 && ms % (24 * 60 * 60 * 1_000) === 0
    ? `${ms / (24 * 60 * 60 * 1_000)}d`
    : formatMs(ms);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`
    : bytes >= 1024 * 1024
      ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
      : `${Number((bytes / 1024).toFixed(2))} KB`;

export const executorMemoryLimitOptions = (
  maximumBytes = QUICKJS_MAX_MEMORY_LIMIT_BYTES,
): number[] => {
  const minimumBytes = 16 * 1024 * 1024;
  const values: number[] = [];
  for (let value = minimumBytes; value <= maximumBytes; value *= 2) values.push(value);
  if (maximumBytes >= minimumBytes && values.at(-1) !== maximumBytes) values.push(maximumBytes);
  return values;
};

const formatUsd = (value: number): string =>
  value <= 0 ? "Off" : `$${value.toFixed(2)}`;

const formatTokens = (value: number): string =>
  value <= 0
    ? "Off"
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}k`
        : String(value);

const formatToolCount = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

// The threshold row is a mode selection: OMP default, a window-occupancy
// percent, or an exact token count. mode: "default" clears both maps so OMP's
// built-in threshold applies.
export type CompactionThresholdSelection =
  | { mode: "default" }
  | { mode: "percent"; value: number }
  | { mode: "tokens"; value: number };

const formatCompactionThreshold = (
  config: FabricConfig,
  modelKey: string,
): string => {
  const tokens = config.compaction.tokenThresholds[modelKey];
  if (tokens !== undefined) return `${formatTokens(tokens)} tokens`;
  const ratio = config.compaction.thresholds[modelKey];
  return ratio === undefined
    ? COMPACTION_DEFAULT_THRESHOLD_LABEL
    : `${Math.round(ratio * 100)}%`;
};

export const compactionThresholdPartial = (
  modelKey: string,
  selection: CompactionThresholdSelection,
): Record<string, unknown> => ({
  compaction: {
    thresholds: { [modelKey]: selection.mode === "percent" ? selection.value : null },
    tokenThresholds: { [modelKey]: selection.mode === "tokens" ? selection.value : null },
  },
});

const numericOptions = (
  values: readonly number[],
  format: (value: number) => string,
  currentValue: string,
): SelectItem[] => {
  const options: SelectItem[] = values.map((value) => ({
    value: String(value),
    label: format(value),
  }));
  if (!options.some((option) => option.value === currentValue || option.label === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return options;
};

const getPath = (config: FabricConfig, id: string): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const parseBudgetValue = (value: string): number => {
  if (value === "Off") return 0;
  const digits = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(digits) ? digits : 0;
};

export const parseFormattedNumericValue = (value: string): number => {
  const normalized = value.trim();
  if (normalized === "Off") return 0;
  if (normalized.startsWith("$")) return parseBudgetValue(normalized);

  const bytes = normalized.match(/^([0-9]+(?:\.[0-9]+)?) (KB|MB|GB)$/);
  if (bytes) {
    const amount = Number(bytes[1]);
    const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
    return Math.round(amount * units[bytes[2] as keyof typeof units]);
  }

  const duration = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return Math.round(amount * units[duration[2] as keyof typeof units]);
  }

  const tokens = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(k|M)$/);
  if (tokens) return Math.round(Number(tokens[1]) * (tokens[2] === "M" ? 1_000_000 : 1_000));
  return Number(normalized.replaceAll(",", ""));
};

const coerceValue = (id: string, value: string, config: FabricConfig): unknown => {
  if (id === COMPACTION_THRESHOLD_SETTING_ID) {
    if (value === COMPACTION_DEFAULT_THRESHOLD_LABEL) return { mode: "default" };
    const tokens = /^(.+?) tokens$/.exec(value);
    if (tokens?.[1] !== undefined) {
      return {
        mode: "tokens",
        value: clampCompactionTokenThreshold(parseFormattedNumericValue(tokens[1])),
      };
    }
    return { mode: "percent", value: Number(value.replace("%", "")) / 100 };
  }
  if (id === CODE_PREVIEW_EDIT_LINES_ID) {
    if (value === CODE_PREVIEW_ALL_LINES || value === "all") return "all";
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const current = getPath(config, id);
    return typeof current === "number" ? current : 160;
  }
  const current = getPath(config, id);
  // prewalk.enabled is enabled by default and omitted from normalized
  // configs unless false, so its control still needs an explicit boolean type.
  if (typeof current === "boolean" || id === "prewalk.enabled") return value === "true";
  if (typeof current === "number") return parseFormattedNumericValue(value);
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeFabricConfig drops it.
  // Agents inherit; prewalk asks interactively when it is armed.
  if (
    id === "approvals.model" ||
    id === "prewalk.model" ||
    id === "agents.model" ||
    id === "agents.claude.model" ||
    id === "agents.veda.model" ||
    id === "compaction.summaryModel"
  ) {
    return value === INHERIT_VALUE || value === PREWALK_MODEL_UNSET_LABEL ? "" : value;
  }
  if (id === "prewalk.thinking" && value === PREWALK_THINKING_INHERIT_LABEL) return "";
  if (id === "agents.thinking" || id === "prewalk.thinking") {
    return THINKING_LEVELS.find((level) => thinkingLabel(level) === value) ?? value;
  }
  return value;
};

const buildPartial = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) break;
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

const summaryFor = (id: string, config: FabricConfig): string => {
  switch (id) {
    case "fullCodeMode":
      return config.fullCodeMode ? "true" : "false";
    case "executor": {
      const refFloors = Object.keys(config.executor.hostCallTimeouts).length;
      return `${config.executor.runtime} · ${formatMs(config.executor.timeoutMs)} · max ${formatMs(config.executor.maxTimeoutMs)}${refFloors > 0 ? ` · ${refFloors} ref floor${refFloors === 1 ? "" : "s"}` : ""}`;
    }
    case "schema":
      return config.schema.mode;
    case "approvals":
      return config.approvals.execute;
    case "mcp":
      return config.mcp.enabled ? "enabled" : "disabled";
    case "prewalk":
      return `${config.prewalk.enabled === false ? "off · " : ""}${config.prewalk.mode} · ${config.prewalk.model || PREWALK_MODEL_UNSET_LABEL}${config.prewalk.thinking ? ` · ${thinkingLabel(config.prewalk.thinking)}` : ""}${config.prewalk.alwaysRearm ? " · repeat" : ""}`;
    case "codemap":
      return config.codemap.enabled
        ? `${config.codemap.defaultMaxTokens} tok · ${formatMs(config.codemap.maxMs)}`
        : "disabled";
    case "agents":
      return `${config.agents.runner}/${config.agents.transport}`;
    case "capture":
      return config.capture.enabled ? "enabled" : "disabled";
    case "ui":
      return config.ui.widget;
    case "compaction":
      return config.compaction.engine;
    case "retention":
      return `${formatRetention(config.retention.orphanedTempRunMs)} · ${formatRetention(config.retention.oneShotRunMs)} · ${formatRetention(config.retention.actorRunArchiveMs)}`;
    case "mesh":
      return config.mesh.enabled ? "enabled" : "disabled";
    case "codePreview":
      return config.codePreview.shikiTheme;
    default:
      return "";
  }
};

const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: {
    description?: string;
    values?: readonly string[];
    submenu?: SettingsSubmenu;
  } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue };
  if (rest.description !== undefined) item.description = rest.description;
  if (rest.values !== undefined) item.values = [...rest.values];
  if (rest.submenu !== undefined) item.submenu = rest.submenu;
  return item;
};

const numericSubmenu = (
  theme: Theme,
  values: readonly number[],
  format: (value: number) => string,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = numericOptions(values, format, currentValue);
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)?.value ??
    currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

const nonNegativeIntegerSubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new IntegerInputSubmenu(theme, title, description, currentValue, done, () => done());

const stringInputSubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new StringInputSubmenu(theme, title, description, currentValue, done, () => done());

const compactionThresholdSubmenu = (theme: Theme): SettingsSubmenu => (currentValue, done) =>
  new CompactionThresholdSubmenu(theme, currentValue, done);

const stringOptionsSubmenu = (
  theme: Theme,
  values: readonly string[],
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = values.map((value) => ({ value, label: value }));
  if (!options.some((option) => option.value === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)
      ?.value ?? currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(value),
    () => done(),
  );
};

const listSubmenu = (
  theme: Theme,
  id: string,
  title: string,
  description: string,
  candidates: readonly string[],
  currentList: readonly string[],
  onCommit: (selected: string[]) => void,
): SettingsSubmenu => {
  const prefix = `${id}.`;
  return (_currentValue, done) => {
    const items = unique([...candidates, ...currentList]).map((name) =>
      setting(`${id}.${name}`, name, currentList.includes(name) ? "true" : "false", {
        description: `Toggle ${name}.`,
        values: BOOLEANS,
      }),
    );
    const onChange = (_itemId: string, _newValue: string): void => {
      const selected = items
        .filter((item) => item.currentValue === "true")
        .map((item) => item.id.slice(prefix.length));
      onCommit(selected);
    };
    return new SectionSubmenu(theme, title, description, items, onChange, () => done(), true);
  };
};

// Append a › to the label of every item that opens a submenu, so it is
// obvious which rows drill in (vs. inline value cycling). Mutates in place to
// preserve the shared item references that listSubmenu updates live.
const markDrillIn = (items: SettingItem[]): SettingItem[] => {
  for (const item of items) {
    if (item.submenu && !item.label.endsWith("›")) item.label = `${item.label} ›`;
  }
  return items;
};

const sectionSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  items: SettingItem[],
  persist: (id: string, value: string) => void,
): SettingsSubmenu => (_currentValue, done) =>
  // Match the root page: sections get type-to-search filtering too.
  new SectionSubmenu(theme, title, description, markDrillIn(items), persist, () => done(), true);

class IntegerInputSubmenu extends Container {
  readonly input: Input;
  private readonly validationText: Text;

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", description), 0, 0));
    this.addChild(new Spacer(1));

    this.input = new Input();
    this.input.handleInput(currentValue);
    this.input.focused = true;
    this.validationText = new Text("", 0, 0);
    this.input.onSubmit = (value) => {
      const normalized = value.trim();
      const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        this.validationText.setText(
          theme.fg("error", "Enter a non-negative safe integer."),
        );
        return;
      }
      onSelect(String(parsed));
    };
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(this.validationText);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.validationText.setText("");
    this.input.handleInput(data);
  }

  render(width: number): readonly string[] {
    this.input.focused = true;
    return super.render(width);
  }

  submitRpc(value: string): void {
    this.input.setValue(value);
    this.input.handleInput("\r");
  }
}

class StringInputSubmenu extends Container {
  readonly input: Input;

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", description), 0, 0));
    this.addChild(new Spacer(1));

    this.input = new Input();
    this.input.handleInput(currentValue);
    this.input.focused = true;
    this.input.onSubmit = (value) => onSelect(value.trim());
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): readonly string[] {
    this.input.focused = true;
    return super.render(width);
  }

  submitRpc(value: string): void {
    this.input.setValue(value);
    this.input.handleInput("\r");
  }
}

class SelectSubmenu extends Container {
  readonly selectList: SelectList;
  readonly options: SelectItem[];

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.options = options;
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SUBMENU_LAYOUT,
    );
    const index = options.findIndex((option) => option.value === currentValue);
    if (index !== -1) this.selectList.setSelectedIndex(index);
    this.selectList.onSelect = (item) => onSelect(item.value);
    this.selectList.onCancel = onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }

  selectRpc(value: string): boolean {
    const option = this.options.find((candidate) => candidate.value === value);
    if (!option) return false;
    this.selectList.onSelect?.(option);
    return true;
  }
}

// Three-phase threshold picker: the root select offers OMP default plus
// custom percent / token drill-ins; each drill-in swaps in an integer input
// and Esc returns to the root select instead of closing the submenu.
class CompactionThresholdSubmenu extends Container {
  selectList: SelectList | undefined;
  input: Input | undefined;
  private active!: Container & { handleInput(data: string): void };

  constructor(
    private readonly theme: Theme,
    private readonly currentValue: string,
    private readonly done: (selectedValue?: string) => void,
  ) {
    super();
    this.showSelect();
  }

  private swap(next: Container & { handleInput(data: string): void }): void {
    this.clear();
    this.addChild(next);
    this.active = next;
  }

  private showSelect(): void {
    const options: SelectItem[] = [
      { value: COMPACTION_DEFAULT_THRESHOLD_LABEL, label: COMPACTION_DEFAULT_THRESHOLD_LABEL },
      { value: COMPACTION_PERCENT_OPTION_LABEL, label: COMPACTION_PERCENT_OPTION_LABEL },
      { value: COMPACTION_TOKENS_OPTION_LABEL, label: COMPACTION_TOKENS_OPTION_LABEL },
    ];
    const select = new SelectSubmenu(
      this.theme,
      "Compaction threshold",
      "Percent of the context window that triggers compaction, or an exact token count, entered via the custom options.",
      options,
      this.currentValue,
      (value) => {
        if (value === COMPACTION_PERCENT_OPTION_LABEL) this.showPercent();
        else if (value === COMPACTION_TOKENS_OPTION_LABEL) this.showTokens();
        else this.done(value);
      },
      () => this.done(),
    );
    this.selectList = select.selectList;
    this.input = undefined;
    this.swap(select);
  }

  private showPercent(): void {
    const percent = /^(\d+)%$/.exec(this.currentValue);
    const inputSubmenu = new IntegerInputSubmenu(
      this.theme,
      "Compaction percent threshold",
      `Compaction triggers once context usage reaches this percent of its window (${COMPACTION_PERCENT_MIN}–${COMPACTION_PERCENT_MAX}).`,
      percent?.[1] ?? "",
      (value) => this.done(`${clampCompactionPercentThreshold(Number(value))}%`),
      () => this.showSelect(),
    );
    this.selectList = undefined;
    this.input = inputSubmenu.input;
    this.swap(inputSubmenu);
  }

  private showTokens(): void {
    const tokens = /^(.+?) tokens$/.exec(this.currentValue);
    const prefilled = tokens?.[1] === undefined
      ? ""
      : String(parseFormattedNumericValue(tokens[1]));
    const inputSubmenu = new IntegerInputSubmenu(
      this.theme,
      "Compaction token threshold",
      `Compaction triggers once context usage reaches this many tokens (${MIN_COMPACTION_TOKEN_THRESHOLD}–${MAX_COMPACTION_TOKEN_THRESHOLD}).`,
      prefilled,
      (value) => this.done(`${formatTokens(clampCompactionTokenThreshold(Number(value)))} tokens`),
      () => this.showSelect(),
    );
    this.selectList = undefined;
    this.input = inputSubmenu.input;
    this.swap(inputSubmenu);
  }

  handleInput(data: string): void {
    this.active.handleInput(data);
  }

  completeRpc(selectedValue: string): void {
    this.done(selectedValue);
  }
}

const thinkingSubmenu = (
  theme: Theme,
  overrides: {
    title?: string;
    description?: string;
    // Label of an extra first option that clears the override (persists "").
    inheritLabel?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    THINKING_LEVELS.find((level) => thinkingLabel(level) === currentValue) ?? currentValue;
  const options: SelectItem[] = THINKING_LEVELS.map((level) => ({
    value: level,
    label: thinkingLabel(level),
  }));
  if (overrides.inheritLabel) {
    options.unshift({ value: overrides.inheritLabel, label: overrides.inheritLabel });
  }
  if (!options.some((option) => option.value === canonicalCurrent)) {
    options.unshift({ value: canonicalCurrent, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    overrides.title ?? "Default thinking",
    overrides.description ??
      "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. The level is clamped to each model's supported levels (next highest if unsupported).",
    options,
    canonicalCurrent,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

const modelPickerSubmenu = (
  theme: Theme,
  source: ModelSource,
  options: {
    headerText?: string;
    inheritLabel?: string;
    inheritName?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    options.inheritLabel && currentValue === options.inheritLabel
      ? INHERIT_VALUE
      : currentValue;
  return new FabricModelSelector({
    theme,
    source,
    currentValue: canonicalCurrent,
    onSelect: (value) =>
      done(
        value === INHERIT_VALUE && options.inheritLabel
          ? options.inheritLabel
          : value,
      ),
    onCancel: () => done(),
    ...(options.headerText ? { headerText: options.headerText } : {}),
    ...(options.inheritLabel ? { inheritLabel: options.inheritLabel } : {}),
    ...(options.inheritName ? { inheritName: options.inheritName } : {}),
  });
};

class SectionSubmenu extends Container {
  readonly settingsList: SettingsList;
  readonly items: SettingItem[];
  readonly applyChange: (id: string, newValue: string) => void;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    enableSearch = false,
  ) {
    super();
    this.items = items;
    this.applyChange = onChange;
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, 16),
      settingsListTheme(theme),
      onChange,
      onCancel,
      { typeToSearch: enableSearch },
    );
    this.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export interface FabricSettingsComponentOptions {
  initialSaveScope?: FabricConfigScope;
  projectScopeAvailable?: boolean;
  onSaveScopeChange?: (scope: FabricConfigScope) => void;
  itemsForSaveScope?: (scope: FabricConfigScope) => SettingItem[];
}

export class FabricSettingsComponent extends Container {
  settingsList: SettingsList;
  private readonly theme: Theme;
  private readonly saveScopeText: Text;
  private readonly settingsListContainer: Container;
  private readonly projectScopeAvailable: boolean;
  private readonly onChange: (id: string, newValue: string) => void;
  private readonly onCancel: () => void;
  private readonly onSaveScopeChange: (scope: FabricConfigScope) => void;
  private readonly itemsForSaveScope: ((scope: FabricConfigScope) => SettingItem[]) | undefined;
  private saveScope: FabricConfigScope;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options: FabricSettingsComponentOptions = {},
  ) {
    super();
    this.theme = theme;
    this.projectScopeAvailable = options.projectScopeAvailable ?? true;
    this.saveScope = options.initialSaveScope === "project" && this.projectScopeAvailable
      ? "project"
      : "global";
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.onSaveScopeChange = options.onSaveScopeChange ?? (() => {});
    this.itemsForSaveScope = options.itemsForSaveScope;
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.saveScopeText = new Text("", 1, 0);
    this.updateSaveScopeText();
    this.addChild(this.saveScopeText);
    this.addChild(new Spacer(1));
    this.settingsListContainer = new Container();
    this.settingsList = this.createSettingsList(items);
    this.settingsListContainer.addChild(this.settingsList);
    this.addChild(this.settingsListContainer);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, SAVE_SCOPE_SHORTCUT)) {
      if (!this.projectScopeAvailable) return;
      this.saveScope = this.saveScope === "project" ? "global" : "project";
      this.updateSaveScopeText();
      this.onSaveScopeChange(this.saveScope);
      const nextItems = this.itemsForSaveScope?.(this.saveScope);
      if (nextItems) {
        this.settingsListContainer.clear();
        this.settingsList = this.createSettingsList(nextItems);
        this.settingsListContainer.addChild(this.settingsList);
      }
      return;
    }
    this.settingsList.handleInput(data);
  }

  private createSettingsList(items: SettingItem[]): SettingsList {
    return new SettingsList(
      items,
      10,
      settingsListTheme(this.theme),
      this.onChange,
      this.onCancel,
      { typeToSearch: true },
    );
  }

  private updateSaveScopeText(): void {
    const destination = this.saveScope === "project"
      ? "Project overrides (.omp/fabric.json)"
      : "Global defaults (<active OMP agent dir>/fabric.json)";
    const hint = !this.projectScopeAvailable
      ? " · project scope unavailable for untrusted projects"
      : this.saveScope === "global"
        ? " · Ctrl+G switches scope · project overrides may remain active here"
        : " · Ctrl+G switches scope";
    this.saveScopeText.setText(
      this.theme.fg("muted", "Editing: ") +
      this.theme.fg("accent", destination) +
      this.theme.fg("dim", hint),
    );
  }
}

export const populateClaudeModelSource = async (
  source: ModelSource,
  load: () => Promise<Parameters<typeof buildClaudeModelSource>[0]>,
): Promise<void> => {
  const loaded = buildClaudeModelSource(await load());
  source.models.splice(0, source.models.length, ...loaded.models);
  source.lastUsed = loaded.lastUsed;
};

export const buildFabricSettingsItems = (
  theme: Theme,
  config: FabricConfig,
  apply: (id: string, value: unknown) => void,
  options: {
    keepVisibleCandidates: readonly string[];
    toolCandidates?: readonly string[];
    modelSource: ModelSource;
    claudeModelSource?: ModelSource;
    activeModelKey?: string;
  },
): SettingItem[] => {
  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, config));
  const envFullCode = process.env.OMP_FABRIC_FULL_CODE_MODE;
  const fullCodeDescription = envFullCode
    ? "Fabric owns OMP core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Currently overridden by the OMP_FABRIC_FULL_CODE_MODE environment variable."
    : "Fabric owns OMP core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Disable to keep native tools model-facing (orchestration-only mode).";
  const executorMemoryDescription = (): string =>
    config.executor.runtime === "quickjs"
      ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
      : config.executor.runtime === "bun-process"
        ? "Heap target for the disposable Bun process. Bun ignores V8 heap flags, so this limit is not enforced."
        : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";

  const defaultToolsItem = setting(
    "agents.defaultTools",
    "Default tools",
    formatToolCount(config.agents.defaultTools.length),
    { description: "OMP core tools exposed to spawned agents by default." },
  );
  defaultToolsItem.submenu = listSubmenu(
    theme,
    "agents.defaultTools",
    "Default tools",
    "OMP core tools exposed to spawned agents by default.",
    CORE_DEFAULT_TOOL_CANDIDATES,
    config.agents.defaultTools,
    (selected) => {
      apply("agents.defaultTools", selected);
      defaultToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  const keepVisibleItem = setting(
    "capture.keepVisible",
    "Keep visible",
    formatToolCount(config.capture.keepVisible.length),
    { description: "Captured tool names that stay model-visible despite hideFromModel." },
  );
  keepVisibleItem.submenu = listSubmenu(
    theme,
    "capture.keepVisible",
    "Keep visible",
    "Captured tool names that stay model-visible despite hideFromModel.",
    options.keepVisibleCandidates,
    config.capture.keepVisible,
    (selected) => {
      apply("capture.keepVisible", selected);
      keepVisibleItem.currentValue = formatToolCount(selected.length);
    },
  );
  const includeToolsItem = setting(
    "capture.includeTools",
    "Include tools",
    formatToolCount(config.capture.includeTools.length),
    { description: "Explicitly keep registered tools visible; unavailable names are ignored." },
  );
  includeToolsItem.submenu = listSubmenu(
    theme,
    "capture.includeTools",
    "Include tools",
    "Explicit include overrides capture hiding. Explicit excludes still win.",
    options.toolCandidates ?? [],
    config.capture.includeTools,
    (selected) => {
      apply("capture.includeTools", selected);
      includeToolsItem.currentValue = formatToolCount(selected.length);
    },
  );
  const excludeToolsItem = setting(
    "capture.excludeTools",
    "Exclude tools",
    formatToolCount(config.capture.excludeTools.length),
    { description: "Hide selected registered tools from the model; excludes win over includes." },
  );
  excludeToolsItem.submenu = listSubmenu(
    theme,
    "capture.excludeTools",
    "Exclude tools",
    "Explicit exclude wins when a tool appears in both lists.",
    options.toolCandidates ?? [],
    config.capture.excludeTools,
    (selected) => {
      apply("capture.excludeTools", selected);
      excludeToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  const items = [
    setting("fullCodeMode", "Full code mode", config.fullCodeMode ? "true" : "false", {
      description: fullCodeDescription,
      values: BOOLEANS,
    }),
    setting("executor", "Executor", summaryFor("executor", config), {
      description: "Runtime and resource limits for fabric_exec programs.",
      submenu: sectionSubmenu(
        theme,
        "Executor",
        "Runtime and resource limits for fabric_exec programs.",
        [
          setting("executor.runtime", "Runtime", config.executor.runtime, {
            description:
              config.schema.mode === "enforce"
                ? "Schema enforce mode requires the isolated QuickJS runtime."
                : "QuickJS is isolated and limited by WASM32. Node/Bun processes support larger heaps but are an unsafe trusted-code escape hatch, not a security sandbox.",
            values: config.schema.mode === "enforce" ? ["quickjs"] : EXECUTOR_RUNTIMES,
          }),
          setting("executor.timeoutMs", "Timeout", formatMs(config.executor.timeoutMs), {
            description: `Default wall-clock time for a single fabric_exec program. A per-invocation timeoutMs or a matching executor.hostCallTimeouts ref can raise it up to the ${formatMs(config.executor.maxTimeoutMs)} policy maximum.`,
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
              formatMs,
              "Executor timeout",
              `Default wall-clock time for a single fabric_exec program (policy max ${formatMs(config.executor.maxTimeoutMs)}).`,
            ),
          }),
          setting(
            "executor.maxTimeoutMs",
            "Policy max",
            formatMs(config.executor.maxTimeoutMs),
            {
              description:
                "Ceiling for every executor deadline: per-invocation timeoutMs requests and executor.hostCallTimeouts ref floors are capped at this value. Values above it are normalized on load.",
              submenu: numericSubmenu(
                theme,
                [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
                formatMs,
                "Executor policy maximum",
                "Ceiling for every executor deadline, including per-invocation requests and per-ref floors.",
              ),
            },
          ),
          setting(
            "executor.hostCallTimeouts",
            "Per-ref floors",
            Object.keys(config.executor.hostCallTimeouts).length > 0
              ? Object.keys(config.executor.hostCallTimeouts)
                  .map((ref) => `${ref}=${formatMs(config.executor.hostCallTimeouts[ref] ?? 0)}`)
                  .join(", ")
              : "none",
            {
              description:
                "Exact-ref deadline floors for known long-running host calls (configured in the Fabric config file), e.g. \"extensions.subagent\": 3600000.",
            },
          ),
          setting(
            "executor.memoryLimitBytes",
            "Memory limit",
            formatBytes(config.executor.memoryLimitBytes),
            {
              description: executorMemoryDescription(),
              submenu: (currentValue, done) =>
                numericSubmenu(
                  theme,
                  executorMemoryLimitOptions(maxExecutorMemoryLimitBytes(config.executor.runtime)),
                  formatBytes,
                  "Executor memory limit",
                  executorMemoryDescription(),
                )(currentValue, done),
            },
          ),
          setting("executor.maxOutputChars", "Max output chars", config.executor.maxOutputChars.toLocaleString(), {
            description: "Character cap applied to the final fabric_exec return value shown to the model.",
            submenu: numericSubmenu(
              theme,
              [20_000, 50_000, 100_000, 200_000, 500_000],
              (n) => n.toLocaleString(),
              "Max output chars",
              "Character cap applied to the final fabric_exec return value shown to the model.",
            ),
          }),
          setting("executor.resultFormat", "Result format", config.executor.resultFormat, {
            description:
              "Default formatting for fabric_exec return values. Auto renders structured values as syntax-highlighted YAML; each call can override this.",
            values: RESULT_FORMATS,
          }),
          setting(
            "executor.maxNestedResultChars",
            "Max nested result chars",
            config.executor.maxNestedResultChars.toLocaleString(),
            {
              description: "Character cap applied to results returned by nested tool calls inside the sandbox.",
              submenu: numericSubmenu(
                theme,
                [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
                (n) => n.toLocaleString(),
                "Max nested result chars",
                "Character cap applied to results returned by nested tool calls inside the sandbox.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("schema", "Schema", summaryFor("schema", config), {
      description: "Typed evidence loop and local-file transaction channel. Enforcement is locked per session; mode changes take effect in the next session.",
      submenu: sectionSubmenu(
        theme,
        "Schema",
        "Typed evidence loop and local-file transaction channel. In enforce mode, protected-workspace mutations require schema.hypothesize → schema.verify → schema.commit inside one fabric_exec call.",
        [
          setting("schema.mode", "Mode", config.schema.mode, {
            description:
              "off (default) leaves the control plane ungated. audit records would_block events for actions enforce would deny. enforce admits only the schema transaction channel for protected-workspace changes and forces the QuickJS runtime. Takes effect in the next session.",
            values: SCHEMA_MODES,
          }),
          setting("schema.certificateTtlMs", "Certificate TTL", formatMs(config.schema.certificateTtlMs), {
            description: "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
            submenu: numericSubmenu(
              theme,
              [1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
              formatMs,
              "Certificate TTL",
              "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
            ),
          }),
          setting("schema.maxFiles", "Max files", String(config.schema.maxFiles), {
            description: "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
            submenu: numericSubmenu(
              theme,
              [1, 5, 10, 25, 50, 100, 250, 500, 1000],
              (n) => String(n),
              "Max files",
              "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
            ),
          }),
          setting("schema.maxBytes", "Max bytes", formatBytes(config.schema.maxBytes), {
            description: "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
            submenu: numericSubmenu(
              theme,
              [1_048_576, 5_242_880, 10_485_760, 52_428_800, 104_857_600],
              formatBytes,
              "Max bytes",
              "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("approvals", "Approvals", summaryFor("approvals", config), {
      description: "Per-action approval policy for Fabric and model-requested native tool calls.",
      submenu: sectionSubmenu(
        theme,
        "Approvals",
        "Approval policy for Fabric and model-requested native tool calls. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
        [
          setting("approvals.model", "Auto model", config.approvals.model || INHERIT_VALUE, {
            description:
              "OMP model used as the auto-mode safety classifier. Inherit uses the active session model. The classifier has no executable tools and returns a structured allow-or-escalate verdict.",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
              {
                headerText:
                  "Safety classifier for auto approval policies. Pick Inherit to use the active OMP session model.",
                inheritName: "Use the active OMP session model",
              },
            ),
          }),
          setting("approvals.read", "Read", config.approvals.read, {
            description: "Approval policy for read operations. Read is normally safe to leave allowed.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.write", "Write", config.approvals.write, {
            description: "Approval policy for write and edit operations. Auto classifies each call.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.execute", "Execute", config.approvals.execute, {
            description: "Approval policy for shell execution. Auto classifies each command.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.network", "Network", config.approvals.network, {
            description: "Approval policy for network operations. Auto classifies each destination and payload.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.agent", "Agent", config.approvals.agent, {
            description: "Approval policy for agent and actor operations. Auto classifies each request.",
            values: APPROVAL_MODES,
          }),
        ],
        persist,
      ),
    }),
    setting("mcp", "MCP", summaryFor("mcp", config), {
      description: "Model Context Protocol provider discovery and invocation.",
      submenu: sectionSubmenu(
        theme,
        "MCP",
        "Model Context Protocol provider discovery and invocation.",
        [
          setting("mcp.enabled", "Enabled", config.mcp.enabled ? "true" : "false", {
            description: "Enable the MCP provider inside fabric_exec.",
            values: BOOLEANS,
          }),
          setting("mcp.disableOAuth", "Disable OAuth", config.mcp.disableOAuth ? "true" : "false", {
            description: "Skip MCP OAuth flows.",
            values: BOOLEANS,
          }),
          setting("mcp.allowDynamicServers", "Dynamic servers", config.mcp.allowDynamicServers ? "true" : "false", {
            description: "Allow servers to be added at runtime via the MCP protocol.",
            values: BOOLEANS,
          }),
          setting("mcp.callTimeoutMs", "Call timeout", formatMs(config.mcp.callTimeoutMs), {
            description: "Timeout for individual MCP tool calls.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP call timeout",
              "Timeout for individual MCP tool calls.",
            ),
          }),
          setting("mcp.cache.enabled", "Descriptor cache", config.mcp.cache.enabled ? "true" : "false", {
            description: "Cache MCP tool metadata across sessions keyed by mcporter config; discovery no longer spawns every server.",
            values: BOOLEANS,
          }),
          setting("mcp.cache.revalidate", "Revalidate on start", config.mcp.cache.revalidate, {
            description: "Background re-listing at session start: changed servers only, all servers, or off.",
            values: ["changed", "all", "off"],
          }),
          setting("mcp.cache.revalidateBudgetMs", "Revalidate budget", formatMs(config.mcp.cache.revalidateBudgetMs), {
            description: "Wall-clock budget for the session-start background MCP revalidation.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP revalidate budget",
              "Wall-clock budget for the session-start background MCP revalidation.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("prewalk", "Prewalk", summaryFor("prewalk", config), {
      description: "Continue Main in place or opt into a child trajectory handoff at the completed fabric_exec boundary.",
      submenu: sectionSubmenu(
        theme,
        "Prewalk",
        "Automatic continuation at the completed outer fabric_exec boundary.",
        [
          setting("prewalk.enabled", "Enabled", config.prewalk.enabled === false ? "false" : "true", {
            description:
              "Master switch for prewalk. When off, manual arming, session auto-arm, and boundary claims are all inert until re-enabled. Same effect as /fabric prewalk --disable and --enable; a live arm is cancelled on disable.",
            values: BOOLEANS,
          }),
          setting("prewalk.mode", "Mode", config.prewalk.mode, {
            description:
              "In-place temporarily switches Main to the executor, queues a hidden continuation, then returns to Main's previous model. Trajectory moves the session snapshot to a visible child executor, then queues a hidden verify-and-summarize continuation for Main when it finishes.",
            values: PREWALK_MODES,
          }),
          setting(
            "prewalk.alwaysRearm",
            "Always re-arm",
            config.prewalk.alwaysRearm ? "true" : "false",
            {
              description:
                "Arm prewalk automatically at every session start and again after each completed handoff until /fabric prewalk --off cancels it for the session. Auto-arm needs prewalk.model (provider/model). Read-only turns never disarm prewalk.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.detectShellWrites",
            "Detect shell writes",
            config.prewalk.detectShellWrites ? "true" : "false",
            {
              description:
                "Filesystem fallback trigger: when an armed task ran a successful omp.bash in fabric_exec without an audited omp.edit / omp.write / schema.commit, claim the handoff if file stats drifted from baseline, so shell heredocs, sed -i, or formatter-binary writes also reach the executor.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.compactOnReturn",
            "Compact on return",
            config.prewalk.compactOnReturn ? "true" : "false",
            {
              description:
                "After an in-place continuation settles, compact the session with the configured compaction engine just before Main's boundary model is restored, so Main re-ingests a compacted transcript rather than the executor's full scratch work.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.handoffRetirement",
            "Retire planning reads",
            config.prewalk.handoffRetirement ? "true" : "false",
            {
              description:
                "Once the executor handoff is live, replace the planner's stale successful read / grep / find / ls results with a compact marker naming the tool and target, so the executor does not re-ingest exploration it will not use. Failed results, mutating tools, user messages, and the most recent reads are never retired.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.handoffRetirementKeep",
            "Keep recent reads",
            String(config.prewalk.handoffRetirementKeep),
            {
              description:
                "How many of the most recent read-only results stay untouched when retiring, so the executor still sees what the planner just looked at.",
              submenu: nonNegativeIntegerSubmenu(
                theme,
                "Keep recent reads",
                "Most-recent read-only results never retired. Enter any integer from 0 to 64.",
              ),
            },
          ),
          setting(
            "prewalk.thinking",
            "Thinking",
            config.prewalk.thinking
              ? thinkingLabel(config.prewalk.thinking)
              : PREWALK_THINKING_INHERIT_LABEL,
            {
              description:
                "Reasoning effort for the trajectory child executor. Agents default inherits Agents › Default thinking; in-place keeps Main's session level. The level is clamped to each model's supported levels.",
              submenu: thinkingSubmenu(theme, {
                title: "Prewalk thinking",
                description:
                  "Reasoning effort for the trajectory child executor. Agents default uses the Agents section's Default thinking; in-place keeps Main's session level. Clamped to each model's supported levels (next highest if unsupported).",
                inheritLabel: PREWALK_THINKING_INHERIT_LABEL,
              }),
            },
          ),
          setting(
            "prewalk.model",
            "Executor model",
            config.prewalk.model || PREWALK_MODEL_UNSET_LABEL,
            {
              description:
                "OMP provider/model used by /fabric prewalk. In-place selects it for Main; trajectory uses it for the child executor. Ask each time is interactive only.",
              submenu: modelPickerSubmenu(
                theme,
                options.modelSource,
                {
                  headerText:
                    "Executor model for automatic /fabric prewalk continuation. Pick Ask each time to open the model picker for every prewalk.",
                  inheritLabel: PREWALK_MODEL_UNSET_LABEL,
                  inheritName: "Open the model picker whenever prewalk is armed",
                },
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("codemap", "Code map", summaryFor("codemap", config), {
      description: "Structural repo map and git co-change ranking under an explicit token budget.",
      submenu: sectionSubmenu(
        theme,
        "Code map",
        "Symbol index and co-change ranking exposed to fabric_exec as codemap.*.",
        [
          setting("codemap.enabled", "Enabled", config.codemap.enabled ? "true" : "false", {
            description:
              "Expose codemap.map and codemap.cascade inside fabric_exec. The index is built with the host's native ast-grep binding and cached per workspace root.",
            values: BOOLEANS,
          }),
          setting(
            "codemap.defaultMaxTokens",
            "Default budget",
            String(config.codemap.defaultMaxTokens),
            {
              description:
                "Token ceiling applied to codemap.map when the call does not pass maxTokens. The map is ranked before the budget is spent, so a small ceiling still returns the most relevant files.",
              submenu: nonNegativeIntegerSubmenu(
                theme,
                "Code map budget",
                "Token ceiling for codemap.map when a call omits maxTokens. Enter any integer from 200 to 200000.",
              ),
            },
          ),
          setting("codemap.maxFiles", "Max files", String(config.codemap.maxFiles), {
            description: "Upper bound on files enumerated for one index build.",
            submenu: nonNegativeIntegerSubmenu(
              theme,
              "Code map file ceiling",
              "Files enumerated for one index build. Enter any integer from 1 to 1000000.",
            ),
          }),
          setting("codemap.maxSymbols", "Max symbols", String(config.codemap.maxSymbols), {
            description: "Upper bound on symbols retained for one index build.",
            submenu: nonNegativeIntegerSubmenu(
              theme,
              "Code map symbol ceiling",
              "Symbols retained for one index build. Enter any integer from 1 to 5000000.",
            ),
          }),
          setting("codemap.maxMs", "Time budget", formatMs(config.codemap.maxMs), {
            description:
              "Wall-clock ceiling for one index build. A session directory that is not a project can otherwise crawl for minutes; when the budget bites the map returns what it has with truncated set.",
            submenu: nonNegativeIntegerSubmenu(
              theme,
              "Code map time budget",
              "Milliseconds allowed for one index build. Enter any integer from 1000 to 600000.",
            ),
          }),
          setting(
            "codemap.cascadeCommits",
            "Cascade history",
            String(config.codemap.cascadeCommits),
            {
              description:
                "How many recent commits codemap.cascade scans when ranking co-change. Merge commits and bulk commits are excluded so vendored or generated sweeps do not create false affinity.",
              submenu: nonNegativeIntegerSubmenu(
                theme,
                "Cascade history",
                "Commits scanned when ranking co-change. Enter any integer from 10 to 20000.",
              ),
            },
          ),
          setting("codemap.cascadeLimit", "Cascade results", String(config.codemap.cascadeLimit), {
            description: "Maximum related files returned by codemap.cascade.",
            submenu: nonNegativeIntegerSubmenu(
              theme,
              "Cascade results",
              "Related files returned by codemap.cascade. Enter any integer from 1 to 200.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("agents", "Agents", summaryFor("agents", config), {
      description: "One-shot child agents spawned from inside fabric_exec.",
      submenu: sectionSubmenu(
        theme,
        "Agents",
        "One-shot child agents spawned from inside fabric_exec.",
        [
          setting("agents.enabled", "Enabled", config.agents.enabled ? "true" : "false", {
            description: "Enable agent spawning via workflow.agent() and agents.run().",
            values: BOOLEANS,
          }),
          setting("agents.runner", "Default runner", config.agents.runner, {
            description: "Execution harness used when agents.run/create does not specify runner.",
            values: RUNNERS,
          }),
          setting("agents.transport", "Transport", config.agents.transport, {
            description: "Preferred transport for spawned agents.",
            values: TRANSPORTS,
          }),
          setting("agents.model", "Default model", config.agents.model || INHERIT_VALUE, {
            description:
              "Model forwarded to OMP-backed agents and actors when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
            ),
          }),
          setting(
            "agents.claude.model",
            "Claude model",
            config.agents.claude.model || INHERIT_VALUE,
            {
              description:
                "Claude Code model used by Claude-backed agents and actors. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
              submenu: modelPickerSubmenu(
                theme,
                options.claudeModelSource ?? { models: [], lastUsed: {} },
                {
                  headerText:
                    "Default model for Claude-backed Fabric agents and actors. Pick Inherit to use Claude Code's runtime default.",
                  inheritName: "Use Claude Code's runtime default model",
                },
              ),
            },
          ),
          setting("agents.veda.backend", "Veda backend", config.agents.veda.backend, {
            description:
              "External backend driven by the Veda CLI: agy, codex, claude-code, droid, pi, or a backend registered by the installed Veda build.",
            submenu: stringInputSubmenu(
              theme,
              "Veda backend",
              "External CLI backend the Veda runner drives for agent runs.",
            ),
          }),
          setting("agents.veda.persona", "Veda persona", config.agents.veda.persona, {
            description:
              "Veda persona: navigator-plan, navigator-chat, reviewer, worker, or a custom persona under ~/.config/veda/personas/<name>/AGENTS.md.",
            submenu: stringInputSubmenu(
              theme,
              "Veda persona",
              "Persona controlling the Veda agent's behavior. Leave as navigator-chat for the default.",
            ),
          }),
          setting("agents.veda.model", "Veda model", config.agents.veda.model || INHERIT_VALUE, {
            description:
              "Default model forwarded to the Veda backend when a call does not specify one. Leave empty for the backend default.",
            submenu: stringInputSubmenu(
              theme,
              "Veda model",
              "Model or alias forwarded to the Veda backend. Empty uses the backend default.",
            ),
          }),
          setting("agents.thinking", "Default thinking", thinkingLabel(config.agents.thinking), {
            description:
              "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
            submenu: thinkingSubmenu(theme),
          }),
          setting("agents.maxConcurrent", "Max concurrent", String(config.agents.maxConcurrent), {
            description: "Maximum number of agents that may run at the same time.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 4, 8, 16, 32],
              String,
              "Agent concurrency",
              "Maximum number of agents that may run at the same time.",
            ),
          }),
          setting("agents.maxPerExecution", "Max per execution", String(config.agents.maxPerExecution), {
            description: "Maximum number of agent calls allowed within a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [10, 25, 50, 100, 200, 500],
              String,
              "Agents per execution",
              "Maximum number of agent calls allowed within a single fabric_exec program.",
            ),
          }),
          setting("agents.maxDepth", "Max depth", String(config.agents.maxDepth), {
            description:
              "Maximum nesting depth for child agent calls. Enter any non-negative integer; 0 disables child spawning.",
            submenu: nonNegativeIntegerSubmenu(
              theme,
              "Agent depth",
              "Maximum nesting depth for child agent calls. Enter any non-negative integer; 0 disables child spawning.",
            ),
          }),
          setting("agents.budgetUsd", "Recursion budget", formatUsd(config.agents.budgetUsd), {
            description:
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            submenu: numericSubmenu(
              theme,
              BUDGET_VALUES,
              formatUsd,
              "Recursion budget",
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            ),
          }),
          setting("agents.sessionExport", "Usage export", config.agents.sessionExport ? "true" : "false", {
            description:
              "Write usage-only OMP-format session files (tokens/cost, never transcript content) for every agent run so tokscale and ccusage can track Fabric subagents.",
            values: BOOLEANS,
          }),
          setting("agents.sessionExportDir", "Usage export dir", config.agents.sessionExportDir || "<active OMP agent dir> (co-hosted, hidden .fabric namespace)", {
            description:
              "Root of the export store; sessions land under <dir>/sessions/.fabric/. Default reuses OMP's own agent dir (tokscale/ccusage count it with zero setup; OMP's resume picker never sees the hidden namespace). OMP_FABRIC_AGENT_DIR overrides.",
            submenu: stringInputSubmenu(
              theme,
              "Usage export dir",
              "Root of the export store; OMP_FABRIC_AGENT_DIR overrides this value.",
            ),
          }),
          setting("agents.maxTokensPerChild", "Token limit", formatTokens(config.agents.maxTokensPerChild), {
            description:
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
            submenu: numericSubmenu(
              theme,
              TOKEN_VALUES,
              formatTokens,
              "Agent token limit",
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables).",
            ),
          }),
          setting("agents.timeoutMs", "Timeout", formatMs(config.agents.timeoutMs), {
            description: "Default wall-clock timeout and minimum for per-call agent timeouts.",
            submenu: numericSubmenu(
              theme,
              [
                60_000,
                120_000,
                300_000,
                600_000,
                1_800_000,
                3_600_000,
                7_200_000,
                14_400_000,
                28_800_000,
                86_400_000,
              ],
              formatMs,
              "Agent timeout",
              "Default wall-clock timeout and minimum for per-call agent timeouts.",
            ),
          }),
          setting("agents.extensions", "Extensions", config.agents.extensions ? "true" : "false", {
            description: "Allow agents to load registered extensions.",
            values: BOOLEANS,
          }),
          defaultToolsItem,
          setting("agents.retainRuns", "Retain runs", config.agents.retainRuns ? "true" : "false", {
            description: "Keep completed agent run artifacts for later inspection.",
            values: BOOLEANS,
          }),
          setting("agents.notifyOnComplete", "Notify on complete", config.agents.notifyOnComplete ? "true" : "false", {
            description: "Post a message when a background agent completes.",
            values: BOOLEANS,
          }),
        ],
        persist,
      ),
    }),
    setting("capture", "Capture", summaryFor("capture", config), {
      description: "Registered tool capture and model visibility policy.",
      submenu: sectionSubmenu(
        theme,
        "Capture",
        "Registered tool capture and model visibility policy.",
        [
          setting("capture.enabled", "Enabled", config.capture.enabled ? "true" : "false", {
            description: "Capture registered extension tools so they are callable from fabric_exec.",
            values: BOOLEANS,
          }),
          setting("capture.hideFromModel", "Hide from model", config.capture.hideFromModel ? "true" : "false", {
            description: "Hide captured tools from the parent model's tool schema.",
            values: BOOLEANS,
          }),
          setting("capture.defaultRisk", "Default risk", config.capture.defaultRisk, {
            description: "Approval risk level applied to registered tools without an explicit override.",
            values: RISKS,
          }),
          keepVisibleItem,
          ...CORE_RISK_TOOLS.map((tool) =>
            setting(`capture.risks.${tool}`, `${tool} risk`, config.capture.risks[tool] ?? config.capture.defaultRisk, {
              description: `Approval risk level for the ${tool} tool on native and captured paths.`,
              values: RISKS,
            }),
          ),
          includeToolsItem,
          excludeToolsItem,
        ],
        persist,
      ),
    }),
    setting("ui", "UI", summaryFor("ui", config), {
      description: "Fabric activity widget and dashboard.",
      submenu: sectionSubmenu(
        theme,
        "UI",
        "Fabric activity widget and dashboard.",
        [
          setting("ui.enabled", "Enabled", config.ui.enabled ? "true" : "false", {
            description: "Show the Fabric activity widget and dashboard.",
            values: BOOLEANS,
          }),
          setting("ui.widget", "Widget", config.ui.widget, {
            description: "When to show the activity widget above the editor.",
            values: WIDGET_MODES,
          }),
          setting("ui.toolDisplay", "Tool display", config.ui.toolDisplay, {
            description:
              "Show full Fabric TypeScript or a compact intent-and-tools transcript; the tool-expand key (ctrl+o) expands a compact card to full.",
            values: TOOL_DISPLAY_MODES,
          }),
          setting(
            "ui.showAgentToolPreview",
            "Agent tool preview",
            config.ui.showAgentToolPreview ? "true" : "false",
            {
              description:
                "Show spawned agent/actor tool trees — including recursive descendants — in Fabric tool-call previews.",
              values: BOOLEANS,
            },
          ),
          setting(
            "ui.updateDebounceMs",
            "Update debounce",
            formatDebounce(config.ui.updateDebounceMs),
            {
              description: "One global coalescing window for live card updates — nested calls, progress, agent previews.",
              submenu: numericSubmenu(
                theme,
                [0, 16, 50, 100, 150, 250, 500, 1000],
                formatDebounce,
                "Update debounce",
                "One global coalescing window for live card updates — nested calls, progress, agent previews. Off emits every update.",
              ),
            },
          ),
          setting("ui.maxRows", "Max rows", String(config.ui.maxRows), {
            description: "Maximum rows rendered by the activity widget.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 3, 5, 6, 8, 10, 15, 20],
              String,
              "Widget max rows",
              "Maximum rows rendered by the activity widget.",
            ),
          }),
          setting("ui.refreshMs", "Refresh interval", formatMs(config.ui.refreshMs), {
            description: "Refresh interval for the activity widget.",
            submenu: numericSubmenu(
              theme,
              [100, 250, 500, 1000, 2000],
              formatMs,
              "Widget refresh interval",
              "Refresh interval for the activity widget.",
            ),
          }),
          setting("ui.eventHistory", "Event history", String(config.ui.eventHistory), {
            description: "Number of mesh events kept in the dashboard history.",
            submenu: numericSubmenu(
              theme,
              [20, 40, 80, 120, 200, 500],
              String,
              "Event history",
              "Number of mesh events kept in the dashboard history.",
            ),
          }),
          setting("update.check", "Update notice", config.update.check ? "true" : "false", {
            description:
              "Show a status line when a newer omp-fabric is published on npm. One npm registry request per day, cached under the agent dir.",
            values: BOOLEANS,
          }),
        ],
        persist,
      ),
    }),
    setting("compaction", "Compaction", summaryFor("compaction", config), {
      description: "Compaction engine used at session compaction boundaries.",
      submenu: sectionSubmenu(
        theme,
        "Compaction",
        "Choose LCM context compaction or OMP core model-driven compaction.",
        [
          ...(options.activeModelKey
            ? [setting(
                COMPACTION_THRESHOLD_SETTING_ID,
                "Threshold",
                formatCompactionThreshold(config, options.activeModelKey),
                {
                  description:
                    `Context usage that triggers compaction for ${options.activeModelKey}, as a percent of its window or an exact token count.`,
                  submenu: compactionThresholdSubmenu(theme),
                },
              )]
            : []),
          setting("compaction.engine", "Engine", config.compaction.engine, {
            description:
              "LCM assembles durable hierarchical context; OMP delegates compaction to OMP core.",
            values: COMPACTION_ENGINES,
          }),
          setting(
            "compaction.summaryModel",
            "Summary model",
            config.compaction.summaryModel || INHERIT_VALUE,
            {
              description:
                "Model that writes LCM leaf and condensed summaries. Inherit uses the active session model, so a reasoning model summarizes transcripts at its own price.",
              submenu: modelPickerSubmenu(theme, options.modelSource, {
                headerText:
                  "Model that writes LCM leaf and condensed summaries. Pick Inherit to use the active session model.",
                inheritName: "Use the active session model",
              }),
            },
          ),
          setting(
            "compaction.targetContextRatio",
            "Max occupancy",
            String(config.compaction.targetContextRatio),
            {
              description:
                "Hard post-compaction occupancy ceiling used by LCM context assembly.",
              values: COMPACTION_TARGET_RATIOS,
            },
          ),
        ],
        persist,
      ),
    }),
    setting("retention", "Retention", summaryFor("retention", config), {
      description: "Age-based cleanup for inactive Fabric run artifacts.",
      submenu: sectionSubmenu(
        theme,
        "Retention",
        "Cleanup only removes dead temporary roots and terminal run artifacts. Active runs and actor session.jsonl files are never modified.",
        [
          setting(
            "retention.orphanedTempRunMs",
            "Orphaned temp runs",
            formatRetention(config.retention.orphanedTempRunMs),
            {
              description: "Remove temporary run roots this long after their owner process dies.",
              submenu: numericSubmenu(
                theme,
                [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000],
                formatRetention,
                "Orphaned temp runs",
                "Remove temporary run roots this long after their owner process dies.",
              ),
            },
          ),
          setting(
            "retention.oneShotRunMs",
            "One-shot runs",
            formatRetention(config.retention.oneShotRunMs),
            {
              description: "Retain completed one-shot agent run artifacts for this duration.",
              submenu: numericSubmenu(
                theme,
                [6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 86_400_000, 3 * 86_400_000, 7 * 86_400_000],
                formatRetention,
                "One-shot runs",
                "Retain completed one-shot agent run artifacts for this duration.",
              ),
            },
          ),
          setting(
            "retention.actorRunArchiveMs",
            "Actor run archives",
            formatRetention(config.retention.actorRunArchiveMs),
            {
              description: "Retain terminal actor run archives for this duration; the latest run is always preserved.",
              submenu: numericSubmenu(
                theme,
                [86_400_000, 3 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000, 30 * 86_400_000, 90 * 86_400_000],
                formatRetention,
                "Actor run archives",
                "Retain terminal actor run archives for this duration; the latest run is always preserved.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("mesh", "Mesh", summaryFor("mesh", config), {
      description: "Durable mesh coordination store and actors.",
      submenu: sectionSubmenu(
        theme,
        "Mesh",
        "Durable mesh coordination store and actors.",
        [
          setting("mesh.enabled", "Enabled", config.mesh.enabled ? "true" : "false", {
            description: "Enable the durable mesh store and actor providers.",
            values: BOOLEANS,
          }),
          setting("mesh.actorScope", "Actor scope", config.mesh.actorScope, {
            description:
              'Default storage for newly created actors. Each agents.create call may choose project or session independently; project actors are shared, while session actors follow the root OMP session and its participant agents.',
            values: ACTOR_SCOPES,
          }),
          setting("mesh.maxReadEvents", "Max read events", String(config.mesh.maxReadEvents), {
            description: "Maximum events returned by a single mesh read.",
            submenu: numericSubmenu(
              theme,
              [100, 200, 500, 1000, 5000],
              String,
              "Max read events",
              "Maximum events returned by a single mesh read.",
            ),
          }),
          setting("mesh.actorPollMs", "Actor poll fallback", formatMs(config.mesh.actorPollMs), {
            description: "Fallback polling interval when mesh filesystem notifications are unavailable.",
            submenu: numericSubmenu(
              theme,
              [50, 100, 250, 500, 1000],
              formatMs,
              "Actor poll fallback",
              "Fallback polling interval when mesh filesystem notifications are unavailable.",
            ),
          }),
          setting("mesh.actorQueueLimit", "Actor queue limit", String(config.mesh.actorQueueLimit), {
            description: "Maximum messages queued per actor mailbox.",
            submenu: numericSubmenu(
              theme,
              [4, 8, 16, 32, 64, 128],
              String,
              "Actor queue limit",
              "Maximum messages queued per actor mailbox.",
            ),
          }),
          setting("mesh.actorContextEntries", "Actor context entries", String(config.mesh.actorContextEntries), {
            description: "Transcript entries forwarded to actors as context.",
            submenu: numericSubmenu(
              theme,
              [3, 5, 10, 14, 20, 50],
              String,
              "Actor context entries",
              "Transcript entries forwarded to actors as context.",
            ),
          }),
          setting("mesh.eventContextChars", "Event context chars", config.mesh.eventContextChars.toLocaleString(), {
            description: "Character cap applied to host events dispatched to actors.",
            submenu: numericSubmenu(
              theme,
              [10_000, 20_000, 40_000, 80_000, 160_000],
              (n) => n.toLocaleString(),
              "Event context chars",
              "Character cap applied to host events dispatched to actors.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("codePreview", "Code previews", summaryFor("codePreview", config), {
      description: "Core tool previews, diffs, and Shiki syntax highlighting.",
      submenu: sectionSubmenu(
        theme,
        "Code previews",
        "Core tool previews, diffs, and Shiki syntax highlighting. Persisted to fabric.json codePreview.",
        [
          setting("codePreview.shikiTheme", "Shiki theme", config.codePreview.shikiTheme, {
            description:
              "\"auto\" follows OMP's resolved light/dark variant; \"<light>/<dark>\" pins both; any other value fixes one theme.",
            submenu: stringOptionsSubmenu(
              theme,
              SHIKI_THEME_PRESETS,
              "Shiki theme",
              "\"auto\" follows OMP's light/dark switching (github-light/dark-plus); \"<light>/<dark>\" pins both variants.",
            ),
          }),
          setting("codePreview.syntaxHighlighting", "Syntax highlighting", config.codePreview.syntaxHighlighting ? "true" : "false", {
            description: "Highlight code in previews with Shiki.",
            values: BOOLEANS,
          }),
          setting("codePreview.diffIntensity", "Diff background", config.codePreview.diffIntensity, {
            description: "Full-row background tint for added and removed diff lines.",
            values: DIFF_INTENSITIES,
          }),
          setting("codePreview.wordEmphasis", "Word emphasis", config.codePreview.wordEmphasis, {
            description: "Highlight changed words inside added and removed diff lines.",
            values: WORD_EMPHASES,
          }),
          setting("codePreview.toolCallBackground", "Tool call background", config.codePreview.toolCallBackground, {
            description: "Background treatment for tool call frames.",
            values: TOOL_CALL_BACKGROUNDS,
          }),
          setting("codePreview.toolCallTiming", "Tool call timing", config.codePreview.toolCallTiming ? "true" : "false", {
            description: "Show per-call duration on tool frames.",
            values: BOOLEANS,
          }),
          setting("codePreview.pathIcons", "Path icons", config.codePreview.pathIcons, {
            description: "Icon set for path tree previews.",
            values: PATH_ICON_MODES,
          }),
          setting("codePreview.readCollapsedLines", "Read lines", String(config.codePreview.readCollapsedLines), {
            description: "Collapsed read preview budget.",
            submenu: numericSubmenu(theme, [3, 5, 10, 15, 20, 30], String, "Read lines", "Collapsed read preview budget."),
          }),
          setting("codePreview.writeCollapsedLines", "Write lines", String(config.codePreview.writeCollapsedLines), {
            description: "Collapsed write preview budget.",
            submenu: numericSubmenu(theme, [3, 5, 10, 15, 20, 30], String, "Write lines", "Collapsed write preview budget."),
          }),
          setting(
            CODE_PREVIEW_EDIT_LINES_ID,
            "Edit diff lines",
            config.codePreview.editCollapsedLines === "all"
              ? CODE_PREVIEW_ALL_LINES
              : String(config.codePreview.editCollapsedLines),
            {
              description: "Collapsed edit diff budget, or every diff line.",
              submenu: stringOptionsSubmenu(
                theme,
                ["10", "40", "80", "160", "320", CODE_PREVIEW_ALL_LINES],
                "Edit diff lines",
                "Collapsed edit diff budget, or every diff line.",
              ),
            },
          ),
          setting("codePreview.grepCollapsedLines", "Grep lines", String(config.codePreview.grepCollapsedLines), {
            description: "Collapsed grep result budget.",
            submenu: numericSubmenu(theme, [5, 10, 15, 25, 40], String, "Grep lines", "Collapsed grep result budget."),
          }),
          setting("codePreview.pathListCollapsedLines", "Path list lines", String(config.codePreview.pathListCollapsedLines), {
            description: "Collapsed find/ls path tree budget.",
            submenu: numericSubmenu(theme, [10, 20, 40, 80], String, "Path list lines", "Collapsed find/ls path tree budget."),
          }),
          setting("codePreview.readContentPreview", "Read preview", config.codePreview.readContentPreview ? "true" : "false", {
            description: "Show file content previews for read calls.",
            values: BOOLEANS,
          }),
          setting("codePreview.writeContentPreview", "Write preview", config.codePreview.writeContentPreview ? "true" : "false", {
            description: "Show content previews for write calls.",
            values: BOOLEANS,
          }),
          setting("codePreview.editDiffPreview", "Edit diff preview", config.codePreview.editDiffPreview ? "true" : "false", {
            description: "Show diffs for edit calls.",
            values: BOOLEANS,
          }),
          setting("codePreview.grepResultPreview", "Grep results", config.codePreview.grepResultPreview ? "true" : "false", {
            description: "Show grouped grep result previews.",
            values: BOOLEANS,
          }),
          setting("codePreview.findResultPreview", "Find results", config.codePreview.findResultPreview ? "true" : "false", {
            description: "Show find result path trees.",
            values: BOOLEANS,
          }),
          setting("codePreview.lsResultPreview", "Ls results", config.codePreview.lsResultPreview ? "true" : "false", {
            description: "Show ls result path trees.",
            values: BOOLEANS,
          }),
          setting("codePreview.readLineNumbers", "Read line numbers", config.codePreview.readLineNumbers ? "true" : "false", {
            description: "Show line-number gutters in read previews.",
            values: BOOLEANS,
          }),
          setting("codePreview.bashResultPreview", "Bash results", config.codePreview.bashResultPreview ? "true" : "false", {
            description: "Show bash output previews.",
            values: BOOLEANS,
          }),
          setting("codePreview.bashWarnings", "Bash warnings", config.codePreview.bashWarnings ? "true" : "false", {
            description: "Annotate risky bash commands.",
            values: BOOLEANS,
          }),
          setting("codePreview.secretWarnings", "Secret warnings", config.codePreview.secretWarnings ? "true" : "false", {
            description: "Flag suspected secrets in previews.",
            values: BOOLEANS,
          }),
        ],
        persist,
      ),
    }),
  ];
  return markDrillIn(items);
};

const RPC_BACK = "← Back";
const RPC_DONE = "Done";
const RPC_SWITCH_SCOPE = "Switch save scope";

type RpcChoice = {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
};

const rpcTitle = (path: string, description?: string): string =>
  description ? `${path}\n${description}` : path;

const cleanSettingLabel = (label: string): string => label.replace(/\s+›$/, "");

const rpcSettingRow = (item: SettingItem): string => {
  const label = cleanSettingLabel(item.label);
  const current = item.currentValue ? ` · ${item.currentValue}` : "";
  return item.description
    ? `${label}${current} — ${item.description}`
    : `${label}${current}`;
};

const rpcChoiceRow = (choice: RpcChoice): string => {
  const current = choice.current ? " · Current" : "";
  return choice.description
    ? `${choice.label}${current} — ${choice.description}`
    : `${choice.label}${current}`;
};

const selectRpcChoice = async (
  context: ExtensionContext,
  title: string,
  choices: RpcChoice[],
): Promise<string | undefined> => {
  const rows = choices.map(rpcChoiceRow);
  const selected = await context.ui.select(title, rows);
  if (selected === undefined) return undefined;
  const index = rows.indexOf(selected);
  return index < 0 ? undefined : choices[index]?.value;
};

const browseRpcSettings = async (
  context: ExtensionContext,
  path: string,
  description: string | undefined,
  items: SettingItem[],
  onChange: (id: string, newValue: string) => void,
): Promise<void> => {
  while (true) {
    const rows = items.map(rpcSettingRow);
    const selected = await context.ui.select(rpcTitle(path, description), [...rows, RPC_BACK]);
    if (selected === undefined || selected === RPC_BACK) return;
    const index = rows.indexOf(selected);
    const item = index < 0 ? undefined : items[index];
    if (!item) continue;
    await editRpcSetting(context, `${path} › ${cleanSettingLabel(item.label)}`, item, onChange);
  }
};

const editRpcSetting = async (
  context: ExtensionContext,
  path: string,
  item: SettingItem,
  onChange: (id: string, newValue: string) => void,
): Promise<void> => {
  if (!item.submenu) {
    const values = item.values ?? [];
    if (values.length === 0) {
      context.ui.notify(`${cleanSettingLabel(item.label)} is read-only`, "info");
      return;
    }
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      unique([item.currentValue, ...values]).map((value) => ({
        value,
        label: value,
        current: value === item.currentValue,
      })),
    );
    if (selected === undefined) return;
    item.currentValue = selected;
    onChange(item.id, selected);
    return;
  }

  let completed = false;
  let selectedValue: string | undefined;
  const component = item.submenu(item.currentValue, (value) => {
    completed = true;
    selectedValue = value;
  });

  if (component instanceof SectionSubmenu) {
    await browseRpcSettings(
      context,
      path,
      item.description,
      component.items,
      (id, value) => {
        const child = component.items.find((candidate) => candidate.id === id);
        if (child) child.currentValue = value;
        component.applyChange(id, value);
      },
    );
    return;
  }

  if (component instanceof SelectSubmenu) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      component.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        current: option.value === item.currentValue || option.label === item.currentValue,
      })),
    );
    if (selected === undefined || !component.selectRpc(selected)) return;
  } else if (component instanceof IntegerInputSubmenu) {
    while (!completed) {
      const value = await context.ui.input(rpcTitle(path, item.description), component.input.getValue());
      if (value === undefined) return;
      if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value.trim()))) {
        context.ui.notify("Enter a non-negative safe integer.", "warning");
        continue;
      }
      component.submitRpc(value);
    }
  } else if (component instanceof StringInputSubmenu) {
    const value = await context.ui.input(rpcTitle(path, item.description), component.input.getValue());
    if (value === undefined) return;
    component.submitRpc(value);
  } else if (component instanceof CompactionThresholdSubmenu) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      [
        { value: COMPACTION_DEFAULT_THRESHOLD_LABEL, label: COMPACTION_DEFAULT_THRESHOLD_LABEL, current: item.currentValue === COMPACTION_DEFAULT_THRESHOLD_LABEL },
        { value: COMPACTION_PERCENT_OPTION_LABEL, label: COMPACTION_PERCENT_OPTION_LABEL, current: item.currentValue.endsWith("%") },
        { value: COMPACTION_TOKENS_OPTION_LABEL, label: COMPACTION_TOKENS_OPTION_LABEL, current: item.currentValue.endsWith(" tokens") },
      ],
    );
    if (selected === undefined) return;
    if (selected === COMPACTION_DEFAULT_THRESHOLD_LABEL) {
      component.completeRpc(selected);
    } else {
      const percent = /^(\d+)%$/.exec(item.currentValue)?.[1] ?? "";
      const tokenText = /^(.+?) tokens$/.exec(item.currentValue)?.[1];
      const placeholder = selected === COMPACTION_PERCENT_OPTION_LABEL
        ? percent
        : tokenText === undefined ? "" : String(parseFormattedNumericValue(tokenText));
      const input = await context.ui.input(rpcTitle(path, item.description), placeholder);
      if (input === undefined || !/^\d+$/.test(input.trim())) return;
      const numeric = Number(input.trim());
      component.completeRpc(
        selected === COMPACTION_PERCENT_OPTION_LABEL
          ? `${clampCompactionPercentThreshold(numeric)}%`
          : `${formatTokens(clampCompactionTokenThreshold(numeric))} tokens`,
      );
    }
  } else if (component instanceof FabricModelSelector) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      component.rpcChoices().map((choice) => ({
        value: choice.value,
        label: choice.label,
        description: choice.description,
        current: choice.current,
      })),
    );
    if (selected === undefined || !component.selectRpc(selected)) return;
  } else {
    context.ui.notify(`${cleanSettingLabel(item.label)} requires terminal UI`, "warning");
    return;
  }

  if (!completed || selectedValue === undefined) return;
  item.currentValue = selectedValue;
  onChange(item.id, selectedValue);
};

const openRpcFabricSettings = async (
  context: ExtensionContext,
  options: {
    projectScopeAvailable: boolean;
    getScope: () => FabricConfigScope;
    setScope: (scope: FabricConfigScope) => void;
    itemsForScope: (scope: FabricConfigScope) => SettingItem[];
    persist: (id: string, value: string) => void;
  },
): Promise<void> => {
  while (true) {
    const scope = options.getScope();
    const items = options.itemsForScope(scope);
    const rows = items.map(rpcSettingRow);
    const scopeDestination = scope === "project"
      ? "Project overrides (.omp/fabric.json)"
      : "Global defaults (<active OMP agent dir>/fabric.json)";
    const controls = [
      ...(options.projectScopeAvailable ? [`${RPC_SWITCH_SCOPE} · ${scope === "project" ? "Global defaults" : "Project overrides"}`] : []),
      RPC_DONE,
    ];
    const selected = await context.ui.select(
      rpcTitle("Fabric settings", `Editing: ${scopeDestination}`),
      [...rows, ...controls],
    );
    if (selected === undefined || selected === RPC_DONE) return;
    if (selected.startsWith(RPC_SWITCH_SCOPE)) {
      options.setScope(scope === "project" ? "global" : "project");
      continue;
    }
    const index = rows.indexOf(selected);
    const item = index < 0 ? undefined : items[index];
    if (!item) continue;
    await editRpcSetting(context, `Fabric settings › ${cleanSettingLabel(item.label)}`, item, options.persist);
  }
};

export interface FabricSettingsDeps {
  state: FabricState;
  applyFabricMode: () => void;
  capturedTools: CapturedToolCatalog;
  onConfigApplied?: (id: string) => void;
}

export async function openFabricSettings(
  context: ExtensionContext,
  deps: FabricSettingsDeps,
): Promise<void> {
  await deps.state.ensure(context);
  const agentDir = resolveAgentDir();
  const projectTrusted = context.isProjectTrusted();
  const configLocation = { cwd: context.cwd, agentDir, projectTrusted };
  let saveScope: FabricConfigScope = "global";
  let settingsConfig = loadFabricConfigForScope(configLocation, saveScope);
  let rootComponent: FabricSettingsComponent | undefined;
  const changedSections = new Set<string>();
  let dirty = false;

  const activeModelKey = context.model
    ? modelKey(context.model.provider, context.model.id)
    : undefined;
  const apply = (id: string, value: unknown): void => {
    const partial = id === COMPACTION_THRESHOLD_SETTING_ID && activeModelKey
      ? compactionThresholdPartial(activeModelKey, value as CompactionThresholdSelection)
      : buildPartial(id, value);
    try {
      saveFabricConfig(
        { cwd: context.cwd, agentDir, projectTrusted, scope: saveScope },
        partial,
      );
    } catch (error) {
      context.ui.notify(
        `Failed to save Fabric settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    deps.state.reloadConfig(context);
    Object.assign(settingsConfig, loadFabricConfigForScope(configLocation, saveScope));
    deps.onConfigApplied?.(id);
    dirty = true;
    changedSections.add(id.split(".")[0] ?? id);
    const list = rootComponent?.settingsList;
    if (list) for (const rootId of ROOT_ITEM_IDS) list.updateValue(rootId, summaryFor(rootId, settingsConfig));
  };

  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, settingsConfig));

  const keepVisibleCandidates = unique([
    "fabric_exec",
    ...deps.capturedTools.list().map((tool) => tool.name),
  ]);
  const modelSource = buildModelSource(context.modelRegistry, agentDir);
  const configuredClaudeModel = deps.state.config.agents.claude.model;
  const claudeModelSource: ModelSource = {
    models: configuredClaudeModel
      ? [{ provider: "claude", id: configuredClaudeModel.replace(/^claude\//, "") }]
      : [],
    lastUsed: {},
  };
  void populateClaudeModelSource(
    claudeModelSource,
    () => deps.state.agents.claudeModels(),
  ).catch((error: unknown) => {
    if (deps.state.config.agents.runner === "claude") {
      context.ui.notify(
        `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  const toolCandidates = keepVisibleCandidates;
  const itemsForScope = (scope: FabricConfigScope, theme: Theme): SettingItem[] => {
    settingsConfig = loadFabricConfigForScope(configLocation, scope);
    return buildFabricSettingsItems(theme, settingsConfig, apply, {
      keepVisibleCandidates,
      toolCandidates,
      modelSource,
      claudeModelSource,
      ...(activeModelKey ? { activeModelKey } : {}),
    });
  };

  if (context.mode === "rpc") {
    await openRpcFabricSettings(context, {
      projectScopeAvailable: projectTrusted,
      getScope: () => saveScope,
      setScope: (scope) => {
        saveScope = scope;
      },
      itemsForScope: (scope) => itemsForScope(scope, context.ui.theme),
      persist,
    });
  } else if (context.mode !== "tui") {
    context.ui.notify("Fabric settings require an interactive UI", "warning");
    return;
  } else {
    await context.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const component = new FabricSettingsComponent(
          theme,
          itemsForScope(saveScope, theme),
          persist,
          () => done(),
          {
            initialSaveScope: saveScope,
            projectScopeAvailable: projectTrusted,
            onSaveScopeChange: (scope) => {
              saveScope = scope;
              tui.requestRender();
            },
            itemsForSaveScope: (scope) => itemsForScope(scope, theme),
          },
        );
        rootComponent = component;
        return component;
      },
    );
  }

  if (dirty) {
    deps.applyFabricMode();
    const needsReload = [...changedSections].some((section) => RELOAD_SECTIONS.has(section));
    if (needsReload) {
      context.ui.notify(
        "Fabric settings saved. Run /fabric reload to apply mesh, agent, and MCP changes.",
        "info",
      );
    } else if (changedSections.has("schema")) {
      context.ui.notify(
        "Fabric settings saved. Schema changes take effect in the next session.",
        "info",
      );
    } else {
      context.ui.notify("Fabric settings saved.", "info");
    }
  }
}
