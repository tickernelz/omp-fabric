import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { mountView } from "../src/ui/tui/view.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import { testTheme } from "./test-theme.js";

const targets = (): FabricConversationTarget[] => [
  { id: "main", name: "Main", kind: "main", status: "running", canSteer: false, canFollowUp: false, canStop: false },
  { id: "child-1", parentId: "main", name: "Implementer", kind: "agent", status: "running", canSteer: true, canFollowUp: true, canStop: true },
];

const longTranscript = () =>
  nativeTranscript(Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? userMessage(`question ${index}`) : assistantMessage(`answer ${index}`)));

const openConversation = (options: { transcript?: () => ReturnType<typeof nativeTranscript> } = {}) => {
  const send = vi.fn().mockResolvedValue({ queued: true });
  const close = vi.fn();
  const { node, view } = mountView(() => ({ columns: 90, rows: 24 }), (host) =>
    new FabricConversationView(host, testTheme(), {
      state: new FabricConversationState(),
      initialTargetId: "child-1",
      targets,
      transcript: options.transcript ?? (() =>
        nativeTranscript([userMessage("Implement the change"), assistantMessage("Working on **the requested change**.")])),
      loadOlder: () => false,
      loadNewer: () => false,
      loadLatest: () => false,
      send,
      stop: vi.fn().mockResolvedValue(undefined),
      close,
    }));
  const term = createTestTerminal(() => ({ main: node }), { columns: 90, rows: 24 });
  term.focus(node);
  return { term, view, send, close };
};

describe("conversation through the pi-tui terminal backend", () => {
  it("routes typed keys and Enter from the focused canvas to the selected child", async () => {
    const { term, view, send, close } = openConversation();
    try {
      expect(term.screen().join("\n")).toContain("Implementer");
      expect(term.screen().join("\n")).toContain("the requested change");
      term.type("Please check the error path");
      expect(term.screen().join("\n")).toContain("Please check the error path");
      term.press("enter", { text: "\r" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("child-1", "Please check the error path", "steer"));
      term.press("escape", { text: "\x1b" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      view.dispose();
      term.dispose();
    }
  });

  it("delivers pastes as one edit", () => {
    const { term, view, send } = openConversation();
    try {
      term.paste("first line\nsecond line");
      const screen = term.screen().join("\n");
      expect(screen).toContain("first line");
      expect(screen).toContain("second line");
      expect(send).not.toHaveBeenCalled();
    } finally {
      view.dispose();
      term.dispose();
    }
  });

  it("scrolls the transcript with the mouse wheel through the view's hit region", () => {
    const { term, view } = openConversation({ transcript: longTranscript });
    try {
      expect(term.screen().join("\n")).toContain("answer 39");
      for (let notch = 0; notch < 40; notch++) {
        term.mouse({ row: 3, col: 10, button: "wheel-up", action: "press", mods: [] });
      }
      const scrolled = term.screen().join("\n");
      expect(scrolled).not.toContain("answer 39");
      expect(scrolled).toContain("question 0");
    } finally {
      view.dispose();
      term.dispose();
    }
  });
});
