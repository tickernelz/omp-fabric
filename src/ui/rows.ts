// Rows-object stand-ins for the pi-tui widgets 19.2 removed. Keyboard input is
// decoded with the reactive driver; drawing stays `render(width): string[]`
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
export { truncate, visibleWidth, wrap };
import { getKeybindings, type Keybinding, type KeybindingsManager, type Theme } from "@oh-my-pi/pi-coding-agent";

export interface RowsView {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export type Component = RowsView;


export function clip(text: string, width: number, ellipsis = "…"): string {
  return truncate(text, Math.max(0, width), ellipsis);
}

export interface HostSurface {
  requestRender(): void;
  terminal?: { rows?: number; columns?: number; write?(data: string): void };
  imageBudget?: unknown;
}

export function emphasis(theme: Theme, text: string): string {
  if (typeof theme.style === "function") return theme.style("strong", text);
  if ("bold" in theme && typeof theme.bold === "function") return theme.bold(text);
  return text;
}

export function keyPresses(data: string): KeyEvent[] {
  const presses: KeyEvent[] = [];
  for (const event of decodeInput(data)) {
    if (event.type === "key" && event.key.kind !== "release") presses.push(event.key);
  }
  return presses;
}

export function keyIs(data: string, id: string): boolean {
  const presses = keyPresses(data);
  return presses.length === 1 && presses[0]?.id === id;
}

export function actionIs(key: KeyEvent, action: Keybinding): boolean {
  return getKeybindings().matches(key, action);
}

export function keysFor(action: Keybinding): string[] {
  return [...getKeybindings().keysFor(action)];
}

export function hostMatches(data: string, action: Keybinding): boolean {
  const presses = keyPresses(data);
  const key = presses.length === 1 ? presses[0] : undefined;
  return key ? getKeybindings().matches(key, action) : false;
}

/** The host's key bindings matched against raw input, for views injected with a manager. */
export interface RawKeybindings {
  matches(data: string, action: Keybinding): boolean;
  getKeys(action: Keybinding): string[];
}

export function rawKeybindings(manager: KeybindingsManager): RawKeybindings {
  return {
    matches(data, action) {
      const presses = keyPresses(data);
      const key = presses.length === 1 ? presses[0] : undefined;
      return key ? manager.matches(key, action) : false;
    },
    getKeys(action) {
      return [...manager.keysFor(action)];
    },
  };
}

/** Zero-width marker so a rows editor can scroll the caret line into view. */
export const EDITOR_CURSOR = "\u001b_omp-cursor\u0007";

export class PromptEditor implements RowsView {
  focused = false;
  onChange?: (text: string) => void;
  /** Enter submits when set; otherwise the owner handles Enter itself. */
  onSubmit?: (text: string) => void;

  invalidate(): void { }
  #value = "";
  #cursor = 0;

  getText(): string {
    return this.#value;
  }

