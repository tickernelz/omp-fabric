import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { Ellipsis } from "@oh-my-pi/pi-tui";
import {
  Container,
  type Focusable,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  Spacer,
  Text,
} from "@oh-my-pi/pi-tui";
import { INHERIT_VALUE } from "./model-picker.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";

const LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 8,
  maxPrimaryColumnWidth: 24,
};

const selectListTheme = (theme: Theme): SelectListTheme => ({
  symbols: (theme as Theme & { symbols: import("@oh-my-pi/pi-tui").SymbolTheme }).symbols,
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

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
 * Mirrors the look of FabricModelSelector but uses pi-tui's SelectList since
 * the level set is small and fixed (no fuzzy search needed).
 */
export class FabricThinkingSelector extends Container implements Focusable {
  private readonly selectList: SelectList;
  private readonly onSelectCallback: (value: string) => void;
  focused = false;

  constructor(options: FabricThinkingSelectorOptions) {
    super();
    this.onSelectCallback = options.onSelect;
    const headerText =
      options.headerText ?? "Thinking level for this actor. Pick Inherit to use the Fabric default.";
    const inheritName = options.inheritName ?? "Use the Fabric default thinking level";
    const items: SelectItem[] = [
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
    const startIndex = items.findIndex((item) => item.value === options.currentValue);

    this.addChild(new Text(options.theme.fg("muted", headerText), 0, 0));
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(items, items.length, selectListTheme(options.theme), LAYOUT);
    if (startIndex >= 0) this.selectList.setSelectedIndex(startIndex);
    this.selectList.onSelect = (item) => this.onSelectCallback(item.value);
    this.selectList.onCancel = options.onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
