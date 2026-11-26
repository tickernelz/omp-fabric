import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth, type HostSurface as TUI } from "../src/ui/rows.js";
import { describe, expect, it, vi } from "vitest";
import { conversationFooter, readConversationAppearance } from "../src/ui/conversation-chrome.js";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { FabricConversationTranscriptRenderer } from "../src/ui/conversation-render.js";
import { highlightCode, initHighlighting } from "../src/ui/highlight.js";
import { nativeTranscript, assistantMessage } from "./fixtures/native-conversation.js";

const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const target: FabricConversationTarget = {
  id: "child", name: "chat-test", kind: "actor", status: "idle", cwd: "/repo/child", branch: "feature/chat",
  model: "openai/child-model", thinking: "low", canSteer: true, canFollowUp: true, canStop: true,
  usage: { input: 1200, output: 400, cacheRead: 600, cacheWrite: 0, cost: 0.012 }, contextWindow: 128000,
};
const tui = { terminal: { rows: 22, columns: 120, write: vi.fn() }, requestRender: vi.fn() } as unknown as TUI;
const plain = (lines: readonly string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
// Colour assertions need OMP's real theme: the stub theme draws no escapes.
const darkTheme = async (): Promise<Theme> => {
  const resolved = await getThemeByName("dark");
  if (!resolved) throw new Error("OMP dark theme unavailable");
  return resolved;
};

describe("native conversation chrome", () => {
  it("renders Shiki truecolor fences and native tool backgrounds", async () => {
    // The assertion is about truecolor escapes, so advertise a truecolor
    // terminal: OMP downgrades to 256-color when the environment does not.
    vi.stubEnv("COLORTERM", "truecolor");
    try {
      initTheme({ appearance: "dark" });
      await initHighlighting("dark-plus", true);
      const renderer = new FabricConversationTranscriptRenderer(tui, await darkTheme());
      // Constructing the renderer re-resolves the preview theme, which restarts
      // Shiki. Wait on the highlighter itself so a slow or failed grammar load
      // reports as an unready highlighter rather than an unhighlighted frame.
      await vi.waitFor(() => {
        expect(highlightCode("const result = 42;\n", "typescript")).not.toBeNull();
      }, { timeout: 60_000 });
      const lines = renderer.render(nativeTranscript([
        assistantMessage("```typescript\nconst result = 42;\n```"),
        { ...assistantMessage("", 3), content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "src/example.ts" } }] },
        { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "const result = 42;" }], isError: false, timestamp: 4 },
      ]), 80, { target, toolsExpanded: true, codeBlockIndent: "    " });
      expect(lines.join("\n")).toContain("\x1b[38;2;");
      expect(lines.some((line) => line.includes("\x1b[48;"))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
      expect(plain(lines).find((line) => line.includes("const result"))?.trim()).toBe("const result = 42;");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 90_000);

  it("keeps the child footer below the editor within the terminal width", () => {
    const state = new FabricConversationState();
    state.view(target.id).draft = "draft";
    const view = new FabricConversationView(tui, theme, {
      state, targets: () => [target], initialTargetId: target.id,
      appearance: { editorPaddingX: 2, outputPad: 1 },
      transcript: () => nativeTranscript(),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    const lines = plain(view.render(120));
    const editorIndex = lines.findIndex((line) => line.includes("draft"));
    expect(editorIndex).toBeGreaterThanOrEqual(0);
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
    const footerIndex = lines.findIndex((line) => line.includes("/repo/child (feature/chat)"));
    expect(footerIndex).toBeGreaterThan(editorIndex);
    expect(lines[footerIndex + 1]).toContain("run ↑1.2k ↓400 R600 $0.012");
    expect(lines[footerIndex + 1]).toContain("?/128k ctx");
    expect(lines[footerIndex + 1]).toMatch(/openai\/child-model • low$/);
    view.dispose();
  });

  it("keeps the draft cursor visible in a one-row terminal", () => {
    const state = new FabricConversationState();
    state.view(target.id).draft = "visible draft";
    const view = new FabricConversationView({ ...tui, terminal: { rows: 1, columns: 40, write: vi.fn() } } as unknown as TUI, theme, {
      state, targets: () => [target], transcript: () => nativeTranscript(),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    const lines = plain(view.render(40));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("visible draft");
    view.dispose();
  });

  it("does not invent usage or current context occupancy", () => {
    const { usage: _usage, contextWindow: _context, ...unknown } = target;
    const lines = conversationFooter(unknown, theme, 120);
    expect(lines[1]).toContain("usage unavailable");
    expect(lines[1]).toContain("ctx ?");
    expect(lines[1]).not.toContain("$0");
    expect(lines[1]).not.toContain("0%");
    for (const width of [1, 2, 8, 30, 80, 120]) {
      expect(conversationFooter(target, theme, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("reads trusted settings and uses isolated defaults when untrusted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-chrome-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "config.yml"), "terminal:\n  showImages: false\nhideThinkingBlock: false\n");
    fs.writeFileSync(path.join(cwd, ".omp", "config.yml"), "hideThinkingBlock: true\n");
    try {
      await expect(readConversationAppearance(cwd, agentDir, true)).resolves.toMatchObject({
        editorPaddingX: 0,
        outputPad: 0,
        codeBlockIndent: "  ",
        hideThinkingBlock: true,
        showImages: false,
      });
      await expect(readConversationAppearance(cwd, agentDir, false)).resolves.toMatchObject({
        editorPaddingX: 0,
        outputPad: 0,
        codeBlockIndent: "  ",
        hideThinkingBlock: false,
        showImages: true,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
