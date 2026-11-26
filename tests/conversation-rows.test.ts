// The coverage conversation-tui.test.ts gave through the retired pi-tui TUI, rebuilt on
// the 19.2 rows contract: the host hands keys to `handleInput` as raw bytes and pastes
// as bracketed bytes, and paints `render(width)` cut to the terminal.
import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { installFabricEscapeHalt } from "../src/ui/escape-halt.js";
import { type HostSurface, PromptEditor, visibleWidth } from "../src/ui/rows.js";
import { assistantMessage, nativeTranscript, userMessage } from "./fixtures/native-conversation.js";
initTheme();

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const targets = (): FabricConversationTarget[] => [
  { id: "main", name: "Main", kind: "main", status: "running", canSteer: false, canFollowUp: false, canStop: false },
  { id: "child-1", parentId: "main", name: "Implementer", kind: "agent", status: "running", canSteer: true, canFollowUp: true, canStop: true },
];

/** A host stand-in: terminal listeners see input first, then the focused rows object or Main's editor. */
function makeHost(size: { columns: number; rows: number }) {
  const listeners = new Set<(data: string) => undefined>();
  const main = new PromptEditor();
  main.setText("untouched Main draft");
  const mainSubmit = vi.fn();
  main.onSubmit = mainSubmit;
  const terminal = { ...size, write: vi.fn() };
  const tui: HostSurface = { requestRender: vi.fn(), terminal };
  let ownsInput = true;
  const halt = vi.fn(() => 1);
  const context = {
    mode: "tui",
    ui: {
      notify: vi.fn(),
      onTerminalInput: (listener: (data: string) => undefined) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ExtensionContext;
  const unsubscribe = installFabricEscapeHalt(context, {
    enabled: () => true, ownsInput: () => ownsInput, halted: () => false, halt,
  });
  const send = vi.fn().mockResolvedValue({ queued: true });
  const stop = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn(() => {
    ownsInput = false;
    view.dispose();
  });
  const view = new FabricConversationView(tui, theme, {
    state: new FabricConversationState(),
    initialTargetId: "child-1",
    targets,
    transcript: () => nativeTranscript([
      userMessage("Implement the change"),
      assistantMessage("Working on **the requested change**, a long line that has to wrap at narrow widths."),
    ]),
    loadOlder: () => false,
    loadNewer: () => false,
    loadLatest: () => false,
    send,
    stop,
    close,
  });
  view.focused = true;
  const input = (data: string): void => {
    for (const listener of listeners) listener(data);
    if (ownsInput) view.handleInput(data);
    else main.handleInput(data);
  };
  const paint = (): string[] => view.render(terminal.columns);
  return { main, mainSubmit, view, input, paint, send, stop, halt, close, terminal, unsubscribe };
}

describe("conversation rows through a host stand-in", () => {
  it("routes child input and restores Main without interruption", async () => {
    const host = makeHost({ columns: 90, rows: 24 });
    try {
      const lines = host.paint();
      expect(lines.join("\n")).toContain("Implementer");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
      expect(lines.length).toBeLessThanOrEqual(24);
      host.input("Please check the error path");
      host.input("\r");
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledWith("child-1", "Please check the error path", "steer"));
      expect(host.main.getText()).toBe("untouched Main draft");
      expect(host.mainSubmit).not.toHaveBeenCalled();
      // Escape-halt decides on a 60 ms timer: drive it past that deterministically.
      vi.useFakeTimers();
      try {
        host.input("\x1b");
        vi.advanceTimersByTime(80);
      } finally {
        vi.useRealTimers();
      }
      expect(host.close).toHaveBeenCalledTimes(1);
      expect(host.halt).not.toHaveBeenCalled();
      expect(host.stop).not.toHaveBeenCalled();
      expect(host.main.getText()).toBe("untouched Main draft");
      host.input(" still here");
      expect(host.main.getText()).toBe("untouched Main draft still here");
      expect(host.mainSubmit).not.toHaveBeenCalled();
    } finally {
      host.unsubscribe();
      host.view.dispose();
    }
  });

  it("takes a bracketed paste into the child draft without sending it", async () => {
    const host = makeHost({ columns: 90, rows: 24 });
    try {
      host.input("\x1b[200~first line\r\nsecond line\x1b[201~");
      expect(host.send).not.toHaveBeenCalled();
      const painted = host.paint().join("\n");
      expect(painted).toContain("first line");
      expect(painted).toContain("second line");
      expect(host.main.getText()).toBe("untouched Main draft");
      host.input("\r");
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledWith("child-1", "first line\nsecond line", "steer"));
    } finally {
      host.unsubscribe();
      host.view.dispose();
    }
  });

  it.each([
    { columns: 90, rows: 24 },
    { columns: 120, rows: 40 },
    { columns: 40, rows: 12 },
    { columns: 24, rows: 6 },
    { columns: 12, rows: 3 },
  ])("fits $columns×$rows with a long multi-line draft", (size) => {
    const host = makeHost(size);
    try {
      host.input(`${"wide words ".repeat(12)}\x1b[13;2u${"x".repeat(80)}`);
      const lines = host.paint();
      expect(lines.length).toBeLessThanOrEqual(size.rows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns);
      // The caret row stays in view however small the screen.
      expect(lines.some((line) => line.includes("\x1b[7m"))).toBe(true);
    } finally {
      host.unsubscribe();
      host.view.dispose();
    }
  });
});
