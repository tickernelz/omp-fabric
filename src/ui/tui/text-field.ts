import type { KeyEvent } from "@oh-my-pi/pi-tui";
import type { WidgetAction } from "@oh-my-pi/pi-tui/term/keymap";
import { inverse } from "@oh-my-pi/pi-tui/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { actionOf, decodeTerminalInput, typedText } from "./input.js";
import type { Rows } from "./view.js";

interface TextFieldOptions {
  multiline?: boolean;
  prompt?: string;
}

interface Snapshot {
  text: string;
  cursor: number;
}

const EDIT_ACTIONS: readonly WidgetAction[] = [
  "editor.newLine",
  "editor.cursorLeft",
  "editor.cursorRight",
  "editor.cursorWordLeft",
  "editor.cursorWordRight",
  "editor.cursorLineStart",
  "editor.cursorLineEnd",
  "editor.cursorUp",
  "editor.cursorDown",
  "editor.deleteCharBackward",
  "editor.deleteCharForward",
  "editor.deleteWordBackward",
  "editor.deleteWordForward",
  "editor.deleteToLineStart",
  "editor.deleteToLineEnd",
  "editor.yank",
  "editor.undo",
];

const UNDO_LIMIT = 100;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);
const isWordChar = (grapheme: string): boolean => /[\p{L}\p{N}_]/u.test(grapheme);

export class TextField implements Rows {
  onSubmit: ((text: string) => void) | undefined;
  onChange: ((text: string) => void) | undefined;
  focused = true;
  private text = "";
  private cursor = 0;
  private killed = "";
  private readonly undoStack: Snapshot[] = [];
  private preferredColumn: number | undefined;
  private lastCursorRow = 0;
  private readonly multiline: boolean;
  private readonly prompt: string;

  constructor(options: TextFieldOptions = {}) {
    this.multiline = options.multiline ?? false;
    this.prompt = options.prompt ?? (this.multiline ? "" : "> ");
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    const next = this.normalize(text);
    if (next === this.text) return;
    this.text = next;
    this.cursor = next.length;
    this.preferredColumn = undefined;
    this.onChange?.(this.text);
  }

  get cursorRow(): number {
    return this.lastCursorRow;
  }

  handleInput(data: string): void {
    for (const event of decodeTerminalInput(data)) {
      if (event.type === "paste") this.insert(event.text);
      else this.handleKey(event.key);
    }
  }

  handleKey(key: KeyEvent): boolean {
    if (key.id === "enter") {
      this.onSubmit?.(this.text);
      return true;
    }
    const action = actionOf(key.id, EDIT_ACTIONS);
    if (action) return this.apply(action);
    const typed = typedText(key);
    if (typed === undefined) return false;
    this.insert(typed);
    return true;
  }

  render(width: number): string[] {
    return this.multiline ? this.renderLines(width) : [this.renderLine(width)];
  }

  private apply(action: WidgetAction): boolean {
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEndOffset = after.indexOf("\n");
    const lineEnd = lineEndOffset < 0 ? this.text.length : this.cursor + lineEndOffset;
    switch (action) {
      case "editor.newLine":
        if (!this.multiline) return false;
        this.insert("\n");
        return true;
      case "editor.cursorLeft":
        return this.moveTo(this.cursor - (graphemes(before).at(-1)?.length ?? 0));
      case "editor.cursorRight":
        return this.moveTo(this.cursor + (graphemes(after)[0]?.length ?? 0));
      case "editor.cursorWordLeft":
        return this.moveTo(this.wordBoundaryBefore());
      case "editor.cursorWordRight":
        return this.moveTo(this.wordBoundaryAfter());
      case "editor.cursorLineStart":
        return this.moveTo(lineStart);
      case "editor.cursorLineEnd":
        return this.moveTo(lineEnd);
      case "editor.cursorUp":
        return this.moveVertical(-1);
      case "editor.cursorDown":
        return this.moveVertical(1);
      case "editor.deleteCharBackward":
        return this.remove(this.cursor - (graphemes(before).at(-1)?.length ?? 0), this.cursor, false);
      case "editor.deleteCharForward":
        return this.remove(this.cursor, this.cursor + (graphemes(after)[0]?.length ?? 0), false);
      case "editor.deleteWordBackward":
        return this.remove(this.wordBoundaryBefore(), this.cursor, true);
      case "editor.deleteWordForward":
        return this.remove(this.cursor, this.wordBoundaryAfter(), true);
      case "editor.deleteToLineStart":
        return this.remove(lineStart === this.cursor && lineStart > 0 ? lineStart - 1 : lineStart, this.cursor, true);
      case "editor.deleteToLineEnd":
        return this.remove(this.cursor, lineEnd === this.cursor && lineEnd < this.text.length ? lineEnd + 1 : lineEnd, true);
      case "editor.yank":
        if (this.killed === "") return false;
        this.insert(this.killed);
        return true;
      case "editor.undo": {
        const previous = this.undoStack.pop();
        if (!previous) return false;
        this.text = previous.text;
        this.cursor = previous.cursor;
        this.preferredColumn = undefined;
        this.onChange?.(this.text);
        return true;
      }
      default:
        return false;
    }
  }

