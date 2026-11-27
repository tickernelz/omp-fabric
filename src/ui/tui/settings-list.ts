import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { widgetKeyMatches } from "@oh-my-pi/pi-tui/term/keymap";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
import { decodeTerminalInput, typedText } from "./input.js";
import type { FabricView } from "./view.js";

export type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => FabricView;

export interface SettingItem {
  id: string;
  label: string;
  currentValue: string;
  description?: string;
  values?: string[];
  submenu?: SettingsSubmenu;
}

interface SettingsListOptions {
  typeToSearch?: boolean;
}

const CURSOR = "→ ";
const LABEL_MAX = 40;

export class SettingsList implements FabricView {
  private selectedIndex = 0;
  private query = "";
  private submenu: FabricView | undefined;

  constructor(
    private readonly items: SettingItem[],
    private readonly maxVisible: number,
    private readonly theme: Theme,
    private readonly onChange: (id: string, newValue: string) => void,
    private readonly onCancel: () => void,
    private readonly options: SettingsListOptions = {},
  ) {}

  getSelectedItem(): SettingItem | undefined {
    return this.visibleItems()[this.selectedIndex];
  }

  selectItem(id: string): boolean {
    this.query = "";
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.selectedIndex = index;
    return true;
  }

  updateValue(id: string, value: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) item.currentValue = value;
  }

  handleInput(data: string): void {
    for (const event of decodeTerminalInput(data)) {
      if (this.submenu) {
        this.submenu.handleInput?.(event.type === "paste" ? `\x1b[200~${event.text}\x1b[201~` : event.key.raw);
        continue;
      }
      if (event.type === "paste") {
        if (this.options.typeToSearch) this.setQuery(this.query + event.text.replace(/\s+/g, " "));
        continue;
      }
      const key = event.key;
      const count = this.visibleItems().length;
      if (widgetKeyMatches(key, "select.cancel")) {
        if (this.query !== "") this.setQuery("");
        else this.onCancel();
      } else if (widgetKeyMatches(key, "select.up")) {
        if (count > 0) this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      } else if (widgetKeyMatches(key, "select.down")) {
        if (count > 0) this.selectedIndex = (this.selectedIndex + 1) % count;
      } else if (widgetKeyMatches(key, "select.pageUp")) {
        this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize());
      } else if (widgetKeyMatches(key, "select.pageDown")) {
        this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + this.pageSize()));
      } else if (widgetKeyMatches(key, "select.confirm") || (key.id === "space" && this.query === "")) {
        this.activate();
      } else if (this.options.typeToSearch && widgetKeyMatches(key, "editor.deleteCharBackward")) {
        if (this.query !== "") this.setQuery(Array.from(this.query).slice(0, -1).join(""));
      } else if (this.options.typeToSearch) {
        const typed = typedText(key);
        if (typed !== undefined) this.setQuery(this.query + typed);
      }
    }
  }

  render(width: number): string[] {
    if (this.submenu) return [...this.submenu.render(width)];
    const items = this.visibleItems();
    const rows: string[] = [];
    if (this.query !== "") rows.push(truncate(`${this.theme.fg("muted", "Search: ")}${this.query}`, width));
    if (items.length === 0) {
      rows.push(this.theme.fg("muted", this.items.length === 0 ? "  No settings available" : "  No matching settings"));
      return rows;
    }
    const visible = this.pageSize();
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), items.length - visible));
    const end = Math.min(items.length, start + visible);
    const labelWidth = Math.min(LABEL_MAX, Math.max(...items.map((item) => visibleWidth(item.label))));
    for (let index = start; index < end; index++) {
      const item = items[index]!;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", CURSOR) : " ".repeat(CURSOR.length);
      const label = padTo(truncate(item.label, labelWidth), labelWidth);
      const valueRoom = Math.max(1, width - CURSOR.length - labelWidth - 2);
      const value = truncate(item.currentValue, valueRoom);
      rows.push(truncate(
        `${prefix}${selected ? this.theme.fg("accent", label) : label}  ${this.theme.fg(selected ? "accent" : "muted", value)}`,
        width,
      ));
    }
    if (start > 0 || end < items.length) {
      rows.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`));
    }
    const description = items[this.selectedIndex]?.description;
    if (description) {
      rows.push("");
      for (const line of wrap(description, Math.max(1, width - 2))) rows.push(this.theme.fg("dim", `  ${line}`));
    }
    rows.push("");
    rows.push(this.theme.fg("dim", truncate(this.hint(), width)));
    return rows;
  }

  private hint(): string {
    return this.options.typeToSearch
      ? "  Enter/Space to change · Type to search · Esc to cancel"
      : "  Enter/Space to change · Esc to cancel";
  }

  private pageSize(): number {
    return Math.max(1, this.maxVisible);
  }

  private visibleItems(): SettingItem[] {
    const query = this.query.trim();
    return query === ""
      ? this.items
      : fuzzyFilter(this.items, query, (item) =>
        `${item.label} ${item.id} ${item.currentValue} ${item.description ?? ""} ${(item.values ?? []).join(" ")}`);
  }

  private setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }

  private activate(): void {
    const item = this.getSelectedItem();
    if (!item) return;
    if (item.values && item.values.length > 0) {
      const index = item.values.indexOf(item.currentValue);
      const next = item.values[(index + 1) % item.values.length]!;
      item.currentValue = next;
      this.onChange(item.id, next);
      return;
    }
    if (!item.submenu) return;
    this.submenu = item.submenu(item.currentValue, (selectedValue) => {
      this.submenu?.dispose?.();
      this.submenu = undefined;
      if (selectedValue === undefined) return;
      item.currentValue = selectedValue;
      this.onChange(item.id, selectedValue);
    });
  }
}
