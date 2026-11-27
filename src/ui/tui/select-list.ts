import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { widgetKeyMatches } from "@oh-my-pi/pi-tui/term/keymap";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { decodeTerminalInput } from "./input.js";
import type { Rows } from "./view.js";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectListLayout {
  minPrimaryColumnWidth?: number;
  maxPrimaryColumnWidth?: number;
}

const CURSOR = "→ ";

export class SelectList implements Rows {
  onSelect: ((item: SelectItem) => void) | undefined;
  onCancel: (() => void) | undefined;
  private selectedIndex = 0;

  constructor(
    private readonly items: readonly SelectItem[],
    private readonly maxVisible: number,
    private readonly theme: Theme,
    private readonly layout: SelectListLayout = {},
  ) {}

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }

  getSelectedItem(): SelectItem | undefined {
    return this.items[this.selectedIndex];
  }

  handleInput(data: string): void {
    for (const event of decodeTerminalInput(data)) {
      if (event.type !== "key") continue;
      const key = event.key;
      const count = this.items.length;
      if (widgetKeyMatches(key, "select.cancel")) this.onCancel?.();
      else if (count === 0) continue;
      else if (widgetKeyMatches(key, "select.up")) this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      else if (widgetKeyMatches(key, "select.down")) this.selectedIndex = (this.selectedIndex + 1) % count;
      else if (widgetKeyMatches(key, "select.pageUp")) this.setSelectedIndex(this.selectedIndex - this.pageSize());
      else if (widgetKeyMatches(key, "select.pageDown")) this.setSelectedIndex(this.selectedIndex + this.pageSize());
      else if (widgetKeyMatches(key, "select.confirm")) {
        const item = this.items[this.selectedIndex];
        if (item) this.onSelect?.(item);
      }
    }
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [this.theme.fg("muted", "  No matching items")];
    const visible = this.pageSize();
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.items.length - visible));
    const end = Math.min(this.items.length, start + visible);
    const labelWidth = this.labelColumnWidth();
    const rows: string[] = [];
    for (let index = start; index < end; index++) {
      const item = this.items[index]!;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", CURSOR) : " ".repeat(CURSOR.length);
      const label = truncate(item.label, labelWidth);
      const styledLabel = selected ? this.theme.fg("accent", label) : label;
      const room = width - CURSOR.length - labelWidth - 2;
      const description = item.description && room > 4
        ? this.theme.fg("muted", `  ${truncate(item.description, room)}`)
        : "";
      rows.push(truncate(`${prefix}${description ? padTo(styledLabel, labelWidth) : styledLabel}${description}`, width));
    }
    if (start > 0 || end < this.items.length) {
      rows.push(this.theme.fg("muted", truncate(`  (${this.selectedIndex + 1}/${this.items.length})`, width, "")));
    }
    return rows;
  }

  private pageSize(): number {
    return Math.max(1, Math.min(this.maxVisible, this.items.length));
  }

  private labelColumnWidth(): number {
    const widest = Math.max(0, ...this.items.map((item) => visibleWidth(item.label)));
    const min = this.layout.minPrimaryColumnWidth ?? 0;
    const max = this.layout.maxPrimaryColumnWidth ?? 32;
    return Math.max(min, Math.min(max, widest));
  }
}
