// Rows-object stand-ins for the pi-tui widgets 19.2 removed. Keyboard input is
// decoded with the reactive driver; drawing stays `render(width): string[]`
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
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

/** Opens the inverse-video cell a focused rows editor paints its caret with. */
export const EDITOR_CARET = "\u001b[7m";
const EDITOR_CARET_END = "\u001b[27m";

function caretCell(text: string): string {
  return `${EDITOR_CARET}${text}${EDITOR_CARET_END}`;
}

/** Index of the row holding a focused editor's caret, or -1 when none does. */
export function caretRow(lines: readonly string[]): number {
  return lines.findIndex((line) => line.includes(EDITOR_CARET));
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Grapheme {
  readonly at: number;
  readonly text: string;
  readonly width: number;
}

/** The graphemes of `text[from, to)`, with UTF-16 offsets into the whole text. */
function graphemesOf(text: string, from = 0, to = text.length): Grapheme[] {
  const out: Grapheme[] = [];
  if (to <= from) return out;
  for (const { segment, index } of graphemeSegmenter.segment(text.slice(from, to))) {
    out.push({ at: from + index, text: segment, width: visibleWidth(segment) });
  }
  return out;
}

const BLANK = /^\s+$/u;
// Controls other than LF never reach a field: they would corrupt the painted row.
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** Typed or pasted text as a field stores it: LF line ends, spaces for tabs, no other controls. */
function cleanInsert(text: string, singleLine: boolean): string {
  const clean = replaceTabs(text.replace(/\r\n?/g, "\n")).replace(CONTROLS, "");
  return singleLine ? clean.replace(/\n/g, " ") : clean;
}

/** One visual row of wrapped editor text; offsets are UTF-16 indices into the whole text. */
interface EditorRow {
  readonly start: number;
  /** End of the row's painted text. */
  readonly textEnd: number;
  /** Where the next row starts: blanks swallowed by a soft break lie in `[textEnd, end)`. */
  readonly end: number;
  /** Whether the row ends its logical line. */
  readonly last: boolean;
}

/** Word-wrap one logical line to `width` cells, like the host editor: a word wider than a row breaks by graphemes. */
function wrapLine(line: string, width: number): Array<Omit<EditorRow, "last">> {
  const all = graphemesOf(line);
  let total = 0;
  for (const g of all) total += g.width;
  if (total <= width) return [{ start: 0, textEnd: line.length, end: line.length }];
  const rows: Array<Omit<EditorRow, "last">> = [];
  let start = 0;
  let rowWidth = 0;
  let wordEnd = 0;
  const close = (textEnd: number, end: number): void => {
    rows.push({ start, textEnd, end });
    start = end;
    rowWidth = 0;
    wordEnd = end;
  };
  for (let i = 0; i < all.length;) {
    const blank = BLANK.test(all[i]!.text);
    let j = i;
    let tokenWidth = 0;
    while (j < all.length && BLANK.test(all[j]!.text) === blank) tokenWidth += all[j++]!.width;
    const tokenStart = all[i]!.at;
    const tokenEnd = j < all.length ? all[j]!.at : line.length;
    if (blank) {
      if (rowWidth + tokenWidth <= width) rowWidth += tokenWidth;
      // Blanks ending the line stay with its last row; others vanish into the break.
      else if (j >= all.length) {
        rows.push({ start, textEnd: wordEnd, end: line.length });
        return rows;
      } else close(wordEnd, tokenEnd);
    } else if (rowWidth + tokenWidth <= width) {
      rowWidth += tokenWidth;
      wordEnd = tokenEnd;
    } else if (tokenWidth <= width) {
      close(wordEnd, tokenStart);
      rowWidth = tokenWidth;
      wordEnd = tokenEnd;
    } else {
      for (let k = i; k < j; k++) {
        const g = all[k]!;
        if (rowWidth + g.width > width && rowWidth > 0) close(k === i ? wordEnd : g.at, g.at);
        rowWidth += g.width;
        wordEnd = g.at + g.text.length;
      }
    }
    i = j;
  }
  rows.push({ start, textEnd: line.length, end: line.length });
  return rows;
}

function layoutRows(text: string, width: number): EditorRow[] {
  const rows: EditorRow[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const chunks = wrapLine(line, Math.max(1, width));
    chunks.forEach((chunk, index) => {
      rows.push({
        start: offset + chunk.start,
        textEnd: offset + chunk.textEnd,
        end: offset + chunk.end,
        last: index === chunks.length - 1,
      });
    });
    offset += line.length + 1;
  }
  return rows;
}

/** The row holding `offset`; a soft-break boundary belongs to the next row. */
function rowOf(rows: readonly EditorRow[], offset: number): number {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (offset >= row.start && (offset < row.end || (offset === row.end && row.last))) return index;
  }
  return Math.max(0, rows.length - 1);
}

function columnOf(text: string, row: EditorRow, offset: number): number {
  let cells = 0;
  for (const g of graphemesOf(text, row.start, Math.min(Math.max(offset, row.start), row.textEnd))) cells += g.width;
  return cells;
}

