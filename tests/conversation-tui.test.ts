import { initTheme, type ExtensionContext, type ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView } from "../src/ui/conversation.js";
import type { FabricTheme } from "../src/ui/render-types.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import { installFabricEscapeHalt } from "../src/ui/escape-halt.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  style: (_tokens: string, text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  has: () => true,
  palette: (_slot: number, text: string) => text,
  symbols: {
    pointer: "",
    bullet: "",
    checkboxOn: "",
    checkboxOff: "",
  },
} as unknown as FabricTheme;

describe("conversation through the extension UI host", () => {
  it("routes child input and restores Main without interruption", async () => {
    initTheme({ appearance: "dark" });
    const tui = {
      requestRender: vi.fn(),
      size: () => ({ rows: 24, columns: 90 }),
      suspend: <R>(run: () => Promise<R>) => run(),
    } as unknown as ExtensionUiHost;
    let ownsInput = true;
    let mainDraft = "untouched Main draft";
    const mainSubmit = vi.fn();
    let listener: ((data: string) => undefined) | undefined;
    const halt = vi.fn(() => 1);
    const context = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        onTerminalInput: (next: (data: string) => undefined) => {
          listener = next;
          return () => { listener = undefined; };
        },
      },
    } as unknown as ExtensionContext;
    const unsubscribe = installFabricEscapeHalt(context, {
      enabled: () => true, ownsInput: () => ownsInput, halted: () => false, halt,
    });
    const send = vi.fn().mockResolvedValue({ queued: true });
    const stop = vi.fn().mockResolvedValue(undefined);
    const state = new FabricConversationState();
    let view: FabricConversationView;
    const input = (data: string): void => {
      listener?.(data);
      if (ownsInput) view.handleInput(data);
      else if (data === "\r") mainSubmit();
      else mainDraft += data;
    };
    view = new FabricConversationView(tui, theme, {
      state, initialTargetId: "child-1",
      targets: () => [
        { id: "main", name: "Main", kind: "main", status: "running", canSteer: false, canFollowUp: false, canStop: false },
        { id: "child-1", parentId: "main", name: "Implementer", kind: "agent", status: "running", canSteer: true, canFollowUp: true, canStop: true },
      ],
      transcript: () => nativeTranscript([userMessage("Implement the change"), assistantMessage("Working on **the requested change**.")]),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send, stop,
      close: () => { ownsInput = false; view.dispose(); },
    });
    try {
      const { rows, columns } = tui.size();
      const lines = view.render(columns);
      expect(lines.join("\n")).toContain("Implementer");
      expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows);
      input("\x1b[200~Please check the error path\x1b[201~");
      expect(view.render(columns).join("\n")).toContain("Please check the error path");
      input("\r");
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("child-1", "Please check the error path", "steer"));
      expect(mainDraft).toBe("untouched Main draft");
      expect(mainSubmit).not.toHaveBeenCalled();
      input("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(halt).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(mainDraft).toBe("untouched Main draft");
      input(" still here");
      expect(mainDraft).toContain("still here");
      expect(mainSubmit).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      view.dispose();
    }
  });
});
