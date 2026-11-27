import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFabricPersistedExecutionDetails } from "../src/audit/index.js";
import { FabricExecutionTraceRecorder } from "../src/audit/trace.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import {
  FabricConversationTranscriptRenderer,
  type FabricConversationTranscriptRenderOptions,
  type FabricGetToolDefinition,
} from "../src/ui/conversation-render.js";
import type {
  NativeConversationTranscript,
  NativeToolExecution,
} from "../src/ui/conversation-native-reader.js";
import type { FabricConversationTarget } from "../src/ui/conversation.js";
import { initHighlighting } from "../src/ui/highlight.js";
import { testTheme } from "./test-theme.js";
import { viewHost } from "./view-host.js";

// Shiki's first initialization needs real timers, and it caches into module
// state, so warm it once before any test installs the fake clock below.
beforeAll(async () => {
  await initHighlighting("dark-plus", true);
}, 30_000);

// Spinner frames tick every 250ms; pin the clock so ANSI/wrap assertions are
// deterministic across GC pauses.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const theme = testTheme();

const target: FabricConversationTarget = {
  id: "child", name: "Child", kind: "agent", status: "running", cwd: "/repo/child",
  canSteer: true, canFollowUp: true, canStop: true,
};
const tui = viewHost();

const stateFor = (toolDisplay: "full" | "compact") =>
  ({
    bootstrapped: true,
    initialized: true,
    config: { ui: { showAgentToolPreview: true, toolDisplay } },
  }) as unknown as FabricState;

const fabricToolFor = (codePreviewSettings = defaultCodePreviewSettings()) =>
  createFabricExecTool(stateFor("full"), codePreviewSettings, new Map());

const makeTranscript = (overrides: {
  messages?: NativeConversationTranscript["messages"];
  tools?: NativeToolExecution[];
  partialAssistant?: AssistantMessage;
  hasMore?: boolean;
} = {}): NativeConversationTranscript => ({
  messages: overrides.messages ?? [],
  entries: [],
  streaming: {
    active: (overrides.tools?.length ?? 0) > 0 || overrides.partialAssistant !== undefined,
    ...(overrides.partialAssistant ? { partialAssistant: overrides.partialAssistant } : {}),
    tools: overrides.tools ?? [],
  },
  revision: 0,
  leafId: null,
  sourceId: target.id,
  status: target.status,
  historyComplete: true,
  hasMore: overrides.hasMore ?? false,
  hasNewer: false,
  updatedAt: 0,
});

const assistantMessage = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  timestamp: 1,
  stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...extra,
});

const renderOptions = (
  overrides: Partial<FabricConversationTranscriptRenderOptions> = {},
): FabricConversationTranscriptRenderOptions => ({
  target,
  toolsExpanded: false,
  ...overrides,
});

const render = (
  renderer: FabricConversationTranscriptRenderer,
  transcript: NativeConversationTranscript,
  width = 80,
  options: Partial<FabricConversationTranscriptRenderOptions> = {},
) => renderer.render(transcript, width, renderOptions(options));

