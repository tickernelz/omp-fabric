import { describe, expect, it, vi } from "vitest";
import { caretRow, EDITOR_CARET, Input, PromptEditor, visibleWidth } from "../src/ui/rows.js";

// Shift+Enter as terminals with the kitty keyboard protocol send it.
const SHIFT_ENTER = "\x1b[13;2u";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const CTRL_LEFT = "\x1b[1;5D";
const ALT_RIGHT = "\x1b[1;3C";
const ALT_B = "\x1bb";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const BACKSPACE = "\x7f";

/** The visible caret: one inverse-video cell. */
const caret = (text = " "): string => `\x1b[7m${text}\x1b[27m`;
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Marks the caret with `|` by typing it, then reads the text back. */
const caretAt = (editor: PromptEditor): string => {
  editor.handleInput("|");
  const text = editor.getText();
  editor.handleInput(BACKSPACE);
  return text;
};

describe("PromptEditor", () => {
  it("inserts a newline on Shift+Enter and submits the whole draft on Enter", () => {
    const editor = new PromptEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.handleInput("first");
    editor.handleInput(SHIFT_ENTER);
    editor.handleInput("second");
    expect(editor.getText()).toBe("first\nsecond");
    expect(onSubmit).not.toHaveBeenCalled();
    editor.focused = true;
    expect(editor.render(40)).toEqual(["first", `second${caret()}`]);
    editor.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
  });

  it("paints a visible caret only while focused and leaks no private marker", () => {
    const editor = new PromptEditor();
    editor.setText("draft");
    expect(editor.render(40)).toEqual(["draft"]);
    expect(caretRow(editor.render(40))).toBe(-1);
    editor.focused = true;
    expect(editor.render(40)).toEqual([`draft${caret()}`]);
    editor.handleInput(LEFT);
    expect(editor.render(40)).toEqual([`draf${caret("t")}`]);
    expect(editor.render(40).join("")).not.toContain("\x1b_");
    expect(EDITOR_CARET).toBe("\x1b[7m");
  });

  it("inserts a bracketed paste at the caret with CRLF normalised and without submitting", () => {
    const editor = new PromptEditor();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    editor.onSubmit = onSubmit;
    editor.onChange = onChange;
    editor.handleInput("ab");
    editor.handleInput(LEFT);
    onChange.mockClear();
    editor.handleInput(paste("one\r\ntwo\rthree\tx"));
    expect(editor.getText()).toBe("aone\ntwo\nthree   xb");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(caretAt(editor)).toBe("aone\ntwo\nthree   x|b");
  });

  it("drops control characters from pastes", () => {
    const editor = new PromptEditor();
    editor.handleInput(paste("red\x1b[31m!\x07"));
    expect(editor.getText()).toBe("red[31m!");
  });

  it("deletes whole graphemes so emoji never leave half a surrogate pair", () => {
    const editor = new PromptEditor();
    editor.handleInput("a😀");
    editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("a");
    editor.setText("x👍🏽y");
    editor.handleInput(LEFT);
    editor.handleInput(LEFT);
    expect(caretAt(editor)).toBe("x|👍🏽y");
    editor.handleInput(DELETE);
    expect(editor.getText()).toBe("xy");
    editor.setText("🇪🇸");
    editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("");
    editor.setText("e😀");
    editor.handleInput(LEFT);
    editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("😀");
    expect(loneSurrogate.test(editor.getText())).toBe(false);
  });

  it("moves by word, to line start and end, and deletes forward", () => {
    const editor = new PromptEditor();
    editor.setText("alpha beta gamma");
    editor.handleInput(CTRL_LEFT);
    expect(caretAt(editor)).toBe("alpha beta |gamma");
    editor.handleInput(ALT_B);
    expect(caretAt(editor)).toBe("alpha |beta gamma");
    editor.handleInput(ALT_RIGHT);
    expect(caretAt(editor)).toBe("alpha beta| gamma");
    editor.handleInput(HOME);
    expect(caretAt(editor)).toBe("|alpha beta gamma");
    editor.handleInput(DELETE);
    expect(editor.getText()).toBe("lpha beta gamma");
    editor.handleInput(END);
    expect(caretAt(editor)).toBe("lpha beta gamma|");
    editor.setText("one\ntwo");
    editor.handleInput(CTRL_A);
    expect(caretAt(editor)).toBe("one\n|two");
    editor.handleInput(LEFT);
    editor.handleInput(CTRL_A);
    expect(caretAt(editor)).toBe("|one\ntwo");
    editor.handleInput(CTRL_E);
    expect(caretAt(editor)).toBe("one|\ntwo");
    editor.handleInput(RIGHT);
    expect(caretAt(editor)).toBe("one\n|two");
  });

  it("moves up and down between logical lines, keeping the column", () => {
    const editor = new PromptEditor();
    editor.setText("abc\nlonger line\nxy");
    editor.handleInput(UP);
    expect(caretAt(editor)).toBe("abc\nlo|nger line\nxy");
    editor.handleInput(END);
    editor.handleInput(UP);
    expect(caretAt(editor)).toBe("abc|\nlonger line\nxy");
    // A run of vertical moves keeps aiming for the column it started from.
    editor.handleInput(DOWN);
    editor.handleInput(END);
    editor.handleInput(UP);
    editor.handleInput(DOWN);
    expect(caretAt(editor)).toBe("abc\nlonger line|\nxy");
    editor.handleInput(UP);
    editor.handleInput(UP);
    expect(caretAt(editor)).toBe("abc|\nlonger line\nxy");
  });

  it("wraps long lines to the width and keeps the caret on its wrapped row", () => {
    const editor = new PromptEditor();
    editor.focused = true;
    const text = "abcdefghijklmnopqrstuvwxyz0123";
    editor.setText(text);
    const rows = editor.render(10);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(10);
    expect(rows.map(plain).join("").trimEnd()).toBe(text);
    expect(caretRow(rows)).toBe(rows.length - 1);
    editor.handleInput(HOME);
    expect(caretRow(editor.render(10))).toBe(0);
    expect(editor.render(10)[0]).toContain(caret("a"));
    // Up and down walk the wrapped rows of the last render.
    editor.handleInput(DOWN);
    const second = editor.render(10);
    expect(caretRow(second)).toBe(1);
    expect(second[1]!.startsWith(caret(plain(second[1]!)[0]))).toBe(true);
  });

  it("wraps by words and swallows the blank at a soft break", () => {
    const editor = new PromptEditor();
    editor.setText("alpha beta gamma delta");
    expect(editor.render(12).map(plain)).toEqual(["alpha beta", "gamma delta"]);
    editor.focused = true;
    const rows = editor.render(12);
    expect(caretRow(rows)).toBe(1);
    expect(rows[1]).toBe(`gamma delta${caret()}`);
  });
});

