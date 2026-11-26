import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { INHERIT_VALUE, modelKey, sortByLastUsed, type ModelLike, type ModelSource } from "./model-picker.js";
import { keyEvents } from "./keys.js";
import type { FabricRows } from "./render-types.js";

/** A single pickable row in the Fabric model selector. */
interface ModelEntry {
  /** Value persisted to fabric.json: "Inherit" or `provider/id`. */
  value: string;
  /** Main text shown for the row (the model id, or "Inherit"). */
  id: string;
  /** Provider badge shown after the id; empty for the Inherit row. */
  provider: string;
  /** Human-readable name shown in the footer line. */
  name: string;
  /** Whether this is a real model (vs. the Inherit sentinel). */
  isModel: boolean;
}

class SearchInputRow implements FabricRows {
  private query = "";
  private caret = 0;
  focused = true;

  getValue(): string {
    return this.query;
  }

  /** Apply one decoded key; returns true when the query text changed. */
  handleKey(event: KeyEvent): boolean {
    if (event.kind === "release") return false;
    const length = this.query.length;
    if (event.id === "left") {
      this.caret = Math.max(0, this.caret - 1);
      return false;
    }
    if (event.id === "right") {
      this.caret = Math.min(length, this.caret + 1);
      return false;
    }
    if (event.id === "home") {
      this.caret = 0;
      return false;
    }
    if (event.id === "end") {
      this.caret = length;
      return false;
    }
    if (event.id === "backspace") {
      if (this.caret === 0) return false;
      this.query = this.query.slice(0, this.caret - 1) + this.query.slice(this.caret);
      this.caret--;
      return true;
    }
    if (event.id === "delete") {
      if (this.caret >= length) return false;
      this.query = this.query.slice(0, this.caret) + this.query.slice(this.caret + 1);
      return true;
    }
    if (event.text) {
      this.query =
        this.query.slice(0, this.caret) + event.text + this.query.slice(this.caret);
      this.caret += event.text.length;
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    return [truncate(`> ${this.query}`, width, "")];
  }
}

export interface FabricModelSelectorChoice {
  value: string;
  label: string;
  description: string;
  current: boolean;
}

export interface FabricModelSelectorOptions {
  theme: Theme;
  source: ModelSource;
  /** The currently configured canonical model key or "Inherit". */
  currentValue: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  /** Header line above the search input. Defaults to the global-default wording. */
  headerText?: string;
  /** Label shown for the unset/default row. Defaults to Inherit. */
  inheritLabel?: string;
  /** Description shown for the unset/default row's footer name. */
  inheritName?: string;
}

/**
 * A /model-style searchable model picker adapted for Fabric: same look
 * (search input, list with `[provider]` badges and a ✓ on
 * the current row, scroll indicator, and a "Model Name:" footer) but it writes
 * the Fabric default-model setting instead of the host's default model, and
 * pins an unset/default row on top. Order respects pi-model-sort (most recently
 * used first); search filters by fuzzy match and re-sorts by recency, matching
 * pi-model-sort's patched /model behavior.
 */
export class FabricModelSelector implements FabricRows {
  private readonly theme: Theme;
  private readonly allEntries: ModelEntry[];
  private filteredEntries: ModelEntry[];
  private readonly lastUsed: Record<string, number>;
  private readonly currentKey: string | null;
  private readonly currentValue: string;
  private selectedIndex = 0;
  private readonly searchInput = new SearchInputRow();
  private readonly onSelectCallback: (value: string) => void;
  private readonly onCancelCallback: () => void;
  private readonly headerText: string;
  private readonly inheritLabel: string;
  private readonly inheritName: string;
  private _focused = false;