  setText(text: string): void {
    if (text === this.#value && this.#cursor === text.length) return;
    this.#value = text;
    this.#cursor = text.length;
    this.onChange?.(text);
  }

  handleInput(data: string): void {
    let changed = false;
    for (const key of keyPresses(data)) {
      if (key.id === "backspace" || key.id === "ctrl+h") {
        if (this.#cursor === 0) continue;
        this.#value = this.#value.slice(0, this.#cursor - 1) + this.#value.slice(this.#cursor);
        this.#cursor -= 1;
        changed = true;
        continue;
      }
      if (key.id === "left") {
        this.#cursor = Math.max(0, this.#cursor - 1);
        continue;
      }
      if (key.id === "right") {
        this.#cursor = Math.min(this.#value.length, this.#cursor + 1);
        continue;
      }
      if (key.id === "shift+enter") {
        this.#value = this.#value.slice(0, this.#cursor) + "\n" + this.#value.slice(this.#cursor);
        this.#cursor += 1;
        changed = true;
        continue;
      }
      if (key.id === "enter") {
        if (changed) this.onChange?.(this.#value);
        changed = false;
        this.onSubmit?.(this.#value);
        continue;
      }
      if (key.id === "escape") continue;
      const text = key.id === "space" ? " " : key.text;
      if (!text) continue;
      this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
      this.#cursor += text.length;
      changed = true;
    }
    if (changed) this.onChange?.(this.#value);
  }

  render(width: number): readonly string[] {
    // Only the focused editor owns the caret; an unfocused one must not claim it.
    const caret = this.focused ? EDITOR_CURSOR : "";
    const text = this.#value.slice(0, this.#cursor) + caret + this.#value.slice(this.#cursor);
    return text.split("\n").map((line) => clip(line, Math.max(0, width), ""));
  }
}

export class Text implements RowsView {
  #text: string;
  readonly #paddingX: number;
  readonly #paddingY: number;

  constructor(text = "", paddingX = 1, paddingY = 1) {
    this.#text = text;
    this.#paddingX = paddingX;
    this.#paddingY = paddingY;
  }

  getText(): string {
    return this.#text;
  }

  setText(text: string): void {
    this.#text = text;
  }

  render(width: number): readonly string[] {
    const inner = Math.max(1, width - this.#paddingX * 2);
    const pad = " ".repeat(Math.min(this.#paddingX, Math.max(0, width)));
    const wrapped = this.#text.length === 0 ? [""] : wrap(this.#text, inner);
    const blank = " ".repeat(Math.max(0, width));
    const body = wrapped.map((line) => truncate(pad + line, Math.max(0, width), ""));
    const vertical = Array.from({ length: this.#paddingY }, () => blank);
    return [...vertical, ...body, ...vertical];
  }
}

export class Spacer implements RowsView {
  readonly #lines: number;

  constructor(lines = 1) {
    this.#lines = lines;
  }

  render(width: number): readonly string[] {
    return Array.from({ length: this.#lines }, () => " ".repeat(Math.max(0, width)));
  }
}

export class Container implements RowsView {
  readonly children: RowsView[] = [];

  addChild(child: RowsView): void {
    this.children.push(child);
  }

  clear(): void {
    this.children.length = 0;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): readonly string[] {
    const lines: string[] = [];
    for (const child of this.children) lines.push(...child.render(width));
    return lines;
  }
}

export class Input implements RowsView {
  focused = false;
  onSubmit?: (value: string) => void;
  invalidate(): void {}
  onEscape?: () => void;
  #value = "";

  getValue(): string {
    return this.#value;
  }

  setValue(value: string): void {
    this.#value = value;
  }

  handleInput(data: string): void {
    for (const key of keyPresses(data)) {
      if (key.id === "enter") {
        this.onSubmit?.(this.#value);
        continue;
      }
      if (key.id === "escape" || key.id === "ctrl+c") {
        this.onEscape?.();
        continue;
      }
      if (key.id === "backspace" || key.id === "ctrl+h") {
        this.#value = this.#value.slice(0, -1);
        continue;
      }
      if (key.text && key.id !== "space") this.#value += key.text;
      else if (key.id === "space") this.#value += " ";
    }
  }

  render(width: number): readonly string[] {
    return [truncate(this.#value, Math.max(0, width), "")];
  }
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
  symbols?: unknown;
}

export interface SelectListLayoutOptions {
  minPrimaryColumnWidth?: number;
  maxPrimaryColumnWidth?: number;
}

export class SelectList implements RowsView {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  #items: readonly SelectItem[];
  #selected = 0;
  readonly #theme: SelectListTheme;

  constructor(
    items: readonly SelectItem[],
    _maxVisible: number,
    theme: SelectListTheme,
    _layout?: SelectListLayoutOptions,
  ) {
    this.#items = items;
    this.#theme = theme;
  }

  setSelectedIndex(index: number): void {
    if (index >= 0 && index < this.#items.length) this.#selected = index;
  }

  getSelectedItem(): SelectItem | undefined {
    return this.#items[this.#selected];
  }

  handleInput(data: string): void {
    for (const key of keyPresses(data)) {
      if (key.id === "up") this.#selected = Math.max(0, this.#selected - 1);
      else if (key.id === "down") this.#selected = Math.min(this.#items.length - 1, this.#selected + 1);
      else if (key.id === "enter" || key.id === "space") {
        const item = this.#items[this.#selected];
        if (item) this.onSelect?.(item);
      } else if (key.id === "escape" || key.id === "ctrl+c") this.onCancel?.();
    }
  }

  render(width: number): readonly string[] {
    if (this.#items.length === 0) return [truncate(this.#theme.noMatch("No matches"), width, "")];
    return this.#items.map((item, index) => {
      const selected = index === this.#selected;
      const label = selected ? this.#theme.selectedText(item.label) : item.label;
      const prefix = selected ? this.#theme.selectedPrefix("→ ") : "  ";
      return truncate(prefix + label, Math.max(0, width), "");
    });
  }
}

export interface SettingItem {
  id: string;
  label: string;
  description?: string;
  warning?: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => RowsView;
  menu?: (currentValue: string, done: (selectedValue?: string) => void) => RowsView;
  changed?: boolean;
  defaultLabel?: string;
  heading?: boolean;
}

export interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

export interface SettingsListOptions {
  typeToSearch?: boolean;
  hint?: string;
}

export class SettingsList implements RowsView {
  #items: SettingItem[];
  #filtered: SettingItem[] = [];
  #selected = 0;
  #query = "";
  #submenu: RowsView | undefined;
  readonly #theme: SettingsListTheme;
  readonly #onChange: (id: string, newValue: string) => void;
  readonly #onCancel: () => void;
  readonly #typeToSearch: boolean;

  constructor(
    items: SettingItem[],
    _maxVisible: number,
    theme: SettingsListTheme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options: SettingsListOptions = {},
  ) {
    this.#items = items;
    this.#theme = theme;
    this.#onChange = onChange;
    this.#onCancel = onCancel;
    this.#typeToSearch = options.typeToSearch !== false;
    this.#refilter();
  }

  selectItem(id: string): boolean {
    const index = this.#items.findIndex((item) => item.id === id && !item.heading);
    if (index < 0) return false;
    this.#query = "";
    this.#refilter();
    const filtered = this.#filtered.findIndex((item) => item.id === id);
    if (filtered < 0) return false;
    this.#selected = filtered;
    return true;
  }

  setItems(items: SettingItem[]): void {
    this.#items = items;
    this.#refilter();
  }

  updateValue(id: string, newValue: string): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.currentValue = newValue;
    if (this.#query.trim().length > 0) this.#refilter();
  }

  getSelectedItem(): SettingItem | undefined {
    return this.#filtered.filter((item) => !item.heading)[this.#selected];
  }

  handleInput(data: string): void {
    if (this.#submenu) {
      this.#submenu.handleInput?.(data);
      return;
    }
    for (const key of keyPresses(data)) {
      if (actionIs(key, "tui.select.cancel")) {
        if (this.#query.length > 0) {
          this.#query = "";
          this.#refilter();
        } else this.#onCancel();
        continue;
      }
      if (this.#typeToSearch && (key.id === "backspace" || key.id === "ctrl+h") && this.#query.length > 0) {
        this.#query = [...this.#query].slice(0, -1).join("");
        this.#refilter();
        continue;
      }
      if (this.#typeToSearch && key.text && !(this.#query.length === 0 && key.text.trim().length === 0)) {
        this.#query += key.text;
        this.#refilter();
        continue;
      }
      if (actionIs(key, "tui.select.up")) this.#move(-1);
      else if (actionIs(key, "tui.select.down")) this.#move(1);
      else if (actionIs(key, "tui.select.confirm") || key.id === "space") this.#activate();
    }
  }

  render(width: number): readonly string[] {
    if (this.#submenu) return this.#submenu.render(width);
    const lines: string[] = [];
    const selectable = this.#filtered.filter((item) => !item.heading);
    const selected = selectable[this.#selected];
    for (const item of this.#filtered) {
      if (item.heading) {
        lines.push(truncate(this.#theme.label(item.label, false), Math.max(0, width), ""));
        continue;
      }
      const on = item === selected;
      const cursor = on ? this.#theme.cursor : "  ";
      const label = this.#theme.label(item.label, on);
      const value = item.currentValue ? this.#theme.value(item.currentValue, on) : "";
      lines.push(truncate(`${cursor}${label}${value ? `  ${value}` : ""}`, Math.max(0, width), ""));
    }
    if (selected?.description) lines.push(...wrap(this.#theme.description(selected.description), Math.max(1, width)));
    if (this.#typeToSearch) {
      const status = this.#query.length > 0 ? `  Search: ${this.#query}` : "  Type to search";
      lines.push(truncate(this.#theme.hint(status), Math.max(0, width), ""));
    }
    return lines.length > 0 ? lines : [""];
  }

  #move(delta: number): void {
    const selectable = this.#filtered.filter((item) => !item.heading);
    if (selectable.length === 0) return;
    this.#selected = Math.min(selectable.length - 1, Math.max(0, this.#selected + delta));
  }

  #activate(): void {
    const item = this.#filtered.filter((item) => !item.heading)[this.#selected];
    if (!item) return;
    if (item.submenu) {
      this.#submenu = item.submenu(item.currentValue, (selectedValue?: string) => {
        if (selectedValue !== undefined) {
          item.currentValue = selectedValue;
          this.#onChange(item.id, selectedValue);
        }
        this.#submenu = undefined;
      });
      return;
    }
    if (item.values && item.values.length > 0) {
      const current = item.values.indexOf(item.currentValue);
      const next = item.values[(current + 1) % item.values.length] ?? item.values[0] ?? item.currentValue;
      item.currentValue = next;
      this.#onChange(item.id, next);
    }
  }

  #refilter(): void {
    const query = this.#query.trim().toLowerCase();
    this.#filtered = query.length === 0
      ? this.#items.slice()
      : this.#items.filter((item) => {
        if (item.heading) return false;
        const haystack = `${item.label} ${item.currentValue} ${item.description ?? ""} ${item.id}`.toLowerCase();
        return haystack.includes(query);
      });
    const selectable = this.#filtered.filter((item) => !item.heading);
    if (query.length === 0) {
      if (this.#selected >= selectable.length) this.#selected = Math.max(0, selectable.length - 1);
      return;
    }
    let best = 0;
    let bestScore = -1;
    selectable.forEach((item, index) => {
      const label = item.label.replace(/\s+›$/, "").toLowerCase();
      const score = label === query ? 100 : label.startsWith(query) ? 80 : label.includes(query) ? 60 : 10;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    this.#selected = selectable.length === 0 ? 0 : best;
  }
}
