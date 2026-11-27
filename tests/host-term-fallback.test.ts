import { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testTheme } from "./test-theme.js";

const TERM_MODULES = [
  "@oh-my-pi/pi-tui/term/paint",
  "@oh-my-pi/pi-tui/term/widgets",
  "@oh-my-pi/pi-tui/term/render",
  "@oh-my-pi/pi-tui/term/keymap",
  "@oh-my-pi/pi-tui/driver/input/decoder",
] as const;

const missingModule = (id: string) => () => {
  throw new Error(`Cannot find module '${id}'`);
};

const loadUi = async () => {
  vi.resetModules();
  const view = await import("../src/ui/tui/view.js");
  const input = await import("../src/ui/tui/input.js");
  const hostTerm = await import("../src/ui/tui/host-term.js");
  return { ...view, ...input, ...hostTerm };
};

afterEach(() => {
  for (const id of TERM_MODULES) vi.doUnmock(id);
  vi.resetModules();
});

describe("Fabric UI on a host without pi-tui internals", () => {
  it("reports nothing when the host provides every internal module", async () => {
    const { hostTermDiagnostic } = await loadUi();
    expect(hostTermDiagnostic()).toBeUndefined();
  });

  it("loads, draws plain rows and answers host keys when the term modules are missing", async () => {
    for (const id of TERM_MODULES) vi.doMock(id, missingModule(id));
    const { mountView, isAction, keyOf, hostTermDiagnostic } = await loadUi();
    const seen: string[] = [];
    const cancelled: boolean[] = [];
    const { node, view } = mountView(() => ({ columns: 40, rows: 6 }), () => ({
      render: () => ["fallback rows"],
      handleInput: (data: string) => {
        seen.push(keyOf(data)?.id ?? "?");
        cancelled.push(isAction(data, "select.cancel"));
      },
    }));
    const term = createTestTerminal(() => ({ main: node }), { columns: 40, rows: 6 });
    try {
      term.focus(node);
      expect(term.screen().join("\n")).toContain("fallback rows");
      expect((node.props() as { term?: unknown }).term).toBeUndefined();
      term.press("down", { text: "\x1b[B" });
      term.press("escape", { text: "\x1b" });
      expect(seen).toEqual(["down", "escape"]);
      expect(cancelled).toEqual([false, true]);
      const diagnostic = hostTermDiagnostic();
      for (const id of TERM_MODULES) expect(diagnostic).toContain(id);
      expect(diagnostic).toContain("mouse wheel scrolling");
    } finally {
      view.dispose?.();
      term.dispose();
    }
  });

  it("falls back when a term module loads without the export Fabric calls", async () => {
    vi.doMock("@oh-my-pi/pi-tui/term/keymap", () => ({ widgetKeyMatches: undefined, widgetActionOf: undefined }));
    const { isAction, actionOf, hostTermDiagnostic } = await loadUi();
    expect(isAction("\x1b", "select.cancel")).toBe(true);
    expect(isAction("\x1b[A", "select.down")).toBe(false);
    expect(actionOf("ctrl+a", ["editor.cursorLeft", "editor.cursorLineStart"])).toBe("editor.cursorLineStart");
    expect(hostTermDiagnostic()).toContain("@oh-my-pi/pi-tui/term/keymap (no export widgetKeyMatches, widgetActionOf)");
  });

  it("shows one notice row in place of a host-drawn preview without term/render", async () => {
    vi.doMock("@oh-my-pi/pi-tui/term/render", missingModule("@oh-my-pi/pi-tui/term/render"));
    const { asRows } = await loadUi();
    const rows = asRows(new UiNode("text", { text: "host preview" }), testTheme()).render(80);
    expect(rows).toEqual(["Preview unavailable: this OMP host does not provide pi-tui term/render."]);
    expect(asRows({ render: () => ["own rows"] }, testTheme()).render(80)).toEqual(["own rows"]);
  });
});