describe("Input", () => {
  it("pastes as one line and edits by grapheme", () => {
    const input = new Input();
    input.handleInput(paste("one\r\ntwo"));
    expect(input.getValue()).toBe("one two");
    input.handleInput("😀");
    input.handleInput(BACKSPACE);
    expect(input.getValue()).toBe("one two");
    input.handleInput(HOME);
    input.handleInput(DELETE);
    input.handleInput(ALT_RIGHT);
    input.handleInput("!");
    expect(input.getValue()).toBe("ne! two");
  });

  it("shows a window around the caret while focused", () => {
    const input = new Input();
    input.setValue("abcdefghijklmnopqrstuvwxyz0123");
    expect(input.render(10)).toEqual(["abcdefghij"]);
    input.focused = true;
    const tail = input.render(10)[0]!;
    expect(visibleWidth(tail)).toBe(10);
    expect(tail).toBe(`uvwxyz0123`.slice(1) + caret());
    input.handleInput(HOME);
    expect(input.render(10)).toEqual([`${caret("a")}bcdefghij`]);
    for (let i = 0; i < 12; i++) input.handleInput(RIGHT);
    const middle = input.render(10)[0]!;
    expect(middle).toContain(caret("m"));
    expect(visibleWidth(middle)).toBeLessThanOrEqual(10);
  });
});