function offsetAtColumn(text: string, row: EditorRow, column: number): number {
  let cells = 0;
  let lastStart = row.start;
  for (const g of graphemesOf(text, row.start, row.textEnd)) {
    if (cells + g.width > column) return g.at;
    cells += g.width;
    lastStart = g.at;
  }
  // A hard-broken row's end already belongs to the next row: stay on its last grapheme.
  return !row.last && row.textEnd === row.end ? lastStart : row.textEnd;
}

/** `text[start, end)` with the caret painted over the grapheme at `cursor`, or after the text. */
function withCaret(text: string, start: number, end: number, cursor: number): string {
  const at = Math.min(Math.max(cursor, start), end);
  const under = at < end ? graphemesOf(text, at, end)[0] : undefined;
  if (!under) return `${text.slice(start, at)}${caretCell(" ")}`;
  return `${text.slice(start, at)}${caretCell(under.text)}${text.slice(at + under.text.length, end)}`;
}

/** Text and a caret offset (UTF-16, always on a grapheme boundary) shared by the rows editors. */
class EditBuffer {
  value = "";
  cursor = 0;

  constructor(readonly singleLine: boolean) { }

  insert(text: string): boolean {
    const clean = cleanInsert(text, this.singleLine);
    if (!clean) return false;
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
    return true;
  }

  remove(from: number, to: number): boolean {
    if (to <= from) return false;
    this.value = this.value.slice(0, from) + this.value.slice(to);
    this.cursor = from;
    return true;
  }

  lineStart(offset: number): number {
    return offset <= 0 ? 0 : this.value.lastIndexOf("\n", offset - 1) + 1;
  }

  lineEnd(offset: number): number {
    const end = this.value.indexOf("\n", offset);
    return end < 0 ? this.value.length : end;
  }

  /** Start of the grapheme before `offset`. */
  before(offset: number): number {
    if (offset <= 0) return 0;
    const start = this.lineStart(offset);
    if (start === offset) return offset - 1;
    return graphemesOf(this.value, start, offset).at(-1)?.at ?? offset - 1;
  }

  /** End of the grapheme at `offset`. */
  after(offset: number): number {
    if (offset >= this.value.length) return this.value.length;
    if (this.value[offset] === "\n") return offset + 1;
    const first = graphemesOf(this.value, offset, this.lineEnd(offset))[0];
    return first ? offset + first.text.length : offset + 1;
  }

  wordBefore(offset: number): number {
    const all = graphemesOf(this.value, 0, offset);
    let index = all.length;
    while (index > 0 && BLANK.test(all[index - 1]!.text)) index--;
    while (index > 0 && !BLANK.test(all[index - 1]!.text)) index--;
    return all[index]?.at ?? offset;
  }

  wordAfter(offset: number): number {
    const all = graphemesOf(this.value, offset);
    let index = 0;
    while (index < all.length && BLANK.test(all[index]!.text)) index++;
    while (index < all.length && !BLANK.test(all[index]!.text)) index++;
    return all[index]?.at ?? this.value.length;
  }
}

/**
 * One editing key, matched through the host's `tui.editor.*` bindings: true when the
 * text changed, false when only the caret moved, undefined when it is no editing key.
 */
function applyEditKey(buffer: EditBuffer, key: KeyEvent): boolean | undefined {
  const at = buffer.cursor;
  if (key.id === "backspace" || key.id === "ctrl+h" || actionIs(key, "tui.editor.deleteCharBackward")) {
    return buffer.remove(buffer.before(at), at);
  }
  if (actionIs(key, "tui.editor.deleteCharForward")) return buffer.remove(at, buffer.after(at));
  if (actionIs(key, "tui.editor.deleteWordBackward")) return buffer.remove(buffer.wordBefore(at), at);
  if (actionIs(key, "tui.editor.deleteWordForward")) return buffer.remove(at, buffer.wordAfter(at));
  if (actionIs(key, "tui.editor.deleteToLineStart")) return buffer.remove(buffer.lineStart(at), at);
  if (actionIs(key, "tui.editor.deleteToLineEnd")) return buffer.remove(at, buffer.lineEnd(at));
  let to: number | undefined;
  if (actionIs(key, "tui.editor.cursorLeft")) to = buffer.before(at);
  else if (actionIs(key, "tui.editor.cursorRight")) to = buffer.after(at);
  else if (actionIs(key, "tui.editor.cursorWordLeft")) to = buffer.wordBefore(at);
  else if (actionIs(key, "tui.editor.cursorWordRight")) to = buffer.wordAfter(at);
  else if (actionIs(key, "tui.editor.cursorLineStart")) to = buffer.lineStart(at);
  else if (actionIs(key, "tui.editor.cursorLineEnd")) to = buffer.lineEnd(at);
  if (to === undefined) return undefined;
  buffer.cursor = to;
  return false;
}

export class PromptEditor implements RowsView {
  focused = false;
  onChange?: (text: string) => void;
  /** Enter submits when set; otherwise the owner handles Enter itself. */
  onSubmit?: (text: string) => void;

