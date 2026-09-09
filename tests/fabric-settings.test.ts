import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, loadFabricConfig, normalizeFabricConfig } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import {
  buildFabricSettingsItems,
  compactionThresholdPartial,
  executorMemoryLimitOptions,
  FabricSettingsComponent,
  openFabricSettings,
  parseBudgetValue,
  parseFormattedNumericValue,
  populateClaudeModelSource,
} from "../src/ui/settings.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const borderLine = (width: number): string => "─".repeat(width);

const fakeModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: { "anthropic/claude-sonnet-4-5": 200, "openai/gpt-5.5": 100 },
};

const buildItems = (keepVisibleCandidates: readonly string[] = ["fabric_exec"]) =>
  buildFabricSettingsItems(theme, DEFAULT_FABRIC_CONFIG, () => {}, {
    keepVisibleCandidates: [...keepVisibleCandidates],
    modelSource: fakeModelSource,
    activeModelKey: "anthropic/claude-sonnet-4-5",
  });

type SettingsListProbe = {
  selectItem(id: string): boolean;
  handleInput(data: string): void;
  getSelectedItem(): { id: string; currentValue: string } | undefined;
  render(width: number): readonly string[];
};

type SectionProbe = {
  items: Array<{ id: string; currentValue: string; values?: readonly string[] }>;
  settingsList: SettingsListProbe;
  applyChange(id: string, value: string): void;
  render(width: number): readonly string[];
};
describe("FabricSettingsComponent", () => {
  it("populates Claude models asynchronously without requiring startup discovery", async () => {
    const source: ModelSource = {
      models: [{ provider: "claude", id: "configured" }],
      lastUsed: {},
    };
    let resolveModels!: (models: Array<{ value: string; displayName: string }>) => void;
    const models = new Promise<Array<{ value: string; displayName: string }>>((resolve) => {
      resolveModels = resolve;
    });

    const loading = populateClaudeModelSource(source, () => models);
    expect(source.models.map((model) => model.id)).toEqual(["configured"]);

    resolveModels([{ value: "haiku", displayName: "Haiku" }]);
    await loading;
    expect(source.models).toEqual([
      { provider: "claude", id: "haiku", name: "Haiku" },
    ]);
  });

  it("offers executor memory limits through the machine capacity", () => {
    const machineCapacity = 24 * 1024 * 1024 * 1024;
    const values = executorMemoryLimitOptions(machineCapacity);

    expect(values).toContain(512 * 1024 * 1024);
    expect(values.at(-1)).toBe(machineCapacity);
  });

  it("surfaces the unsafe Node process executor and its larger memory range", () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
    });
    const executor = items.find((item) => item.id === "executor")!;
    const lines = executor.submenu!("", () => {}).render(100).join("\n");

    expect(lines).toContain("node-process");
    expect(lines).toContain("unsafe");
    expect(lines).toContain("trusted-code escape hatch");
  });

  it("renders the native top and bottom borders with search", () => {
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {});
    const lines = component.render(80);

    expect(lines[0]).toBe(borderLine(80));
    expect(lines[lines.length - 1]).toBe(borderLine(80));
    expect(lines.some((line) => line.includes("Type to search"))).toBe(true);
    expect(lines.some((line) => line.includes("Full code mode"))).toBe(true);
    expect(lines.some((line) => line.includes("Executor"))).toBe(true);
    expect(lines.some((line) => line.includes("Editing: Global defaults (<active OMP agent dir>/fabric.json)"))).toBe(true);
  });

  it("toggles save scope with Ctrl+G from the root and active submenus", () => {
    const scopes: string[] = [];
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {}, {
      initialSaveScope: "project",
      projectScopeAvailable: true,
      onSaveScopeChange: (scope) => scopes.push(scope),
    });

    component.handleInput("\x07");
    expect(component.render(100).join("\n")).toContain(
      "Editing: Global defaults (<active OMP agent dir>/fabric.json)",
    );

    expect(component.settingsList.selectItem("executor")).toBe(true);
    component.settingsList.handleInput("\r");
    component.handleInput("\x07");

    expect(component.render(100).join("\n")).toContain(
      "Editing: Project overrides (.omp/fabric.json)",
    );
    expect(component.render(100).join("\n")).toContain("Runtime");
    expect(scopes).toEqual(["global", "project"]);
  });

  it("keeps untrusted settings global-only", () => {
    const onSaveScopeChange = vi.fn();
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {}, {
      initialSaveScope: "global",
      projectScopeAvailable: false,
      onSaveScopeChange,
    });

    component.handleInput("\x07");

    expect(component.render(100).join("\n")).toContain(
      "Editing: Global defaults (<active OMP agent dir>/fabric.json)",
    );
    expect(component.render(100).join("\n")).toContain("project scope unavailable");
    expect(onSaveScopeChange).not.toHaveBeenCalled();
  });

  it("renders every section", () => {
    const items = buildItems();
    const component = new FabricSettingsComponent(theme, items, () => {}, () => {});
    const lines = component.render(80).join("\n");
    const labels = items.map((item) => item.label).join("\n");

    for (const label of [
      "Full code mode",
      "Executor",
      "Schema",
      "Approvals",
      "MCP",
      "Prewalk",
      "Code map",
      "Agents",
      "Models",
      "Capture",
      "UI",
      "Compaction",
      "Retention",
      "Mesh",
      "Memory",
      "Speculation",
      "Code previews",
    ]) {
      expect(labels).toContain(label);
    }
    expect(items.length).toBe(17);
  });

  it("marks submenu rows with a drill-in marker and leaves inline toggles plain", () => {
    const items = buildItems();
    const labels = items.map((item) => item.label);
    // Top-level sections open a submenu.
    expect(labels).toContain("Executor ›");
    expect(labels).toContain("Prewalk ›");
    expect(labels).toContain("Agents ›");
    // Full code mode cycles values inline; no drill-in marker.
    expect(labels).toContain("Full code mode");
    expect(labels).not.toContain("Full code mode ›");

    // Inside a section, submenu fields are marked but inline value toggles are not.
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model ›");
    expect(lines).toContain("Max concurrent ›");
    expect(lines).toContain("Veda backend ›");
    expect(lines).toContain("Veda persona ›");
    expect(lines).toContain("Veda model ›");
    // Inline value-cycle rows stay plain.
    expect(lines).toContain("Transport");
    expect(lines).not.toContain("Transport ›");
    expect(lines).toContain("Enabled");
    expect(lines).not.toContain("Enabled ›");
  });

  it("opening a section submenu renders its fields", () => {
    const items = buildItems();
    const executor = items.find((item) => item.id === "executor");
    expect(executor?.submenu).toBeDefined();
    const submenu = executor!.submenu!("", () => {});
    const lines = submenu.render(80).join("\n");
    expect(lines).toContain("Runtime");
    expect(lines).toContain("quickjs");
    expect(lines).toContain("Timeout");
    expect(lines).toContain("Memory limit");
    expect(lines).toContain("Max output chars");
    expect(lines).toContain("Result format");
    expect(lines).toContain("auto");
  });

  it("section submenus offer the same type-to-search filter as the root page", () => {
    const items = buildItems();
    const executor = items.find((item) => item.id === "executor")!;
    const submenu = executor.submenu!("", () => {});

    const initial = submenu.render(80).join("\n");
    expect(initial).toContain("Type to search");
    expect(initial).toContain("Runtime");

    for (const char of "memory") submenu.handleInput?.(char);
    const filtered = submenu.render(80).join("\n");
    expect(filtered).toContain("Memory limit");
    expect(filtered).not.toContain("Timeout");
    expect(filtered).not.toContain("Result format");
    expect(filtered).not.toContain("No matching settings");
  });

  it("exposes the compaction engine", () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.targetContextRatio = 0.5;
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
      activeModelKey: "anthropic/claude-sonnet-4-5",
    });
    const compaction = items.find((item) => item.id === "compaction");
    expect(compaction?.currentValue).toBe("lcm");
    const rows = compaction!.submenu!("", () => {}).render(80);
    const lines = rows.join("\n");
    expect(lines).toContain("Threshold");
    expect(lines).toContain("OMP default");
    expect(lines).toContain("anthropic/claude-sonnet-4-5");
    expect(lines).toContain("Engine");
    expect(lines).toContain("lcm");
    expect(lines).toContain("Max occupancy");
    expect(rows.find((row) => row.includes("Max occupancy"))).toContain("0.5");
    const section = compaction!.submenu!("", () => {}) as any;
    const target = (section.items as Array<{ id: string; values?: readonly string[] }>).find(
      (item: { id: string }) => item.id === "compaction.targetContextRatio",
    );
    expect(target?.values).toEqual(
      Array.from({ length: 13 }, (_, index) => String((25 + index * 5) / 100)),
    );
    const ratios = (section.items as Array<{ id: string; label: string; currentValue: string; values?: readonly string[] }>);
    const soft = ratios.find((item) => item.id === "compaction.softThresholdRatio");
    expect(soft?.label).toBe("Maintenance occupancy");
    expect(soft?.currentValue).toBe("0.55");
    expect(soft?.values).toEqual([
      "0",
      ...Array.from({ length: 18 }, (_, index) => String((10 + index * 5) / 100)),
    ]);
    const hard = ratios.find((item) => item.id === "compaction.hardThresholdRatio");
    expect(hard?.label).toBe("Forced compaction occupancy");
    expect(hard?.currentValue).toBe("0");
    expect(hard?.values?.[0]).toBe("0");
  });

  it("persists the active model's compaction threshold as a custom percent", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["openai/gpt-5.5"] = 0.6;
    const items = buildFabricSettingsItems(theme, config, (id, value) => applied.push({ id, value }), {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
      activeModelKey: "openai/gpt-5.5",
    });
    const section = items.find((item) => item.id === "compaction")!.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("compaction.threshold")).toBe(true);
    expect(list.getSelectedItem()?.currentValue).toBe("60%");

    const pickCustomPercent = (): void => {
      list.handleInput("\r");
      list.handleInput("\x1b[B");
      list.handleInput("\r");
    };
    const clearPrefill = (length: number): void => {
      for (let index = 0; index < length; index += 1) list.handleInput("\x7f");
    };

    pickCustomPercent();
    clearPrefill(2);
    list.handleInput("73");
    list.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "compaction.threshold",
      value: { mode: "percent", value: 0.73 },
    });
    expect(list.getSelectedItem()?.currentValue).toBe("73%");

    pickCustomPercent();
    clearPrefill(2);
    list.handleInput("5");
    list.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "compaction.threshold",
      value: { mode: "percent", value: 0.25 },
    });
    expect(list.getSelectedItem()?.currentValue).toBe("25%");

    pickCustomPercent();
    list.handleInput("\x1b");
    expect(list.render(100).join("\n")).toContain("Custom percent…");
  });

  it("persists a custom token threshold through the drill-in input", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.tokenThresholds["openai/gpt-5.5"] = 150_000;
    const items = buildFabricSettingsItems(theme, config, (id, value) => applied.push({ id, value }), {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
      activeModelKey: "openai/gpt-5.5",
    });
    const section = items.find((item) => item.id === "compaction")!.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("compaction.threshold")).toBe(true);
    expect(list.getSelectedItem()?.currentValue).toBe("150k tokens");

    const pickCustomTokens = (): void => {
      list.handleInput("\r");
      list.handleInput("\x1b[B");
      list.handleInput("\x1b[B");
      list.handleInput("\r");
    };
    const clearPrefill = (length: number): void => {
      for (let index = 0; index < length; index += 1) list.handleInput("\x7f");
    };

    pickCustomTokens();
    clearPrefill(6);
    list.handleInput("5");
    list.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "compaction.threshold",
      value: { mode: "tokens", value: 1_000 },
    });
    expect(list.getSelectedItem()?.currentValue).toBe("1k tokens");

    pickCustomTokens();
    clearPrefill(6);
    list.handleInput("240000");
    list.handleInput("\r");
    expect(applied.at(-1)).toEqual({
      id: "compaction.threshold",
      value: { mode: "tokens", value: 240_000 },
    });
    expect(list.getSelectedItem()?.currentValue).toBe("240k tokens");

    pickCustomTokens();
    list.handleInput("\x1b");
    expect(list.render(100).join("\n")).toContain("Custom tokens…");
  });


  it("builds exclusive compaction threshold partials per mode", () => {
    expect(compactionThresholdPartial("openai/gpt-5.5", { mode: "percent", value: 0.8 })).toEqual({
      compaction: {
        thresholds: { "openai/gpt-5.5": 0.8 },
        tokenThresholds: { "openai/gpt-5.5": null },
      },
    });
    expect(compactionThresholdPartial("openai/gpt-5.5", { mode: "tokens", value: 240_000 })).toEqual({
      compaction: {
        thresholds: { "openai/gpt-5.5": null },
        tokenThresholds: { "openai/gpt-5.5": 240_000 },
      },
    });
    expect(compactionThresholdPartial("openai/gpt-5.5", { mode: "default" })).toEqual({
      compaction: {
        thresholds: { "openai/gpt-5.5": null },
        tokenThresholds: { "openai/gpt-5.5": null },
      },
    });
  });

  it("exposes temporal retention defaults", () => {
    const items = buildItems();
    const retention = items.find((item) => item.id === "retention");
    expect(retention?.currentValue).toBe("6h · 1d · 7d · 7d/256 MB");
    const lines = retention!.submenu!("", () => {}).render(100).join("\n");
    expect(lines).toContain("Orphaned temp runs");
    expect(lines).toContain("6h");
    expect(lines).toContain("One-shot runs");
    expect(lines).toContain("1d");
    expect(lines).toContain("Actor run archives");
    expect(lines).toContain("7d");
    expect(lines).toContain("session.jsonl");
    expect(lines).toContain("Output overflow age");
    expect(lines).toContain("Output overflow size");
    expect(lines).toContain("256 MB");
  });

  it("keeps every reconciled maintenance occupancy selectable in its own picker", () => {
    for (const hardThresholdRatio of [0, 0.2, 0.25, 0.5, 0.7, 0.95, 0.98]) {
      const config = normalizeFabricConfig({
        compaction: { softThresholdRatio: 0.95, hardThresholdRatio },
      });
      const items = buildFabricSettingsItems(theme, config, () => {}, {
        keepVisibleCandidates: ["fabric_exec"],
        modelSource: fakeModelSource,
        activeModelKey: "anthropic/claude-sonnet-4-5",
      });
      const compaction = items.find((item) => item.id === "compaction");
      const section = compaction!.submenu!("", () => {}) as unknown as SectionProbe;
      const soft = section.items.find((item) => item.id === "compaction.softThresholdRatio");

      expect(soft?.values).toContain(soft?.currentValue);
      expect(soft?.currentValue).toBe(String(config.compaction.softThresholdRatio));
    }
  });

  it("offers an explicit off entry for the maintenance occupancy", () => {
    const config = normalizeFabricConfig({ compaction: { softThresholdRatio: 0 } });
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
      activeModelKey: "anthropic/claude-sonnet-4-5",
    });
    const compaction = items.find((item) => item.id === "compaction");
    const section = compaction!.submenu!("", () => {}) as unknown as SectionProbe;
    const soft = section.items.find((item) => item.id === "compaction.softThresholdRatio");

    expect(soft?.currentValue).toBe("0");
    expect(soft?.values).toContain("0");
  });

  it("presents the Tool display row in the UI settings section", () => {
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {});

    component.handleInput("ui");
    expect(component.render(80).join("\n")).toContain("→ UI ›");
    component.handleInput("\r");
    const lines = component.render(80).join("\n");
    expect(lines).toContain("Tool display");
    expect(lines).toContain("compact");
    expect(lines).toContain("Agent tool preview");
    expect(lines).toContain("Update debounce");
    expect(lines).toContain("100ms");
  });

  it("surfaces the recursion budget in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("Off");
  });

  it("accepts an arbitrary non-negative agent depth", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("agents.maxDepth")).toBe(true);
    list.handleInput("\r");

    expect(list.render(100).join("\n")).toContain(
      "Enter any non-negative integer",
    );
    list.handleInput("\x7f");
    list.handleInput("-1");
    list.handleInput("\r");
    expect(applied).toEqual([]);
    expect(list.render(100).join("\n")).toContain(
      "Enter a non-negative safe integer",
    );

    list.handleInput("\x7f");
    list.handleInput("\x7f");
    list.handleInput("64");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({ id: "agents.maxDepth", value: 64 });
    expect(list.getSelectedItem()?.currentValue).toBe("64");
  });

  it("shows the configured budget as a currency value", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0.25 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("$0.25");
  });

  it("persists formatted numeric settings while keeping their normalized labels", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.memoryLimitBytes = 64 * 1024 * 1024;
    const items = buildFabricSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const executor = items.find((item) => item.id === "executor")!;
    const section = executor.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("executor.memoryLimitBytes")).toBe(true);
    list.handleInput("\r");
    const machineCapacity = 24 * 1024 * 1024 * 1024;
    const options = executorMemoryLimitOptions(machineCapacity);
    const targetRank = options.indexOf(128 * 1024 * 1024);
    const currentRank = options.indexOf(config.executor.memoryLimitBytes);
    for (let steps = 0; steps < targetRank - currentRank; steps += 1) list.handleInput("\x1b[B");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "executor.memoryLimitBytes",
      value: 128 * 1024 * 1024,
    });
    expect(list.getSelectedItem()?.currentValue).toBe("128 MB");
    expect(section.render(100).join("\n")).not.toContain("134217728");
  });

  it("persists labeled thinking levels using their canonical values", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("agents.thinking")).toBe(true);
    list.handleInput("\r");
    for (let steps = 0; steps < 1; steps += 1) list.handleInput("\x1b[B");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({ id: "agents.thinking", value: "high" });
    expect(list.getSelectedItem()?.currentValue).toBe("High");
  });

  it("parses every formatted numeric settings style", () => {
    expect(parseFormattedNumericValue("128 MB")).toBe(128 * 1024 * 1024);
    expect(parseFormattedNumericValue("250ms")).toBe(250);
    expect(parseFormattedNumericValue("2m")).toBe(120_000);
    expect(parseFormattedNumericValue("7d")).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(parseFormattedNumericValue("$0.25")).toBe(0.25);
    expect(parseFormattedNumericValue("500k")).toBe(500_000);
    expect(parseFormattedNumericValue("2M")).toBe(2_000_000);
    expect(parseFormattedNumericValue("2,000,000")).toBe(2_000_000);
    expect(parseFormattedNumericValue("Off")).toBe(0);
  });

  it("parses currency-formatted budget values back to numbers", () => {
    expect(parseBudgetValue("$0.25")).toBe(0.25);
    expect(parseBudgetValue("$0.10")).toBe(0.1);
    expect(parseBudgetValue("Off")).toBe(0);
    expect(parseBudgetValue("0.5")).toBe(0.5);
    expect(parseBudgetValue("$5.00")).toBe(5);
  });

  it("surfaces the default thinking level in the Agents section as Medium by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("Medium");
  });

  it("shows a configured thinking level in the Agents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("High");
  });

  it("offers auto policies and a dedicated classifier model picker", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.write = "auto";
    const items = buildFabricSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const approvals = items.find((item) => item.id === "approvals")!;
    const section = approvals.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    const write = section.items.find((item) => item.id === "approvals.write");
    expect(write?.currentValue).toBe("auto");
    expect(write?.values).toContain("auto");
    expect(section.render(100).join("\n")).toContain("Auto model ›");
    expect(section.render(100).join("\n")).toContain("Inherit");

    expect(list.selectItem("approvals.model")).toBe(true);
    list.handleInput("\r");
    list.handleInput("\x1b[B");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "approvals.model",
      value: "anthropic/claude-sonnet-4-5",
    });
  });

  it("persists a Prewalk model selection and reopens with its checkmark", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const prewalk = items.find((item) => item.id === "prewalk")!;
    expect(prewalk.currentValue).toBe("in-place · Ask each time");
    const section = prewalk.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("prewalk.model")).toBe(true);

    list.handleInput("\r");
    list.handleInput("\x1b[B");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "prewalk.model",
      value: "anthropic/claude-sonnet-4-5",
    });
    expect(list.getSelectedItem()?.currentValue).toBe(
      "anthropic/claude-sonnet-4-5",
    );

    list.handleInput("\r");
    const reopened = list.render(100).join("\n");
    const modelLine = reopened
      .split("\n")
      .find((line: string) => line.includes("claude-sonnet-4-5"));
    const unsetLine = reopened
      .split("\n")
      .find(
        (line: string) =>
          line.includes("Ask each time") && !line.includes("Pick Ask each time"),
      );
    expect(modelLine).toContain("✓");
    expect(unsetLine).not.toContain("✓");

    list.handleInput("\x1b[A");
    list.handleInput("\r");
    expect(applied.at(-1)).toEqual({ id: "prewalk.model", value: "" });
    expect(list.getSelectedItem()?.currentValue).toBe("Ask each time");

    list.handleInput("\r");
    const cleared = list.render(100).join("\n");
    const clearedUnsetLine = cleared
      .split("\n")
      .find(
        (line: string) =>
          line.includes("Ask each time") && !line.includes("Pick Ask each time"),
      );
    expect(clearedUnsetLine).toContain("✓");
  });

  it("persists a Prewalk thinking selection and clears it back to Agents default", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const prewalk = items.find((item) => item.id === "prewalk")!;
    expect(prewalk.currentValue).toBe("in-place · Ask each time");
    const section = prewalk.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("prewalk.thinking")).toBe(true);
    expect(list.getSelectedItem()?.currentValue).toBe("Agents default");

    list.handleInput("\r");
    for (let steps = 0; steps < 5; steps += 1) list.handleInput("\x1b[B");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({ id: "prewalk.thinking", value: "high" });
    expect(list.getSelectedItem()?.currentValue).toBe("High");

    list.handleInput("\r");
    for (let steps = 0; steps < 5; steps += 1) list.handleInput("\x1b[A");
    list.handleInput("\r");

    expect(applied.at(-1)).toEqual({ id: "prewalk.thinking", value: "" });
    expect(list.getSelectedItem()?.currentValue).toBe("Agents default");
  });

  it("exposes a dedicated prewalk executor model picker", () => {
    const config = {
      ...DEFAULT_FABRIC_CONFIG,
      prewalk: { mode: "in-place" as const, model: "anthropic/claude-sonnet-4-5", alwaysRearm: false, compactOnReturn: true, detectShellWrites: true, handoffRetirement: true, handoffRetirementKeep: 3 },
    };
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
    });
    const prewalk = items.find((item) => item.id === "prewalk")!;
    const lines = prewalk.submenu!("", () => {}).render(100).join("\n");

    expect(lines).toContain("Mode");
    expect(lines).toContain("in-place");
    expect(lines).toContain("Always re-arm");
    expect(lines).toContain("Executor model ›");
    expect(lines).toContain("anthropic/claude-sonnet-4-5");
  });

  it("reopens the shared agent model picker at its live selection", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as unknown as SectionProbe;
    const list = section.settingsList;
    expect(list.selectItem("agents.model")).toBe(true);

    list.handleInput("\r");
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    list.handleInput("\r");

    const reopened = list.render(100).join("\n");
    const modelLine = reopened
      .split("\n")
      .find((line: string) => line.includes("claude-sonnet-4-5"));
    const inheritLine = reopened
      .split("\n")
      .find((line: string) => line.includes("Inherit"));
    expect(modelLine).toContain("✓");
    expect(inheritLine).not.toContain("✓");
  });


  it("exposes every LCM compaction key in the settings panel", () => {
    const items = buildItems();
    const compaction = items.find((item) => item.id === "compaction")!;
    const section = compaction.submenu!("", () => {}) as unknown as SectionProbe;
    const ids = new Set(section.items.map((item) => item.id));
    const lcmKeys = Object.keys(DEFAULT_FABRIC_CONFIG.compaction)
      .filter((key) => key !== "thresholds" && key !== "tokenThresholds")
      .map((key) => `compaction.${key}`);
    expect(lcmKeys.filter((key) => !ids.has(key))).toEqual([]);
  });

  it("offers the model timeout as seconds and defaults to two minutes", () => {
    const section = buildItems().find((item) => item.id === "compaction")!
      .submenu!("", () => {}) as unknown as SectionProbe;
    const timeout = section.items.find((item) => item.id === "compaction.lcmModelTimeoutSeconds")!;
    expect(DEFAULT_FABRIC_CONFIG.compaction.lcmModelTimeoutSeconds).toBe(120);
    expect(timeout.currentValue).toBe("120s");
    expect(section.items.find((item) => item.id === "compaction.lcmMaxDailyModelCalls")?.currentValue).toBe("no limit");
  });

  it("picks the LCM summary model from the available OMP models", () => {
    const items = buildItems();
    const compaction = items.find((item) => item.id === "compaction")!;
    const section = compaction.submenu!("", () => {}) as unknown as SectionProbe;
    const summary = section.items.find((item) => item.id === "compaction.summaryModel")!;
    expect(summary.currentValue).toBe("Inherit");
    expect(summary.values).toBeUndefined();

    const list = section.settingsList;
    expect(list.selectItem("compaction.summaryModel")).toBe(true);
    list.handleInput("\r");
    const picker = list.render(100).join("\n");
    expect(picker).toContain("claude-sonnet-4-5");
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    expect(list.getSelectedItem()?.currentValue).not.toBe("Inherit");
  });

  it("clears the LCM summary model when the picker inherits", () => {
    const persisted: Array<[string, unknown]> = [];
    const items = buildFabricSettingsItems(theme, DEFAULT_FABRIC_CONFIG, (id, value) => {
      persisted.push([id, value]);
    }, { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource, activeModelKey: "anthropic/claude-sonnet-4-5" });
    const section = items.find((item) => item.id === "compaction")!
      .submenu!("", () => {}) as unknown as SectionProbe;
    section.applyChange("compaction.summaryModel", "anthropic/claude-sonnet-4-5");
    expect(persisted.at(-1)).toEqual(["compaction.summaryModel", "anthropic/claude-sonnet-4-5"]);
    section.applyChange("compaction.summaryModel", "Inherit");
    expect(persisted.at(-1)).toEqual(["compaction.summaryModel", ""]);
  });

  it("surfaces the default model in the Agents section as Inherit by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("Inherit");
  });

  it("shows the configured default model value in the Agents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("claude-sonnet-4-5");
    expect(lines).not.toContain("Default model ›      Inherit");
  });

  it("renders the list-editor rows with counts in their sections", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const agents = items.find((item) => item.id === "agents")!;
    const agentsLines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(agentsLines).toContain("Veda backend");
    expect(agentsLines).toContain("Veda persona");
    expect(agentsLines).toContain("Veda model");
    const capture = items.find((item) => item.id === "capture")!;
    const captureLines = capture.submenu!("", () => {}).render(80).join("\n");
    expect(captureLines).toContain("Keep visible");
    expect(captureLines).toContain("1 tool");
  });

  it("keep-visible candidates include existing entries plus fabric_exec", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const capture = items.find((item) => item.id === "capture")!;
    const captureSub = capture.submenu!("", () => {});
    const lines = captureSub.render(80).join("\n");
    expect(lines).toContain("Keep visible");
  });

  it("surfaces the per-child token limit in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const section = agents!.submenu!("", () => {}) as unknown as SectionProbe;
    const limit = section.items.find((item) => item.id === "agents.maxTokensPerChild");
    expect(limit?.currentValue).toBe("Off");
  });

  it("shows a configured token limit formatted compactly", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, maxTokensPerChild: 500_000 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as unknown as SectionProbe;
    const limit = section.items.find((item) => item.id === "agents.maxTokensPerChild");
    expect(limit?.currentValue).toBe("500k");
  });

  it("persists tool-display changes through the real settings dialog flow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-display-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const onConfigApplied = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(
          config,
          loadFabricConfig({ cwd, agentDir, projectTrusted: true }),
        )),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as FabricSettingsComponent;
            component.handleInput("ui");
            component.handleInput("\r");
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput("\r");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
        onConfigApplied,
      });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ ui: { toolDisplay: "full" } });
      expect(fs.existsSync(path.join(cwd, ".omp", "fabric.json"))).toBe(false);
      expect(config.ui.toolDisplay).toBe("full");
      expect(onConfigApplied).toHaveBeenCalledOnce();
      // The saved setting id flows through so consumers can gate downstream
      // refresh work (transcript re-render) on display-affecting sections.
      expect(onConfigApplied).toHaveBeenCalledWith("ui.toolDisplay");
      expect(applyFabricMode).toHaveBeenCalledOnce();
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists trusted-project changes into the project file after Ctrl+G", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-project-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({ fullCodeMode: true }));
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const requestRender = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({ requestRender }, theme, {}, () => {}) as FabricSettingsComponent;
            component.handleInput("\x07");
            component.settingsList.selectItem("fullCodeMode");
            component.settingsList.handleInput("\r");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(requestRender).toHaveBeenCalledOnce();
      expect(
        JSON.parse(fs.readFileSync(path.join(cwd, ".omp", "fabric.json"), "utf8")),
      ).toMatchObject({ fullCodeMode: false });
      expect(
        JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")),
      ).toMatchObject({ fullCodeMode: true });
      expect(applyFabricMode).toHaveBeenCalledOnce();
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits the persisted full-code value instead of its environment override", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-env-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    const inheritedFullCodeMode = process.env.OMP_FABRIC_FULL_CODE_MODE;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({ fullCodeMode: true }));
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    process.env.OMP_FABRIC_FULL_CODE_MODE = "false";
    setAgentDir(agentDir);
    try {
      const location = { cwd, agentDir, projectTrusted: true };
      const config = loadFabricConfig(location);
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig(location))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({ requestRender: vi.fn() }, theme, {}, () => {}) as FabricSettingsComponent;
            component.settingsList.selectItem("fullCodeMode");
            expect(component.settingsList.getSelectedItem()?.currentValue).toBe("true");
            component.settingsList.handleInput("\r");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode: vi.fn(),
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ fullCodeMode: false });
      expect(config.fullCodeMode).toBe(false);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      if (inheritedFullCodeMode === undefined) delete process.env.OMP_FABRIC_FULL_CODE_MODE;
      else process.env.OMP_FABRIC_FULL_CODE_MODE = inheritedFullCodeMode;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps global edits visible when a project override remains effective", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-shadowed-global-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    const inheritedFullCodeMode = process.env.OMP_FABRIC_FULL_CODE_MODE;
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({ fullCodeMode: true }));
    fs.writeFileSync(path.join(cwd, ".omp", "fabric.json"), JSON.stringify({ fullCodeMode: true }));
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    delete process.env.OMP_FABRIC_FULL_CODE_MODE;
    setAgentDir(agentDir);
    try {
      const location = { cwd, agentDir, projectTrusted: true };
      const config = loadFabricConfig(location);
      const applyFabricMode = vi.fn();
      const requestRender = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig(location))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      let globalLines: string[] = [];
      let projectLines: string[] = [];
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({ requestRender }, theme, {}, () => {}) as FabricSettingsComponent;
            expect(component.render(140).join("\n")).toContain(
              "project overrides may remain active here",
            );

            component.handleInput(" ");
            globalLines = [...component.render(120)];
            expect(config.fullCodeMode).toBe(true);

            component.handleInput("\x07");
            projectLines = [...component.render(120)];
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(globalLines.find((line) => line.includes("Full code mode"))).toContain("false");
      expect(projectLines.find((line) => line.includes("Full code mode"))).toContain("true");
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ fullCodeMode: false });
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".omp", "fabric.json"), "utf8")))
        .toMatchObject({ fullCodeMode: true });
      expect(requestRender).toHaveBeenCalledOnce();
      expect(applyFabricMode).toHaveBeenCalledOnce();
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      if (inheritedFullCodeMode === undefined) delete process.env.OMP_FABRIC_FULL_CODE_MODE;
      else process.env.OMP_FABRIC_FULL_CODE_MODE = inheritedFullCodeMode;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists disabling default-on Prewalk as a boolean across reloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-prewalk-disable-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const location = { cwd, agentDir, projectTrusted: true };
      const config = loadFabricConfig(location);
      const applyFabricMode = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig(location))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as FabricSettingsComponent;
            component.settingsList.selectItem("prewalk");
            component.settingsList.handleInput("\r");
            component.settingsList.handleInput("enabled");
            component.settingsList.handleInput("\r");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      const saved = JSON.parse(
        fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"),
      ) as { prewalk?: { enabled?: unknown } };
      expect(fs.existsSync(path.join(cwd, ".omp", "fabric.json"))).toBe(false);
      expect(saved.prewalk?.enabled).toBe(false);
      expect(typeof saved.prewalk?.enabled).toBe("boolean");
      expect(loadFabricConfig(location).prewalk.enabled).toBe(false);
      expect(config.prewalk.enabled).toBe(false);
      expect(applyFabricMode).toHaveBeenCalledOnce();
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a picked Prewalk thinking level through the real settings dialog flow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-thinking-"));
    const agentDir = path.join(cwd, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => {
          const saved = JSON.parse(
            fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"),
          ) as { prewalk?: { thinking?: import("../src/thinking.js").FabricThinking } };
          config.prewalk = {
            ...config.prewalk,
            ...(saved.prewalk?.thinking ? { thinking: saved.prewalk.thinking } : {}),
          };
        }),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      let rootList: SettingsListProbe | undefined;
      const notify = vi.fn();
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify,
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as FabricSettingsComponent;
            rootList = component.settingsList;
            rootList.selectItem("prewalk");
            rootList.handleInput("\r");
            rootList.handleInput("thinking");
            rootList.handleInput("\r");
            for (let steps = 0; steps < 6; steps += 1) rootList.handleInput("\x1b[B");
            rootList.handleInput("\r");
            rootList.handleInput("\x1b");
            rootList.handleInput("\x1b");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(
        JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")),
      ).toMatchObject({
        prewalk: { thinking: "xhigh" },
      });
      expect(config.prewalk.thinking).toBe("xhigh");
      expect(
        rootList?.render(140).join("\n").split("\n").find((line) => line.includes("Prewalk")),
      ).toContain("in-place · Ask each time · XHigh");
      expect(applyFabricMode).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("Fabric settings saved.", "info");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists a picked Prewalk model through the real settings dialog flow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-settings-model-"));
    const agentDir = path.join(cwd, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => {
          const saved = JSON.parse(
            fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"),
          ) as { prewalk?: { mode?: "in-place" | "trajectory"; model?: string; alwaysRearm?: boolean; compactOnReturn?: boolean; detectShellWrites?: boolean; handoffRetirement?: boolean; handoffRetirementKeep?: number } };
          config.prewalk = {
            mode: saved.prewalk?.mode ?? "in-place",
            ...(saved.prewalk?.model ? { model: saved.prewalk.model } : {}),
            alwaysRearm: saved.prewalk?.alwaysRearm === true,
            compactOnReturn: saved.prewalk?.compactOnReturn !== false,
            detectShellWrites: saved.prewalk?.detectShellWrites !== false,
            handoffRetirement: saved.prewalk?.handoffRetirement !== false,
            handoffRetirementKeep: saved.prewalk?.handoffRetirementKeep ?? 3,
          };
        }),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      let rootList: SettingsListProbe | undefined;
      const notify = vi.fn();
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify,
          custom: vi.fn(async (factory) => {
            const component = factory({}, theme, {}, () => {}) as FabricSettingsComponent;
            rootList = component.settingsList;
            rootList.selectItem("prewalk");
            rootList.handleInput("\r");
            rootList.handleInput("model");
            rootList.handleInput("\r");
            rootList.handleInput("\x1b[B");
            rootList.handleInput("\r");
            rootList.handleInput("\x1b");
            rootList.handleInput("\x1b");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(
        JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")),
      ).toMatchObject({
        prewalk: { model: "anthropic/claude-sonnet-4-5" },
      });
      expect(config.prewalk.model).toBe("anthropic/claude-sonnet-4-5");
      expect(
        rootList?.render(140).join("\n").split("\n").find((line) => line.includes("Prewalk")),
      ).toContain("in-place · anthropic/claude-sonnet-4-5");
      expect(applyFabricMode).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("Fabric settings saved.", "info");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});