  constructor(options: FabricModelSelectorOptions) {
    this.theme = options.theme;
    this.lastUsed = options.source.lastUsed;
    this.currentValue = options.currentValue;
    this.currentKey = options.currentValue === INHERIT_VALUE ? null : options.currentValue;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.headerText =
      options.headerText ??
      "Default model for Fabric agents and actors. Pick Inherit to use the host session's model.";
    this.inheritLabel = options.inheritLabel ?? INHERIT_VALUE;
    this.inheritName = options.inheritName ?? "Use the host session's default model";

    this.allEntries = this.buildEntries(options.source.models);
    this.filteredEntries = this.allEntries;
    const current = this.allEntries.findIndex((entry) => entry.value === this.currentValue);
    this.selectedIndex = current >= 0 ? current : 0;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    let queryChanged = false;
    for (const event of keyEvents(keyData)) {
      if (event.kind === "release") continue;
      if (kb.matches(event, "tui.select.up")) {
        if (this.filteredEntries.length === 0) continue;
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filteredEntries.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(event, "tui.select.down")) {
        if (this.filteredEntries.length === 0) continue;
        this.selectedIndex =
          this.selectedIndex === this.filteredEntries.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (kb.matches(event, "tui.select.confirm")) {
        const entry = this.filteredEntries[this.selectedIndex];
        if (entry) this.handleSelect(entry);
      } else if (kb.matches(event, "tui.select.cancel")) {
        this.onCancelCallback();
      } else if (this.searchInput.handleKey(event)) {
        queryChanged = true;
      }
    }
    if (queryChanged) this.filterModels(this.searchInput.getValue());
  }

  rpcChoices(): FabricModelSelectorChoice[] {
    return this.allEntries.map((entry) => ({
      value: entry.value,
      label: entry.id,
      description: entry.isModel ? `${entry.provider} · ${entry.name}` : entry.name,
      current: entry.value === this.currentValue,
    }));
  }

  selectRpc(value: string): boolean {
    const entry = this.allEntries.find((candidate) => candidate.value === value);
    if (!entry) return false;
    this.handleSelect(entry);
    return true;
  }

  private handleSelect(entry: ModelEntry): void {
    this.onSelectCallback(entry.value);
  }

  private buildEntries(models: ModelLike[]): ModelEntry[] {
    const sorted = sortByLastUsed(models, this.lastUsed, this.currentKey);
    const inherit: ModelEntry = {
      value: INHERIT_VALUE,
      id: this.inheritLabel,
      provider: "",
      name: this.inheritName,
      isModel: false,
    };
    const modelEntries: ModelEntry[] = sorted.map((model) => ({
      value: modelKey(model.provider, model.id),
      id: model.id,
      provider: model.provider,
      name: model.name ?? model.id,
      isModel: true,
    }));
    return [inherit, ...modelEntries];
  }

  /** Filter by fuzzy match, then re-sort by recency (mirrors pi-model-sort). */
  private sortEntries(entries: ModelEntry[]): ModelEntry[] {
    const inherit = entries.find((entry) => !entry.isModel);
    const models = entries.filter((entry) => entry.isModel);
    const sorted = sortByLastUsed(
      models.map((entry) => ({ provider: entry.provider, id: entry.id, entry })),
      this.lastUsed,
      this.currentKey,
    ).map((item) => item.entry);
    return inherit ? [inherit, ...sorted] : sorted;
  }

  private filterModels(query: string): void {
    const matches = query.trim()
      ? fuzzyFilter(this.allEntries, query, (entry) => this.searchText(entry))
      : this.allEntries;
    this.filteredEntries = this.sortEntries(matches);
    const current = this.filteredEntries.findIndex((entry) => entry.value === this.currentValue);
    this.selectedIndex =
      current >= 0
        ? current
        : Math.min(this.selectedIndex, Math.max(0, this.filteredEntries.length - 1));
  }

  /** Mirrors getModelSelectorSearchText from OMP's /model selector. */
  private searchText(entry: ModelEntry): string {
    if (!entry.isModel) return `${entry.id} ${entry.name}`;
    return `${entry.provider} ${entry.provider}/${entry.id} ${entry.provider} ${entry.id} ${entry.name}`;
  }

  render(width: number): string[] {
    const rows = [
      truncate(this.theme.fg("muted", this.headerText), width, ""),
      "",
      ...this.searchInput.render(width),
      "",
    ];
    const maxVisible = 10;
    const total = this.filteredEntries.length;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), total - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, total);
    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.filteredEntries[i];
      if (!entry) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = entry.value === this.currentValue;
      const badge = entry.provider ? ` ${this.theme.fg("muted", `[${entry.provider}]`)}` : "";
      const check = isCurrent ? this.theme.fg("success", " ✓") : "";
      const line = isSelected
        ? `${this.theme.fg("accent", "\u2192 ")}${this.theme.fg("accent", entry.id)}${badge}${check}`
        : `  ${entry.id}${badge}${check}`;
      rows.push(truncate(line, width, ""));
    }
    if (startIndex > 0 || endIndex < total) {
      rows.push(truncate(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), width, ""));
    }
    if (total === 0) {
      rows.push(truncate(this.theme.fg("muted", "  No matching models"), width, ""));
    } else {
      const selected = this.filteredEntries[this.selectedIndex];
      rows.push("");
      rows.push(
        truncate(
          this.theme.fg("muted", `  Model Name: ${selected ? selected.name : ""}`),
          width,
          "",
        ),
      );
    }
    return rows;
  }
}
