import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { describe, expect, it, vi } from "vitest";
import { conversationFooter, readConversationAppearance } from "../src/ui/conversation-chrome.js";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { FabricConversationTranscriptRenderer } from "../src/ui/conversation-render.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import { testTheme } from "./test-theme.js";
import { viewHost } from "./view-host.js";

const theme = testTheme();
const target: FabricConversationTarget = {
  id: "child", name: "chat-test", kind: "actor", status: "idle", cwd: "/repo/child", branch: "feature/chat",
  model: "openai/child-model", thinking: "low", canSteer: true, canFollowUp: true, canStop: true,
  usage: { input: 1200, output: 400, cacheRead: 600, cacheWrite: 0, cost: 0.012 }, contextWindow: 128000,
};
const plain = (lines: readonly string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("conversation chrome", () => {
  it("draws user messages as full-width rows on the user message background", () => {
    const bg = vi.fn((_color: string, text: string) => text);
    const renderer = new FabricConversationTranscriptRenderer(viewHost(22), testTheme({ bg }));
    const lines = renderer.render(nativeTranscript([userMessage("Hello!")]), 80, { target, toolsExpanded: false });
    expect(plain(lines)).toContain(` Hello!${" ".repeat(73)}`);
    expect(bg).toHaveBeenCalledWith("userMessageBg", expect.stringContaining("Hello!"));
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("renders assistant markdown without an Agent heading", () => {
    const text = "A **normal OMP** response.";
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "fixture", timestamp: 0, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const lines = plain(new FabricConversationTranscriptRenderer(viewHost(22), theme).render(nativeTranscript([message]), 80, { target, toolsExpanded: false }));
    expect(lines.join("\n")).toContain("A normal OMP response.");
    expect(lines.join("\n")).not.toContain("Agent");
    expect(lines.join("\n")).not.toContain("**");
  });

  it("renders code fences and tool results inside the width", () => {
    const renderer = new FabricConversationTranscriptRenderer(viewHost(22), theme);
    const lines = renderer.render(nativeTranscript([
      assistantMessage("```typescript\nconst result = 42;\n```"),
      { ...assistantMessage("", 3), content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "src/example.ts" } }] },
      { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "export const fromTool = 1;" }], isError: false, timestamp: 4 },
    ]), 80, { target, toolsExpanded: true });
    const text = plain(lines).join("\n");
    expect(text).toContain("const result = 42;");
    expect(text).toContain("✓ read");
    expect(text).toContain("src/example.ts");
    expect(text).toContain("export const fromTool = 1;");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("keeps editor rules full width and the child footer below the editor", () => {
    const state = new FabricConversationState();
    state.view(target.id).draft = "draft";
    const view = new FabricConversationView(viewHost(22), theme, {
      state, targets: () => [target], initialTargetId: target.id,
      appearance: { editorPaddingX: 2 },
      transcript: () => nativeTranscript(),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    const lines = plain(view.render(120));
    const topIndex = lines.findIndex((line) => /^─+$/.test(line));
    const editorIndex = lines.findIndex((line) => line.includes("draft"));
    expect(topIndex).toBeGreaterThanOrEqual(0);
    expect(editorIndex).toBe(topIndex + 1);
    expect(visibleWidth(lines[topIndex]!)).toBe(120);
    expect(lines[editorIndex + 1]).toMatch(/^─{120}$/);
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
    const view = new FabricConversationView(viewHost(1, 40), theme, {
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
    fs.writeFileSync(path.join(agentDir, "config.yml"), "hideThinkingBlock: false\n");
    fs.writeFileSync(path.join(cwd, ".omp", "config.yml"), "hideThinkingBlock: true\n");
    try {
      await expect(readConversationAppearance(cwd, agentDir, true)).resolves.toEqual({
        editorPaddingX: 0,
        hideThinkingBlock: true,
      });
      await expect(readConversationAppearance(cwd, agentDir, false)).resolves.toEqual({
        editorPaddingX: 0,
        hideThinkingBlock: false,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
