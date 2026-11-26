import { getKeybindings, type Theme } from "@oh-my-pi/pi-coding-agent";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { INHERIT_VALUE } from "./model-picker.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";
import { keyEvents } from "./keys.js";
import type { FabricRows } from "./render-types.js";

const MIN_PRIMARY_COLUMN_WIDTH = 8;
const MAX_PRIMARY_COLUMN_WIDTH = 24;

interface ThinkingItem {
  value: string;
  label: string;
  description?: string;
}

export interface FabricThinkingSelectorOptions {
  theme: Theme;
  /** The actor's current thinking level, or INHERIT_VALUE for "use the Fabric default". */
  currentValue: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  headerText?: string;
  inheritName?: string;
}

/**
 * A compact picker for an actor's thinking (reasoning effort) level. Pins an
 * "Inherit" row on top (use the Fabric default) followed by the seven OMP
 * thinking levels in order. The current value is marked with a trailing check.
 * Mirrors the look of FabricModelSelector with a small fixed list.
 */
export class FabricThinkingSelector implements FabricRows {
  private readonly theme: Theme;
  private readonly items: ThinkingItem[];
  private readonly primaryWidth: number;
  private readonly headerText: string;
  private readonly onSelectCallback: (value: string) => void;
  private readonly onCancelCallback: () => void;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricThinkingSelectorOptions) {
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.headerText =
      options.headerText ?? "Thinking level for this actor. Pick Inherit to use the Fabric default.";
    const inheritName = options.inheritName ?? "Use the Fabric default thinking level";
    this.items = [
      {
        value: INHERIT_VALUE,
        label: `Inherit${options.currentValue === INHERIT_VALUE ? " ✓" : ""}`,
        description: inheritName,
      },
      ...THINKING_LEVELS.map((level) => ({
        value: level,
        label: `${thinkingLabel(level)}${options.currentValue === level ? " ✓" : ""}`,
      })),
    ];
    const startIndex = this.items.findIndex((item) => item.value === options.currentValue);
    this.selectedIndex = startIndex >= 0 ? startIndex : 0;
    const longest = Math.max(...this.items.map((item) => visibleWidth(item.label)));
    this.primaryWidth = Math.min(
      MAX_PRIMARY_COLUMN_WIDTH,
      Math.max(MIN_PRIMARY_COLUMN_WIDTH, longest),
    );
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    for (const event of keyEvents(data)) {
      if (event.kind === "release") continue;
      if (kb.matches(event, "tui.select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(event, "tui.select.down")) {
        this.selectedIndex =
          this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (kb.matches(event, "tui.select.confirm")) {
        const item = this.items[this.selectedIndex];
        if (item) this.onSelectCallback(item.value);
      } else if (kb.matches(event, "tui.select.cancel")) {
        this.onCancelCallback();
      }
    }
  }

  render(width: number): string[] {
    const rows = [truncate(this.theme.fg("muted", this.headerText), width, ""), ""];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const selected = index === this.selectedIndex;
      const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      const padding = " ".repeat(Math.max(0, this.primaryWidth - visibleWidth(item.label)));
      const description = item.description
        ? ` ${this.theme.fg("muted", item.description)}`
        : "";
      rows.push(truncate(`${marker}${label}${padding}${description}`, width, ""));
    }
    rows.push("");
    return rows;
  }
}