const plain = (lines: readonly string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("focused conversation native component rendering", () => {
  it("renders user prompts and assistant markdown in transcript order", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const lines = plain(render(renderer, makeTranscript({
      messages: [
        { role: "user", content: "Please inspect **the result**.", timestamp: 1 },
        assistantMessage("A **normal OMP** response."),
      ],
    }), 80));
    const user = lines.findIndex((line) => line.includes("Please inspect **the result**."));
    const assistant = lines.findIndex((line) => line.includes("A normal OMP response."));
    expect(user).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeGreaterThan(user);
    expect(renderer.promptRows).toEqual([user]);
    expect(lines.join("\n")).not.toContain("Agent");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("honors the thinking toggle via hideThinking", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const message = assistantMessage("Answer");
    message.content = [
      { type: "thinking", thinking: "secret reasoning" } as never,
      { type: "text", text: "Answer" },
    ];
    const transcript = makeTranscript({ messages: [message] });
    const shown = plain(render(renderer, transcript, 80, { hideThinking: false })).join("\n");
    const hidden = plain(render(renderer, transcript, 80, { hideThinking: true })).join("\n");
    expect(shown).toContain("secret reasoning");
    expect(hidden).not.toContain("secret reasoning");
    expect(hidden).toContain("Answer");
  });

  it("renders fabric_exec through its own call and result renderers", () => {
    const fabricTool = fabricToolFor();
    const getToolDefinition: FabricGetToolDefinition = (name) =>
      name === "fabric_exec" ? fabricTool : undefined;
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition });
    const args = {
      code: "const result = await omp.read({ path: \"src/example.ts\" });\nreturn result;",
      display: { name: "Inspect example" },
    };
    const tool: NativeToolExecution = {
      toolCallId: "call-1", toolName: "fabric_exec", args, status: "completed",
      result: { content: [{ type: "text", text: "done" }], details: {} }, isError: false,
    };
    const text = plain(render(renderer, makeTranscript({ tools: [tool] }), 80)).join("\n");
    expect(text).toContain("Inspect example");
    expect(text).toContain("omp.read");
    expect(text).toContain("done");
  });

  it("passes full persisted execution details through to renderResult for partial and final updates", async () => {
    await initHighlighting("dark-plus", true);
    const fabricTool = fabricToolFor();
    const toolCallRecords: Array<{ result: unknown; options: { isPartial: boolean } }> = [];
    const renderResult = vi.fn((result: Parameters<NonNullable<typeof fabricTool.renderResult>>[0], options: { isPartial: boolean; expanded: boolean }) => {
      // OMP passes its live mutable render-state object by reference; snapshot
      // the relevance flag at call time so later frames cannot overwrite it.
      toolCallRecords.push({ result, options: { isPartial: options.isPartial === true } });
      return fabricTool.renderResult!(result, options, theme as never, undefined as never);
    });
    const wrapped = { ...fabricTool, renderResult };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? wrapped : undefined),
    });
    const args = { code: "return await omp.bash({ command: \"echo hi\" });" };
    const recorder = new FabricExecutionTraceRecorder();
    const partialDetails = createFabricPersistedExecutionDetails({
      success: true,
      trace: recorder.seal("succeeded", [], "partial"),
      audits: [{ ref: "omp.bash", provider: "omp", tool: "bash", args: { command: "echo hi" } }],
    });
    const finalRecorder = new FabricExecutionTraceRecorder();
    const finalDetails = createFabricPersistedExecutionDetails({
      success: true,
      trace: finalRecorder.seal("succeeded", [], "final"),
      audits: [{ ref: "omp.bash", provider: "omp", tool: "bash", args: { command: "echo hi" }, success: true, result: "hi" }],
    });
    const running: NativeToolExecution = {
      toolCallId: "call-2", toolName: "fabric_exec", args, status: "running", partial: { details: partialDetails },
    };
    render(renderer, makeTranscript({ tools: [running] }), 100);
    const finished: NativeToolExecution = {
      toolCallId: "call-2", toolName: "fabric_exec", args, status: "completed",
      result: { content: [{ type: "text", text: "hi" }], details: finalDetails }, isError: false,
    };
    render(renderer, makeTranscript({ tools: [finished] }), 100);
    const calls = renderResult.mock.calls;
    const partialCall = toolCallRecords.find((record) => record.options.isPartial === true);
    const finalCall = toolCallRecords.find((record) => record.options.isPartial === false);
    expect(partialCall?.result).toEqual({ content: [], details: partialDetails });
    expect(finalCall?.result).toEqual({ content: [{ type: "text", text: "hi" }], details: finalDetails });
    // No redaction or cloning en route: the persisted details pass through verbatim.
    expect(finalCall?.result).toMatchObject({ details: finalDetails });
    const finalDetailsRecord = toolCallRecords.find((record) => (record.result as { details?: unknown }).details === finalDetails);
    expect(finalDetailsRecord).toBeDefined();
  }, 15000);

  it("does not cap expanded tool output at 40 lines", () => {
    const longOutput = Array.from({ length: 61 }, (_unused, index) => `line-${index + 1}`).join("\n");
    const definition = {
      renderCall: (args: { marker: string }) => ({ render: () => [args.marker] }),
      renderResult: (result: { content: Array<{ text?: string }> }, options: { expanded: boolean }) => {
        const text = result.content.map((block) => block.text ?? "").join("\n");
        const rows = options.expanded ? text.split("\n") : text.split("\n").slice(0, 10);
        return { render: () => rows };
      },
    };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition: () => definition as never });
    const tool: NativeToolExecution = {
      toolCallId: "call-3", toolName: "verbose_tool", args: { marker: "verbose" }, status: "completed",
      result: { content: [{ type: "text", text: longOutput }], details: {} }, isError: false,
    };
    const lines = render(renderer, makeTranscript({ tools: [tool] }), 120, { toolsExpanded: true });
    const text = plain(lines).join("\n");
    expect(text).toContain("verbose");
    expect(text).toContain("line-1");
    expect(text).toContain("line-40");
    expect(text).toContain("line-61");
  });

  it("reuses one tool component per call across streaming frames without tool-call duplication", () => {
    const getToolDefinition = vi.fn(((name: string) =>
      name === "fabric_exec" ? {} : undefined) as FabricGetToolDefinition);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition });
    const partial: AssistantMessage = {
      ...assistantMessage("Working…"),
      content: [
        { type: "toolCall", id: "call-5", name: "fabric_exec", arguments: { code: "return 1;" } } as never,
      ],
    };
    const tool: NativeToolExecution = {
      toolCallId: "call-5", toolName: "fabric_exec", args: { code: "return 1;" }, status: "running",
    };
    const frame = (): string =>
      plain(render(renderer, makeTranscript({ partialAssistant: partial, tools: [tool] }), 80))
        .filter((line) => line.length > 0)
        .join("\n");
    const first = frame();
    const second = frame();
    expect(getToolDefinition).toHaveBeenCalledTimes(1); // component reused, not recreated
    expect(second).toBe(first);
    expect(first.split("fabric_exec").length).toBe(2); // exactly one card title
  });

  it("isolates the component cache between targets with identical tool call ids", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: () => undefined, // native generic card path
    });
    const toolA: NativeToolExecution = {
      toolCallId: "shared-call", toolName: "bash", args: { command: "echo target-A" }, status: "completed",
      result: { content: [{ type: "text", text: "target-A" }], details: {} }, isError: false,
    };
    const first = plain(render(renderer, makeTranscript({ tools: [toolA] }), 100)).join("\n");
    expect(first).toContain("target-A");
    const toolB: NativeToolExecution = {
      toolCallId: "shared-call", toolName: "bash", args: { command: "echo target-B" }, status: "completed",
      result: { content: [{ type: "text", text: "target-B" }], details: {} }, isError: false,
    };
    const otherTarget = { ...target, id: "other" };
    const second = plain(renderer.render(
      makeTranscript({ tools: [toolB] }), 100,
      { target: otherTarget, toolsExpanded: false },
    )).join("\n");
    expect(second).toContain("target-B");
    expect(second).not.toContain("target-A");
    // Back to the first target: its own cached component still renders A.
    const again = plain(render(renderer, makeTranscript({ tools: [toolA] }), 100)).join("\n");
    expect(again).toContain("target-A");
    expect(again).not.toContain("target-B");
  });

  it("renders live RPC-streamed messages, not only persisted session entries", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const transcript = makeTranscript({
      messages: [
        { role: "user", content: "streamed prompt", timestamp: 1 },
        assistantMessage("streamed answer"),
      ],
      partialAssistant: { ...assistantMessage("partial tail"), stopReason: "aborted" },
    });
    const text = plain(render(renderer, transcript, 80)).join("\n");
    expect(text).toContain("streamed prompt");
    expect(text).toContain("streamed answer");
    expect(text).toContain("partial tail");
  });

  it("redraws streamed text and tool output when the reader replaces them", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition: () => undefined });
    const frame = (transcript: NativeConversationTranscript) => plain(render(renderer, transcript, 80)).join("\n");
    const partial = assistantMessage("first words");
    const running: NativeToolExecution = {
      toolCallId: "call-7", toolName: "bash", args: { command: "make" }, status: "running",
      partial: { content: [{ type: "text", text: "step one" }] },
    };
    const before = frame(makeTranscript({ partialAssistant: { ...partial, content: [...partial.content] }, tools: [{ ...running }] }));
    expect(before).toContain("first words");
    expect(before).toContain("step one");
    const after = frame(makeTranscript({
      partialAssistant: { ...partial, content: [{ type: "text", text: "first words and more" }] },
      tools: [{ ...running, status: "completed", result: { content: [{ type: "text", text: "build done" }] }, isError: false }],
    }));
    expect(after).toContain("first words and more");
    expect(after).toContain("build done");
    expect(after).not.toContain("step one");
  });

  it("after dispose, renders nothing and stray renderer invalidations become no-ops", async () => {
    await initHighlighting("dark-plus", true);
    const fabricTool = fabricToolFor();
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? fabricTool : undefined),
    });
    const tool: NativeToolExecution = {
      toolCallId: "call-6", toolName: "fabric_exec", args: { code: "return 1;" }, status: "running",
    };
    expect(render(renderer, makeTranscript({ tools: [tool] }), 80).length).toBeGreaterThan(0);
    renderer.dispose();
    const renderCalls = vi.mocked(tui.requestRender).mock.calls.length;
    renderer.invalidate(); // stray live invalidation after dispose
    expect(vi.mocked(tui.requestRender).mock.calls.length).toBe(renderCalls);
    expect(renderer.render(makeTranscript({ tools: [tool] }), 80, renderOptions())).toEqual([]);
  }, 15000);
});
