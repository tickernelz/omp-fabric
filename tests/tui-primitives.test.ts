import { UiNode } from "@oh-my-pi/pi-tui";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { describe, expect, it, vi } from "vitest";
import { decodeTerminalInput, isAction, isKey } from "../src/ui/tui/input.js";
import { Stack, TextBlock } from "../src/ui/tui/rows.js";
import { SelectList } from "../src/ui/tui/select-list.js";
import { type SettingItem, SettingsList } from "../src/ui/tui/settings-list.js";
import { TextField } from "../src/ui/tui/text-field.js";
import { asRows } from "../src/ui/tui/view.js";

const press = (id: string) => ({ id, kind: "press" as const, raw: "" });
const plain = (rows: readonly string[]) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));

describe("terminal input decoding", () => {
  it("decodes legacy, kitty and pasted input into key ids and paste text", () => {
    expect(isKey("\x03", "ctrl+c")).toBe(true);
    expect(isKey("\x1b[99;5u", "ctrl+c")).toBe(true);
    expect(isAction("\x1b[A", "select.up")).toBe(true);
    expect(decodeTerminalInput("\x1b[200~two\nlines\x1b[201~")).toEqual([{ type: "paste", text: "two\nlines" }]);
    expect(decodeTerminalInput("ab").map((event) => event.type === "key" && event.key.id)).toEqual(["a", "b"]);
  });
});

describe("TextField", () => {
  it("edits by grapheme and word and submits the text", () => {
    const field = new TextField();
    const submit = vi.fn();
    field.onSubmit = submit;
    field.handleInput("hello wor👍🏽ld");
    field.handleInput("\x1b[D\x1b[D");
    field.handleInput("\x7f");
    expect(field.getText()).toBe("hello world");
    field.handleInput("\x17");
    expect(field.getText()).toBe("hello ld");
    field.handleInput("\r");
    expect(submit).toHaveBeenCalledWith("hello ld");
  });

  it("kills to line start, yanks it back and undoes the last edit", () => {
    const field = new TextField();
    field.handleInput("alpha beta");
    field.handleInput("\x15");
    expect(field.getText()).toBe("");
    field.handleInput("\x19");
    expect(field.getText()).toBe("alpha beta");
    field.handleKey(press("ctrl+_"));
    expect(field.getText()).toBe("");
  });

  it("keeps pasted newlines only in multi-line fields", () => {
    const single = new TextField();
    single.handleInput("\x1b[200~one\ntwo\x1b[201~");
    expect(single.getText()).toBe("one two");
    const multi = new TextField({ multiline: true });
    multi.handleInput("\x1b[200~one\ntwo\x1b[201~");
    multi.handleKey(press("shift+enter"));
    multi.handleInput("three");
    expect(multi.getText()).toBe("one\ntwo\nthree");
  });

  it("keeps the preferred column across a shorter line", () => {
    const field = new TextField({ multiline: true });
    field.setText("abcdef\nxy\nlonger line");
    field.handleKey(press("up"));
    field.handleKey(press("up"));
    field.handleInput("!");
    expect(field.getText()).toBe("abcdef!\nxy\nlonger line");
  });

  it("wraps multi-line text inside the width and reports the caret row", () => {
    const field = new TextField({ multiline: true });
    field.setText("0123456789abcdef\nend");
    const rows = field.render(8);
    expect(plain(rows)).toEqual(["01234567", "89abcdef", "end "]);
    expect(field.cursorRow).toBe(2);
    expect(rows[2]).toContain("\x1b[7m");
  });

  it("scrolls a single-line field so the caret stays visible", () => {
    const field = new TextField();
    field.setText("abcdefghijklmnopqrstuvwxyz");
    const [row] = plain(field.render(10));
    expect(row).toBe("> tuvwxyz ");
  });
});

describe("SelectList", () => {
  const items = [
    { value: "a", label: "Alpha", description: "first" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ];

  it("wraps navigation and confirms or cancels", () => {
    const list = new SelectList(items, 2, PLAIN_THEME);
    const select = vi.fn();
    const cancel = vi.fn();
    list.onSelect = select;
    list.onCancel = cancel;
    list.handleInput("\x1b[A");
    list.handleInput("\r");
    expect(select).toHaveBeenCalledWith(items[2]);
    list.handleInput("\x1b");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("windows long lists around the selection with a position marker", () => {
    const list = new SelectList(items, 2, PLAIN_THEME);
    list.setSelectedIndex(2);
    const rows = plain(list.render(40));
    expect(rows).toEqual(["  Beta", "→ Gamma", "  (3/3)"]);
  });
});

describe("SettingsList", () => {
  const build = (): { list: SettingsList; changes: Array<[string, string]>; cancel: ReturnType<typeof vi.fn>; items: SettingItem[] } => {
    const changes: Array<[string, string]> = [];
    const cancel = vi.fn();
    const items: SettingItem[] = [
      { id: "enabled", label: "Enabled", currentValue: "true", values: ["true", "false"], description: "Master switch" },
      {
        id: "mode",
        label: "Mode",
        currentValue: "fast",
        submenu: (_current, done) => ({
          render: () => ["submenu open"],
          handleInput: (data) => done(data === "\r" ? "slow" : undefined),
        }),
      },
    ];
    const list = new SettingsList(items, 10, PLAIN_THEME, (id, value) => changes.push([id, value]), cancel, { typeToSearch: true });
    return { list, changes, cancel, items };
  };

  it("cycles values and applies submenu results", () => {
    const { list, changes, items } = build();
    list.handleInput(" ");
    expect(changes).toEqual([["enabled", "false"]]);
    list.handleInput("\x1b[B\r");
    expect(plain(list.render(60))).toEqual(["submenu open"]);
    list.handleInput("\r");
    expect(changes.at(-1)).toEqual(["mode", "slow"]);
    expect(items[1]!.currentValue).toBe("slow");
    expect(plain(list.render(60)).join("\n")).toContain("Mode     slow");
  });

  it("filters by label, id and current value while typing; escape clears the search before cancelling", () => {
    const { list, cancel } = build();
    list.handleInput("mode");
    expect(list.getSelectedItem()?.id).toBe("mode");
    list.handleInput("\x1b");
    list.handleInput("fast");
    expect(list.getSelectedItem()?.id).toBe("mode");
    list.handleInput("\x1b");
    expect(cancel).not.toHaveBeenCalled();
    expect(list.getSelectedItem()?.id).toBe("enabled");
    list.handleInput("\x1b");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("row primitives", () => {
  it("wraps and pads text blocks and stacks children", () => {
    const stack = new Stack();
    stack.add(new TextBlock("one two three", 1, 1));
    stack.add(new TextBlock("   "));
    expect(stack.render(9)).toEqual(["         ", " one two ", " three   ", "         "]);
  });

  it("paints pi-tui nodes through the offline renderer and keeps rows objects", () => {
    const node = new UiNode("text", { text: "from a node" });
    expect(asRows(node, PLAIN_THEME).render(20)).toEqual(["from a node"]);
    const rows = { render: () => ["already rows"] };
    expect(asRows(rows, PLAIN_THEME)).toBe(rows);
    expect(asRows(undefined, PLAIN_THEME).render(20)).toEqual([]);
  });
});
