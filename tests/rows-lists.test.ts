import { describe, expect, it, vi } from "vitest";
import { type SettingItem, SettingsList, SelectList } from "../src/ui/rows.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

const settingsTheme = {
  label: (text: string, selected: boolean) => (selected ? `[${text}]` : text),
  value: (text: string) => text,
  description: (text: string) => text,
  cursor: "> ",
  hint: (text: string) => text,
};

const selectTheme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
};

const settingItems = (count: number): SettingItem[] =>
  Array.from({ length: count }, (_, index) => ({ id: `s${index}`, label: `setting ${index}`, currentValue: "on" }));

describe("SettingsList", () => {
  it("shows at most maxVisible rows and scrolls with the selection", () => {
    const list = new SettingsList(settingItems(30), 5, settingsTheme, vi.fn(), vi.fn());
    const first = list.render(60);
    expect(first.filter((line) => line.includes("setting "))).toHaveLength(5);
    expect(first[0]).toBe("> [setting 0]  on");
    expect(first).toContain("  (1/30)");
    for (let i = 0; i < 20; i++) list.handleInput(DOWN);
    const moved = list.render(60);
    const rows = moved.filter((line) => line.includes("setting "));
    expect(rows).toHaveLength(5);
    expect(rows).toContain("> [setting 20]  on");
    expect(rows[2]).toBe("> [setting 20]  on");
    expect(moved).toContain("  (21/30)");
    for (let i = 0; i < 20; i++) list.handleInput(DOWN);
    const last = list.render(60).filter((line) => line.includes("setting "));
    expect(last.at(-1)).toBe("> [setting 29]  on");
    list.handleInput(UP);
    expect(list.getSelectedItem()?.id).toBe("s28");
  });

  it("counts headings in the window and shows every row when they fit", () => {
    const items: SettingItem[] = [
      { id: "h", label: "General", currentValue: "", heading: true },
      ...settingItems(3),
    ];
    const list = new SettingsList(items, 10, settingsTheme, vi.fn(), vi.fn(), { typeToSearch: false });
    expect(list.render(60)).toEqual(["General", "> [setting 0]  on", "  setting 1  on", "  setting 2  on"]);
    const tight = new SettingsList(items, 2, settingsTheme, vi.fn(), vi.fn(), { typeToSearch: false });
    tight.selectItem("s2");
    expect(tight.render(60)).toEqual(["  setting 1  on", "> [setting 2]  on", "  (3/3)"]);
  });
});

describe("SelectList", () => {
  it("keeps the selection inside a maxVisible window", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` }));
    const list = new SelectList(items, 4, selectTheme);
    list.setSelectedIndex(10);
    expect(list.render(40)).toEqual(["  item 8", "  item 9", "→ item 10", "  item 11", "  (11/12)"]);
    const all = new SelectList(items.slice(0, 3), 3, selectTheme);
    expect(all.render(40)).toEqual(["→ item 0", "  item 1", "  item 2"]);
  });
});
