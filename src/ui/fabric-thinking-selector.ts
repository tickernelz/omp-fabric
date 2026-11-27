import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { INHERIT_VALUE } from "./model-picker.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";
import { BlankRows, Stack, TextBlock } from "./tui/rows.js";
import { type SelectItem, SelectList } from "./tui/select-list.js";
import type { FabricView } from "./tui/view.js";

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
 */
export class FabricThinkingSelector extends Stack implements FabricView {
  private readonly selectList: SelectList;

  constructor(options: FabricThinkingSelectorOptions) {
    super();
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

    this.add(new TextBlock(options.theme.fg("muted", headerText)));
    this.add(new BlankRows(1));
    this.selectList = new SelectList(items, items.length, options.theme, {
      minPrimaryColumnWidth: 8,
      maxPrimaryColumnWidth: 24,
    });
    if (startIndex >= 0) this.selectList.setSelectedIndex(startIndex);
    this.selectList.onSelect = (item) => options.onSelect(item.value);
    this.selectList.onCancel = options.onCancel;
    this.add(this.selectList);
    this.add(new BlankRows(1));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
