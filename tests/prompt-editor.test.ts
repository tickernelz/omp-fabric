import { describe, expect, it, vi } from "vitest";
import { EDITOR_CURSOR, PromptEditor } from "../src/ui/rows.js";

// Shift+Enter as terminals with the kitty keyboard protocol send it.
const SHIFT_ENTER = "\x1b[13;2u";

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
    expect(editor.render(40)).toEqual(["first", `second${EDITOR_CURSOR}`]);
    editor.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
  });

  it("paints the caret only while focused", () => {
    const editor = new PromptEditor();
    editor.setText("draft");
    expect(editor.render(40).join("")).not.toContain(EDITOR_CURSOR);
    editor.focused = true;
    expect(editor.render(40)).toEqual([`draft${EDITOR_CURSOR}`]);
  });
});