describe("Fabric RPC settings", () => {
  it("navigates nested sections and persists values through dialog primitives", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-settings-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const notify = vi.fn();
      let openedUi = false;
      let changedDisplay = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig({ cwd, agentDir, projectTrusted: true }))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Fabric settings › UI › Tool display")) {
          changedDisplay = true;
          return options.find((option) => option.startsWith("full"));
        }
        if (title.startsWith("Fabric settings › UI")) {
          if (!changedDisplay) return options.find((option) => option.startsWith("Tool display"));
          return "← Back";
        }
        if (title.startsWith("Fabric settings")) {
          if (!openedUi) {
            openedUi = true;
            return options.find((option) => option.startsWith("UI ·"));
          }
          return "Done";
        }
        return undefined;
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify, select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(select.mock.calls.some(([title]) => String(title).startsWith("Fabric settings › UI"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ ui: { toolDisplay: "full" } });
      expect(fs.existsSync(path.join(cwd, ".omp", "fabric.json"))).toBe(false);
      expect(config.ui.toolDisplay).toBe("full");
      expect(applyFabricMode).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("Fabric settings saved.", "info");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports nested numeric, string, and model pickers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-agents-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      let openedAgents = false;
      let editedDepth = false;
      let editedModel = false;
      let editedVeda = false;
      let editedVedaModel = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig({ cwd, agentDir, projectTrusted: true }))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Fabric settings › Agents › Default model")) {
          editedModel = true;
          return options.find((option) => option.startsWith("gpt-5.5"));
        }
        if (title.startsWith("Fabric settings › Agents")) {
          if (!editedDepth) return options.find((option) => option.startsWith("Max depth"));
          if (!editedModel) return options.find((option) => option.startsWith("Default model"));
          if (!editedVeda) return options.find((option) => option.startsWith("Veda backend"));
          if (!editedVedaModel) return options.find((option) => option.startsWith("Veda model"));
          return "← Back";
        }
        if (title.startsWith("Fabric settings")) {
          if (!openedAgents) {
            openedAgents = true;
            return options.find((option) => option.startsWith("Agents ·"));
          }
          return "Done";
        }
        return undefined;
      });
      const input = vi.fn(async (title: string) => {
        if (title.startsWith("Fabric settings › Agents › Max depth")) {
          editedDepth = true;
          return "64";
        }
        if (title.startsWith("Fabric settings › Agents › Veda backend")) {
          editedVeda = true;
          return "codex";
        }
        if (title.startsWith("Fabric settings › Agents › Veda model")) {
          editedVedaModel = true;
          return "false";
        }
        return undefined;
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input, custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({
          agents: {
            maxDepth: 64,
            model: "openai/gpt-5.5",
            veda: { backend: "codex", model: "false" },
          },
        });
      expect(config.agents.maxDepth).toBe(64);
      expect(config.agents.model).toBe("openai/gpt-5.5");
      expect(config.agents.veda).toMatchObject({ backend: "codex", model: "false" });
      expect(input).toHaveBeenCalledTimes(3);
      expect(applyFabricMode).toHaveBeenCalledOnce();
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits nested tool allowlists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-list-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      let openedAgents = false;
      let openedTools = false;
      let toggled = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig({ cwd, agentDir, projectTrusted: true }))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Fabric settings › Agents › Default tools › find")) {
          toggled = true;
          return options.find((option) => option.startsWith("false"));
        }
        if (title.startsWith("Fabric settings › Agents › Default tools")) {
          if (!toggled) return options.find((option) => option.startsWith("find ·"));
          return "← Back";
        }
        if (title.startsWith("Fabric settings › Agents")) {
          if (!openedTools) {
            openedTools = true;
            return options.find((option) => option.startsWith("Default tools"));
          }
          return "← Back";
        }
        if (!openedAgents) {
          openedAgents = true;
          return options.find((option) => option.startsWith("Agents ·"));
        }
        return "Done";
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode: vi.fn(),
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(config.agents.defaultTools).toContain("read");
      expect(config.agents.defaultTools).not.toContain("find");
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ agents: { defaultTools: expect.not.arrayContaining(["find"]) } });
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits the active model compaction threshold", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-compaction-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      let openedCompaction = false;
      let changed = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig({ cwd, agentDir, projectTrusted: true }))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Fabric settings › Compaction › Threshold")) {
          return options.find((option) => option.startsWith("Custom percent"));
        }
        if (title.startsWith("Fabric settings › Compaction")) {
          if (!changed) return options.find((option) => option.startsWith("Threshold"));
          return "← Back";
        }
        if (!openedCompaction) {
          openedCompaction = true;
          return options.find((option) => option.startsWith("Compaction ·"));
        }
        return "Done";
      });
      const input = vi.fn(async () => {
        changed = true;
        return "73";
      });
      const context = {
        mode: "rpc",
        cwd,
        model: { provider: "openai", id: "gpt-5.5" },
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input, custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode: vi.fn(),
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(config.compaction.thresholds["openai/gpt-5.5"]).toBe(0.73);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8")))
        .toMatchObject({ compaction: { thresholds: { "openai/gpt-5.5": 0.73 } } });
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("switches trusted projects to project save scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-scope-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    const inheritedFullCodeMode = process.env.OMP_FABRIC_FULL_CODE_MODE;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    delete process.env.OMP_FABRIC_FULL_CODE_MODE;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      let switched = false;
      let edited = false;
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(config, loadFabricConfig({ cwd, agentDir, projectTrusted: true }))),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title.startsWith("Fabric settings › Full code mode")) {
          edited = true;
          return options.find((option) => option.startsWith("false"));
        }
        if (!switched) {
          switched = true;
          return options.find((option) => option.startsWith("Switch save scope"));
        }
        if (!edited) return options.find((option) => option.startsWith("Full code mode"));
        return "Done";
      });
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".omp", "fabric.json"), "utf8")))
        .toMatchObject({ fullCodeMode: false });
      expect(fs.existsSync(path.join(agentDir, "fabric.json"))).toBe(false);
      expect(select.mock.calls.some(([title]) => String(title).includes("Global defaults"))).toBe(true);
      expect(select.mock.calls.some(([title]) => String(title).includes("Project overrides"))).toBe(true);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      if (inheritedFullCodeMode === undefined) delete process.env.OMP_FABRIC_FULL_CODE_MODE;
      else process.env.OMP_FABRIC_FULL_CODE_MODE = inheritedFullCodeMode;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a boolean, a count, a duration, a byte size, and a map through newly exposed rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-rpc-shapes-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.OMP_FABRIC_AGENT_DIR;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    process.env.OMP_FABRIC_AGENT_DIR = agentDir;
    setAgentDir(agentDir);
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => Object.assign(
          config,
          loadFabricConfig({ cwd, agentDir, projectTrusted: true }),
        )),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      const script = [
        "Memory \u00b7",
        "Index thinking",
        "false",
        "\u2190 Back",
        "Speculation \u00b7",
        "Max entries",
        "128",
        "\u2190 Back",
        "Speculation \u00b7",
        "Entry TTL",
        "5m",
        "\u2190 Back",
        "Mesh \u00b7",
        "Max event bytes",
        "512 KB",
        "\u2190 Back",
        "Executor \u00b7",
        "Per-ref floors",
        "\u2190 Back",
        "Done",
      ];
      const select = vi.fn(async (_title: string, options: string[]) => {
        const step = script.shift();
        expect(step, "the settings script ran out of steps").toBeDefined();
        const match = options.find((option) => option.startsWith(step as string));
        expect(match, `no row starting with ${step as string}`).toBeDefined();
        return match;
      });
      const input = vi.fn(async () => "extensions.subagent=5m");
      const context = {
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: { theme, notify: vi.fn(), select, input, custom: vi.fn() },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode: vi.fn(),
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(script).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"))).toMatchObject({
        memory: { indexThinking: false },
        speculation: { maxEntries: 128, entryTtlMs: 300_000 },
        mesh: { maxEventBytes: 524_288 },
        executor: { hostCallTimeouts: { "extensions.subagent": 300_000 } },
      });

      const loaded = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
      expect(loaded.memory.indexThinking).toBe(false);
      expect(loaded.speculation.maxEntries).toBe(128);
      expect(loaded.speculation.entryTtlMs).toBe(300_000);
      expect(loaded.mesh.maxEventBytes).toBe(524_288);
      expect(loaded.executor.hostCallTimeouts["extensions.subagent"]).toBe(300_000);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
      else process.env.OMP_FABRIC_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
