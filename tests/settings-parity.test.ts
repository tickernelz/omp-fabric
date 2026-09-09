import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  normalizeFabricConfig,
  type FabricConfig,
} from "../src/config.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import {
  ALIASED_CONFIG_KEYS,
  buildFabricSettingsItems,
  buildPartial,
  coerceValue,
  compactionThresholdPartial,
  FILE_ONLY_CONFIG_KEYS,
  ROOT_ITEM_IDS,
} from "../src/ui/settings.js";

type SettingItem = ReturnType<typeof buildFabricSettingsItems>[number];

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const ACTIVE_MODEL_KEY = "anthropic/claude-sonnet-4-5";

const modelSource: ModelSource = {
  models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
  lastUsed: { [ACTIVE_MODEL_KEY]: 1 },
};

const PROBE_TOOL = "parity_probe_tool";

const build = (
  config: FabricConfig,
  apply: (id: string, value: unknown) => void = () => {},
): SettingItem[] =>
  buildFabricSettingsItems(theme, config, apply, {
    keepVisibleCandidates: ["fabric_exec", PROBE_TOOL],
    toolCandidates: ["fabric_exec", PROBE_TOOL],
    modelSource,
    activeModelKey: ACTIVE_MODEL_KEY,
  });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flattenKeys = (value: unknown, prefix = ""): string[] => {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenKeys(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
};

const readPath = (source: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>(
    (current, segment) => (isPlainObject(current) ? current[segment] : undefined),
    source,
  );

const writePath = (target: Record<string, unknown>, key: string, value: unknown): void => {
  const segments = key.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
};

const sectionItems = (item: SettingItem): SettingItem[] | undefined => {
  if (!item.submenu) return undefined;
  const component = item.submenu(item.currentValue, () => {}) as { items?: unknown };
  return Array.isArray(component.items) &&
    component.items.every((child) => typeof (child as SettingItem | undefined)?.id === "string")
    ? (component.items as SettingItem[])
    : undefined;
};

const selectOptions = (item: SettingItem): Array<{ value: string; label: string }> => {
  if (!item.submenu) return [];
  const component = item.submenu(item.currentValue, () => {}) as {
    options?: Array<{ value: string; label: string }>;
  };
  return Array.isArray(component.options) ? component.options : [];
};

const collectRows = (items: SettingItem[]): Map<string, SettingItem> => {
  const rows = new Map<string, SettingItem>();
  const visit = (list: readonly SettingItem[]): void => {
    for (const item of list) {
      rows.set(item.id, item);
      const nested = sectionItems(item);
      if (nested) visit(nested);
    }
  };
  visit(items);
  return rows;
};

const isEditable = (item: SettingItem): boolean =>
  (item.values?.length ?? 0) > 0 || item.submenu !== undefined;

const listRowChildren = (item: SettingItem): SettingItem[] | undefined => {
  if (!/^\d+ tools?$/.test(item.currentValue)) return undefined;
  const children = sectionItems(item);
  if (!children || children.length === 0) return undefined;
  const prefix = `${item.id}.`;
  return children.every(
    (child) => child.id.startsWith(prefix) && child.values?.join(",") === "true,false",
  )
    ? children
    : undefined;
};

const MAP_PROBES: Readonly<Record<string, unknown>> = {
  "executor.hostCallTimeouts": { "extensions.parityProbe": 60_000 },
  "models.aliases": { parityprobe: [ACTIVE_MODEL_KEY] },
};

const probeValue = (key: string, current: unknown, item: SettingItem): unknown => {
  if (typeof current === "boolean") return !current;
  if (typeof current === "number") return current * 2 + 1;
  if (Array.isArray(current)) return [...current, "parity-probe"];
  if (typeof current === "string") {
    const candidates = item.values?.length
      ? [...item.values]
      : selectOptions(item).map((option) => option.value);
    return candidates.find((candidate) => candidate !== current) ?? `${current}-probe`;
  }
  return MAP_PROBES[key];
};

const configKeys = flattenKeys(DEFAULT_FABRIC_CONFIG);
const defaultRows = collectRows(build(DEFAULT_FABRIC_CONFIG));
const ownedKeys = configKeys.filter(
  (key) => !(key in FILE_ONLY_CONFIG_KEYS) && !(key in ALIASED_CONFIG_KEYS),
);

describe("fabric settings panel parity", () => {
  it("gives every configuration key a panel row or a named exemption", () => {
    const unreachable = ownedKeys.filter((key) => {
      const row = defaultRows.get(key);
      return row === undefined || !isEditable(row);
    });

    expect(unreachable).toEqual([]);
    expect(ownedKeys.length).toBeGreaterThan(150);
  });

  it("keeps every exemption a real key, reasoned, and free of a competing row", () => {
    for (const [key, reason] of Object.entries(FILE_ONLY_CONFIG_KEYS)) {
      expect(configKeys).toContain(key);
      expect(reason.length).toBeGreaterThan(40);
      expect(defaultRows.has(key)).toBe(false);
    }

    for (const [key, rowId] of Object.entries(ALIASED_CONFIG_KEYS)) {
      expect(configKeys).toContain(key);
      expect(defaultRows.has(key)).toBe(false);
      const row = defaultRows.get(rowId);
      expect(row, `aliased row ${rowId} is missing`).toBeDefined();
      expect(isEditable(row as SettingItem)).toBe(true);
    }
  });

  it("leaves no row that renders as editable and does nothing", () => {
    const inert = [...defaultRows.values()]
      .filter((item) => !isEditable(item))
      .map((item) => item.id);

    expect(inert).toEqual([]);
  });

  it("reads and writes each key through the row that claims it", () => {
    const failures: string[] = [];

    for (const key of ownedKeys) {
      const row = defaultRows.get(key);
      if (!row) continue;
      const original = readPath(DEFAULT_FABRIC_CONFIG, key);
      const probe = probeValue(key, original, row);
      if (probe === undefined) {
        failures.push(`${key}: no probe value for this shape`);
        continue;
      }

      const probeConfig = structuredClone(DEFAULT_FABRIC_CONFIG) as unknown as Record<string, unknown>;
      writePath(probeConfig, key, probe);
      const probedRow = collectRows(build(probeConfig as unknown as FabricConfig)).get(key);
      if (!probedRow) {
        failures.push(`${key}: row disappeared when the key changed`);
        continue;
      }
      if (probedRow.currentValue === row.currentValue) {
        failures.push(`${key}: row value ignores the key it names`);
        continue;
      }

      const children = listRowChildren(row);
      let written: unknown;
      if (children) {
        let captured: unknown;
        const items = build(DEFAULT_FABRIC_CONFIG, (id, value) => {
          if (id === key) captured = value;
        });
        const listRow = collectRows(items).get(key) as SettingItem;
        const submenu = listRow.submenu?.(listRow.currentValue, () => {}) as unknown as {
          items: SettingItem[];
          applyChange: (id: string, value: string) => void;
        };
        const child = submenu.items[0] as SettingItem;
        child.currentValue = child.currentValue === "true" ? "false" : "true";
        submenu.applyChange(child.id, child.currentValue);
        written = captured;
      } else {
        written = coerceValue(key, probedRow.currentValue, DEFAULT_FABRIC_CONFIG);
      }

      const persisted = readPath(normalizeFabricConfig(buildPartial(key, written)), key);
      if (JSON.stringify(persisted) === JSON.stringify(original)) {
        failures.push(`${key}: editing the row persists nothing at that path`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("offers the configured value in every numeric option list", () => {
    const missing: string[] = [];

    for (const key of ownedKeys) {
      const value = readPath(DEFAULT_FABRIC_CONFIG, key);
      if (typeof value !== "number") continue;
      const row = defaultRows.get(key);
      if (!row) continue;
      const options = row.values?.length ? [...row.values] : selectOptions(row).map((o) => o.value);
      if (options.length === 0) continue;
      if (!options.some((option) => Number(option) === value)) missing.push(key);
    }

    expect(missing).toEqual([]);
  });

  it("refreshes the summary of every root section", () => {
    const rootIds = build(DEFAULT_FABRIC_CONFIG).map((item) => item.id);

    expect(rootIds).toEqual([...ROOT_ITEM_IDS]);
  });

  it("edits both per-model threshold maps through the aliased threshold row", () => {
    const withTokens = structuredClone(DEFAULT_FABRIC_CONFIG);
    withTokens.compaction.tokenThresholds[ACTIVE_MODEL_KEY] = 120_000;
    const row = collectRows(build(withTokens)).get("compaction.threshold") as SettingItem;
    expect(row.currentValue).toBe("120k tokens");

    const tokens = normalizeFabricConfig(
      compactionThresholdPartial(ACTIVE_MODEL_KEY, { mode: "tokens", value: 120_000 }),
    );
    expect(tokens.compaction.tokenThresholds[ACTIVE_MODEL_KEY]).toBe(120_000);

    const percent = normalizeFabricConfig(
      compactionThresholdPartial(ACTIVE_MODEL_KEY, { mode: "percent", value: 0.6 }),
    );
    expect(percent.compaction.thresholds[ACTIVE_MODEL_KEY]).toBe(0.6);
    expect(percent.compaction.tokenThresholds[ACTIVE_MODEL_KEY]).toBeUndefined();
  });
});