  private normalize(text: string): string {
    const unified = text.replace(/\r\n?/g, "\n");
    return this.multiline ? unified : unified.replace(/\n/g, " ");
  }

  private remember(): void {
    this.undoStack.push({ text: this.text, cursor: this.cursor });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  private insert(raw: string): void {
    const text = this.normalize(raw);
    if (text === "") return;
    this.remember();
    this.text = `${this.text.slice(0, this.cursor)}${text}${this.text.slice(this.cursor)}`;
    this.cursor += text.length;
    this.preferredColumn = undefined;
    this.onChange?.(this.text);
  }

  private remove(from: number, to: number, kill: boolean): boolean {
    if (to <= from) return false;
    this.remember();
    if (kill) this.killed = this.text.slice(from, to);
    this.text = `${this.text.slice(0, from)}${this.text.slice(to)}`;
    this.cursor = from;
    this.preferredColumn = undefined;
    this.onChange?.(this.text);
    return true;
  }

  private moveTo(offset: number): boolean {
    this.cursor = Math.max(0, Math.min(offset, this.text.length));
    this.preferredColumn = undefined;
    return true;
  }

  private moveVertical(direction: -1 | 1): boolean {
    if (!this.multiline) return false;
    const lines = this.text.split("\n");
    let row = 0;
    let offset = 0;
    while (row < lines.length - 1 && offset + lines[row]!.length < this.cursor) {
      offset += lines[row]!.length + 1;
      row++;
    }
    const target = row + direction;
    if (target < 0 || target >= lines.length) return false;
    const column = this.preferredColumn ?? visibleWidth(this.text.slice(offset, this.cursor));
    const targetStart = direction < 0
      ? offset - lines[target]!.length - 1
      : offset + lines[row]!.length + 1;
    let position = targetStart;
    let width = 0;
    for (const grapheme of graphemes(lines[target]!)) {
      const next = width + visibleWidth(grapheme);
      if (next > column) break;
      width = next;
      position += grapheme.length;
    }
    this.cursor = position;
    this.preferredColumn = column;
    return true;
  }

  private wordBoundaryBefore(): number {
    const parts = graphemes(this.text.slice(0, this.cursor));
    let index = parts.length;
    while (index > 0 && !isWordChar(parts[index - 1]!)) index--;
    while (index > 0 && isWordChar(parts[index - 1]!)) index--;
    return parts.slice(0, index).join("").length;
  }

  private wordBoundaryAfter(): number {
    const parts = graphemes(this.text.slice(this.cursor));
    let index = 0;
    while (index < parts.length && !isWordChar(parts[index]!)) index++;
    while (index < parts.length && isWordChar(parts[index]!)) index++;
    return this.cursor + parts.slice(0, index).join("").length;
  }

  private caret(grapheme: string): string {
    return this.focused ? inverse(grapheme) : grapheme;
  }

  private renderLine(width: number): string {
    const room = Math.max(1, width - visibleWidth(this.prompt));
    const before = graphemes(this.text.slice(0, this.cursor));
    const after = graphemes(this.text.slice(this.cursor));
    const atCursor = after.shift() ?? " ";
    let used = visibleWidth(atCursor);
    const left: string[] = [];
    for (let index = before.length - 1; index >= 0 && used + visibleWidth(before[index]!) <= room; index--) {
      left.unshift(before[index]!);
      used += visibleWidth(before[index]!);
    }
    const right: string[] = [];
    for (const grapheme of after) {
      if (used + visibleWidth(grapheme) > room) break;
      right.push(grapheme);
      used += visibleWidth(grapheme);
    }
    this.lastCursorRow = 0;
    return `${this.prompt}${left.join("")}${this.caret(atCursor)}${right.join("")}`;
  }

  private renderLines(width: number): string[] {
    const room = Math.max(1, width - visibleWidth(this.prompt));
    const indent = " ".repeat(visibleWidth(this.prompt));
    const rows: string[] = [];
    let offset = 0;
    this.lastCursorRow = 0;
    for (const line of this.text.split("\n")) {
      let row = "";
      let used = 0;
      let position = offset;
      const cursorOnLine = this.cursor >= offset && this.cursor <= offset + line.length;
      const flush = (): void => {
        rows.push(`${rows.length === 0 ? this.prompt : indent}${row}`);
        row = "";
        used = 0;
      };
      for (const grapheme of graphemes(line)) {
        const cells = visibleWidth(grapheme);
        if (used + cells > room && used > 0) flush();
        if (position === this.cursor) {
          this.lastCursorRow = rows.length;
          row += this.caret(grapheme);
        } else {
          row += grapheme;
        }
        used += cells;
        position += grapheme.length;
      }
      if (cursorOnLine && this.cursor === offset + line.length) {
        if (used + 1 > room && used > 0) flush();
        this.lastCursorRow = rows.length;
        row += this.caret(" ");
      }
      flush();
      offset += line.length + 1;
    }
    return rows;
  }
}
