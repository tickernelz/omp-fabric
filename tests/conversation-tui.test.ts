import { getSymbolTheme, initThemeSync, type ExtensionContext, type Theme } from "@oh-my-pi/pi-coding-agent";
import { Editor, Text, TUI, visibleWidth, type OverlayHandle, type Terminal } from "@oh-my-pi/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView } from "../src/ui/conversation.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import { installFabricEscapeHalt } from "../src/ui/escape-halt.js";

class ProbeTerminal implements Terminal {
  columns = 90;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  input: (data: string) => void = () => {};
  appearance: "dark" | "light" | undefined = undefined;
  start(onInput: (data: string) => void, _onResize: () => void, _onDisconnect?: () => void): void { this.input = onInput; }
  stop(): void { this.input = () => {}; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  kittyEnableSequence = "";
  onAppearanceChange(_callback: (appearance: "dark" | "light", requestToken?: number) => void): void {}
}
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  symbols: {
    pointer: "",
    bullet: "",
    checkboxOn: "",
    checkboxOff: "",
  },
} as unknown as Theme;

describe("conversation through the real OMP TUI", () => {
  it("routes child input and restores Main without interruption", async () => {
    initThemeSync(undefined, false, "dark");
    const terminal = new ProbeTerminal();
    const tui = new TUI(terminal);
    const main = new Editor({
      borderColor: (text: string) => text,
      symbols: getSymbolTheme(),
      selectList: {
        symbols: getSymbolTheme(),
        selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
        description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text,
      },
    });
    main.setText("untouched Main draft");
    const mainSubmit = vi.fn();
    main.onSubmit = mainSubmit;
    tui.addChild(new Text("Main conversation keeps its history"));
    tui.addChild(main);
    tui.setFocus(main);
    tui.start();
    let ownsInput = true;
    let handle: OverlayHandle | undefined;
    const halt = vi.fn(() => 1);
    const context = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        onTerminalInput: (listener: (data: string) => undefined) => tui.addInputListener(listener),
      },
    } as unknown as ExtensionContext;
    const unsubscribe = installFabricEscapeHalt(context, {
      enabled: () => true, ownsInput: () => ownsInput, halted: () => false, halt,
    });
    const send = vi.fn().mockResolvedValue({ queued: true });
    const stop = vi.fn().mockResolvedValue(undefined);
    const state = new FabricConversationState();
    const view = new FabricConversationView(tui, theme, {
      state, initialTargetId: "child-1",
      targets: () => [
        { id: "main", name: "Main", kind: "main", status: "running", canSteer: false, canFollowUp: false, canStop: false },
        { id: "child-1", parentId: "main", name: "Implementer", kind: "agent", status: "running", canSteer: true, canFollowUp: true, canStop: true },
      ],
      transcript: () => nativeTranscript([userMessage("Implement the change"), assistantMessage("Working on **the requested change**.")]),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send, stop,
      close: () => { ownsInput = false; handle?.hide(); view.dispose(); },
    });
    handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
    try {
      const lines = view.render(terminal.columns);
      expect(lines.join("\n")).toContain("Implementer");
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(terminal.rows);
      terminal.input("Please check the error path");
      terminal.input("\r");
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("child-1", "Please check the error path", "steer"));
      expect(main.getText()).toBe("untouched Main draft");
      expect(mainSubmit).not.toHaveBeenCalled();
      terminal.input("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(halt).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(main.getText()).toBe("untouched Main draft");
      terminal.input(" still here");
      expect(main.getText()).toContain("still here");
      expect(mainSubmit).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      handle!.hide();
      view.dispose();
      tui.stop();
    }
  });
});