  invalidate(): void { }
  readonly #buffer = new EditBuffer(false);
  /** Row width of the last render: up/down walk these wrapped rows. */
  #rowWidth = Number.POSITIVE_INFINITY;
  /** Column a run of up/down moves aims for. */
  #goalColumn: number | undefined;

  getText(): string {
    return this.#buffer.value;
  }

  setText(text: string): void {
    if (text === this.#buffer.value && this.#buffer.cursor === text.length) return;
    this.#buffer.value = text;
    this.#buffer.cursor = text.length;
    this.#goalColumn = undefined;
    this.onChange?.(text);
  }

  handleInput(data: string): void {
    let changed = false;
    for (const event of decodeInput(data)) {
      if (event.type === "paste") {
        this.#goalColumn = undefined;
        if (this.#buffer.insert(event.paste.text)) changed = true;
        continue;
      }
      if (event.type !== "key" || event.key.kind === "release") continue;
      const key = event.key;
      if (actionIs(key, "tui.editor.cursorUp")) {
        this.#moveVertically(-1);
        continue;
      }
      if (actionIs(key, "tui.editor.cursorDown")) {
        this.#moveVertically(1);
        continue;
      }
      this.#goalColumn = undefined;
      if (key.id === "shift+enter") {
        if (this.#buffer.insert("\n")) changed = true;
        continue;
      }
      if (key.id === "enter") {
        if (changed) this.onChange?.(this.#buffer.value);
        changed = false;
        this.onSubmit?.(this.#buffer.value);
        continue;
      }
      if (key.id === "escape") continue;
      const edited = applyEditKey(this.#buffer, key);
      if (edited !== undefined) {
        if (edited) changed = true;
        continue;
      }
      const text = key.id === "space" ? " " : key.text;
      if (text && this.#buffer.insert(text)) changed = true;
    }
    if (changed) this.onChange?.(this.#buffer.value);
  }

  render(width: number): readonly string[] {
    // One cell stays free so a caret after a row's last character still fits.
    this.#rowWidth = Math.max(1, width - 1);
    const value = this.#buffer.value;
    const rows = layoutRows(value, this.#rowWidth);
    // Only the focused editor owns the caret; an unfocused one must not claim it.
    const caret = this.focused ? rowOf(rows, this.#buffer.cursor) : -1;
    return rows.map((row, index) => {
      const line = index === caret
        ? withCaret(value, row.start, row.textEnd, this.#buffer.cursor)
        : value.slice(row.start, row.textEnd);
      return clip(line, Math.max(0, width), "");
    });
  }

  #moveVertically(delta: number): void {
    const value = this.#buffer.value;
    const rows = layoutRows(value, this.#rowWidth);
    const from = rowOf(rows, this.#buffer.cursor);
    const target = rows[from + delta];
    if (!target) return;
    this.#goalColumn ??= columnOf(value, rows[from]!, this.#buffer.cursor);
    this.#buffer.cursor = offsetAtColumn(value, target, this.#goalColumn);
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
  readonly #buffer = new EditBuffer(true);
  /** First visible cell while the value is wider than the field. */
  #scroll = 0;

  getValue(): string {
    return this.#buffer.value;
  }

  setValue(value: string): void {
    this.#buffer.value = value;
    this.#buffer.cursor = value.length;
  }

  handleInput(data: string): void {
    for (const event of decodeInput(data)) {
      if (event.type === "paste") {
        this.#buffer.insert(event.paste.text);
        continue;
      }
      if (event.type !== "key" || event.key.kind === "release") continue;
      const key = event.key;
      if (key.id === "enter") {
        this.onSubmit?.(this.#buffer.value);
        continue;
      }
      if (key.id === "escape" || key.id === "ctrl+c") {
        this.onEscape?.();
        continue;
      }
      if (applyEditKey(this.#buffer, key) !== undefined) continue;
      const text = key.id === "space" ? " " : key.text;
      if (text) this.#buffer.insert(text);
    }
  }

  render(width: number): readonly string[] {
    const value = this.#buffer.value;
    if (!this.focused || width <= 0) return [truncate(value, Math.max(0, width), "")];
    const cursor = this.#buffer.cursor;
    const all = graphemesOf(value);
    let total = 1;
    let caretColumn = 0;
    let caretWidth = 1;
    for (const g of all) {
      if (g.at < cursor) caretColumn += g.width;
      else if (g.at === cursor) caretWidth = Math.max(1, g.width);
      total += g.width;
    }
    // A window as wide as the field that always holds the caret.
    this.#scroll = Math.min(this.#scroll, Math.max(0, total - width));
    if (caretColumn < this.#scroll) this.#scroll = caretColumn;
    if (caretColumn + caretWidth > this.#scroll + width) this.#scroll = caretColumn + caretWidth - width;
    let column = 0;
    let line = "";
    for (const g of all) {
      const start = column;
      column += g.width;
      if (start < this.#scroll) continue;
      if (column > this.#scroll + width) break;
      line += g.at === cursor ? caretCell(g.text) : g.text;
    }
    if (cursor >= value.length) line += caretCell(" ");
    return [truncate(line, width, "")];
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
