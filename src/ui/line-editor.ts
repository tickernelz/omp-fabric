import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { editLine } from "@oh-my-pi/pi-coding-agent/ui/overlays/settings/line-edit";
import type { FabricRows, FabricTheme } from "./render-types.js";
import { terminalSafe } from "./transcript-sanitization.js";

/** Terminal-only IME cursor marker the old `Editor` emitted; kept so tests and
 *  queue line extraction still find the caret row. */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * One line of a multi-line draft: text plus a UTF-16 caret, edited with the
 * host's `tui.editor.*` bindings.
 */
export class LineEditorRows implements FabricRows {
  text = "";
  cursor = 0;
  focused = false;
  private readonly borderColor: (value: string) => string;
  private readonly paddingX: number;

  constructor(
    private readonly theme: FabricTheme,
    options: { borderColor?: (value: string) => string; initial?: string; paddingX?: number } = {},
  ) {
    this.borderColor = options.borderColor ?? ((value) => theme.fg("borderMuted", value));
    this.paddingX = options.paddingX ?? 1;
    if (options.initial !== undefined) {
      this.text = options.initial;
      this.cursor = options.initial.length;
    }
  }

  getText(): string {
    return this.text;
  }

  setText(value: string): void {
    this.text = value;
    this.cursor = value.length;
  }

  invalidate(): void {}

  onSubmit: ((text: string) => void) | undefined = undefined;

  handleInput(data: string): void {
    for (const input of decodeInput(data)) {
      if (input.type === "paste") {
        this.insert(terminalSafe(input.paste.text.replace(/\r\n?/g, "\n"), false));
        continue;
      }
      if (input.type !== "key") continue;
      const event = input.key;
      if (event.kind === "release") continue;
      if (event.id === "shift+enter" || event.id === "alt+enter") {
        this.insert("\n");
        continue;
      }
      if (event.id === "enter") {
        this.onSubmit?.(this.text);
        continue;
      }
      const next = editLine({ text: this.text, cursor: this.cursor }, event);
      if (next) {
        this.text = next.text;
        this.cursor = next.cursor;
      }
    }
  }

  private insert(text: string): void {
    this.text = `${this.text.slice(0, this.cursor)}${text}${this.text.slice(this.cursor)}`;
    this.cursor += text.length;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const box = this.theme.symbols?.box;
    const framed = width >= 3;
    const margin = framed ? Math.min(this.paddingX, Math.floor((width - 3) / 2)) : 0;
    const padding = " ".repeat(margin);
    const inner = width - (framed ? 2 + 2 * margin : 0);
    const border = this.borderColor;
    const rule = (left: string, right: string): string =>
      border(`${left}${(box?.horizontal ?? "─").repeat(width - 2)}${right}`);
    const rows = framed ? [rule(box?.topLeft ?? "╭", box?.topRight ?? "╮")] : [];
    const side = framed ? border(box?.vertical ?? "│") : "";
    let offset = 0;
    for (const line of this.text.split("\n")) {
      let used = 0;
      let row = "";
      const push = (): void => {
        rows.push(`${side}${padding}${row}${" ".repeat(inner - used)}${padding}${side}`);
        row = "";
        used = 0;
      };
      for (const { segment, index } of segmenter.segment(line)) {
        const cells = visibleWidth(segment);
        if (used && used + cells > inner) push();
        const cell = cells <= inner ? segment : " ";
        row += this.focused && this.cursor === offset + index
          ? `${CURSOR_MARKER}\x1b[7m${cell}\x1b[27m`
          : cell;
        used += cells <= inner ? cells : 1;
      }
      if (this.focused && this.cursor === offset + line.length) {
        if (used === inner && !framed) push();
        row += CURSOR_MARKER;
        if (used < inner) {
          row += "\x1b[7m \x1b[27m";
          used++;
        }
      }
      push();
      offset += line.length + 1;
    }
    if (framed) rows.push(rule(box?.bottomLeft ?? "╰", box?.bottomRight ?? "╯"));
    return rows;
  }
}

/** A `Theme`-shaped color function for the old editor theme shape. */
export const editorBorderColor = (
  theme: Theme,
  thinking: () => string | undefined,
): ((value: string) => string) => (value: string) => {
  const level = thinking();
  const color = level === "minimal"
    ? "thinkingMinimal"
    : level === "low"
      ? "thinkingLow"
      : level === "medium"
        ? "thinkingMedium"
        : level === "high"
          ? "thinkingHigh"
          : level === "xhigh"
            ? "thinkingXhigh"
            : level === "max"
              ? "thinkingMax"
              : "borderMuted";
  return theme.fg(color, value);
};
