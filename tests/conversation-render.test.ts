import {
  AssistantMessageComponent,
  initThemeSync,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Text, visibleWidth, type TUI } from "@oh-my-pi/pi-tui";
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
import { highlightCode, initHighlighting } from "../src/ui/highlight.js";

// Shiki's first initialization needs real timers, and it caches into module
// state, so warm it once before any test installs the fake clock below.
beforeAll(async () => {
  initThemeSync(undefined, false, "dark");
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

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const target: FabricConversationTarget = {
  id: "child", name: "Child", kind: "agent", status: "running", cwd: "/repo/child",
  canSteer: true, canFollowUp: true, canStop: true,
};
const tui = { requestRender: vi.fn() } as unknown as TUI;

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
  outputPad: 1,
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
  it("dispatches user and assistant messages through the exact native components with native spacing", () => {
    initThemeSync(undefined, false, "dark");
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const lines = render(renderer, makeTranscript({
      messages: [
        { role: "user", content: "Please inspect **the result**.", timestamp: 1 },
        assistantMessage("A **normal OMP** response."),
      ],
    }), 80);
    const nativeUser = new UserMessageComponent("Please inspect **the result**.", undefined, [undefined]).render(80);
    const nativeAssistant = new AssistantMessageComponent(assistantMessage("A **normal OMP** response."), false, undefined, undefined, undefined).render(80);
    // Native rows in native order — no glyph/heading. The user card begins
    // with its own padded background rows; no extra spacer at transcript start.
    expect(plain(lines)).toEqual([...plain(nativeUser), ...plain(nativeAssistant)]);
    expect(lines.join("\n")).not.toContain("Agent");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("honors the thinking toggle via hideThinking", () => {
    initThemeSync(undefined, false, "dark");
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

  it("renders fabric_exec through the native OMP tool surface with Shiki truecolor", async () => {
    // The assertion is about truecolor escapes, so advertise a truecolor
    // terminal: OMP downgrades to 256-color when the environment does not.
    vi.stubEnv("COLORTERM", "truecolor");
    try {
      initThemeSync(undefined, false, "dark");
      await initHighlighting("dark-plus", true);
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
      // Constructing the tool re-resolves the preview theme, which restarts
      // Shiki. Wait on the highlighter itself so a slow or failed grammar load
      // reports as an unready highlighter rather than an unhighlighted frame.
      await vi.waitFor(() => {
        expect(highlightCode("const result = 42;\n", "typescript")).not.toBeNull();
      }, { timeout: 60_000 });
      const lines = render(renderer, makeTranscript({ tools: [tool] }), 80);
      expect(lines.join("\n")).toContain("Inspect example");
      expect(lines.join("\n")).toContain("\x1b[38;2;");
      // Same rows as constructing the native component like interactive-mode does.
      expect(plain(lines).join("\n")).toContain("done");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 90_000);

  it("passes full persisted execution details through to renderResult for partial and final updates", async () => {
    initThemeSync(undefined, false, "dark");
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
    initThemeSync(undefined, false, "dark");
    const longOutput = Array.from({ length: 61 }, (_unused, index) => `line-${index + 1}`).join("\n");
    const definition = {
      renderCall: (args: unknown, _options: unknown, _theme: Theme) => new Text(String((args as { marker: string }).marker), 0, 0) as never,
      renderResult: (result: unknown, options: { expanded: boolean }, _theme: Theme) => {
        const text = (result as { content: Array<{ text?: string }> }).content.map((block) => block.text ?? "").join("\n");
        const rows = options.expanded ? text.split("\n") : text.split("\n").slice(0, 10);
        return new Text(rows.join("\n"), 0, 0) as never;
      },
    };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition: () => definition as never });
    const tool: NativeToolExecution = {
      toolCallId: "call-3", toolName: "verbose_tool", args: { marker: "verbose" }, status: "completed",
      result: { content: [{ type: "text", text: longOutput }], details: {} }, isError: false,
    };
    const lines = render(renderer, makeTranscript({ tools: [tool] }), 120, { toolsExpanded: true });
    const text = plain(lines).join("\n");
    expect(text).toContain("line-1");
    expect(text).toContain("line-40");
    expect(text).toContain("line-61");
  });

  it("keeps tool backgrounds full width at the rightmost cell, including wrapped wide characters", () => {
    initThemeSync(undefined, false, "dark");
    const wide = "界界界界界界界界界界界界界界界界界界界界";
    const tool: NativeToolExecution = {
      toolCallId: "call-4", toolName: "fabric_exec",
      args: { code: `${wide}\nconst padded = "${wide}${wide}";` }, status: "running",
    };
    const fabricTool = fabricToolFor({ ...defaultCodePreviewSettings(), toolCallBackground: "on" });
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? fabricTool : undefined),
    });
    const width = 60;
    const lines = render(renderer, makeTranscript({ tools: [tool] }), width);
    expect(lines.length).toBeGreaterThan(0);
    // Leading/trailing empty rows are the native card Spacer(1)/padding; every
    // painted row must fill the full width with background to the last cell.
    const paintedRows = lines.filter((row) => row.length > 0);
    for (const row of paintedRows) {
      // Every card row fills the terminal width exactly…
      expect(visibleWidth(row)).toBe(width);
      // …its background spans the whole painted line…
      expect(row).toMatch(/\x1b\[48;5;\d+m|\x1b\[48;2;[\d;]+m/);
      // …and the rightmost cell is a bg-styled padding space inside the
      // background reset, never a blank unstyled cell (the far-right gap
      // regression from the screenshot).
      expect(row.endsWith(" \x1b[49m")).toBe(true);
      expect(row.endsWith("\x1b[49m ")).toBe(false);
    }
  });

  it("reuses one tool component per call across streaming frames without tool-call duplication", () => {
    initThemeSync(undefined, false, "dark");
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
    initThemeSync(undefined, false, "dark");
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
      { target: otherTarget, toolsExpanded: false, outputPad: 1 },
    )).join("\n");
    expect(second).toContain("target-B");
    expect(second).not.toContain("target-A");
    // Back to the first target: its own cached component still renders A.
    const again = plain(render(renderer, makeTranscript({ tools: [toolA] }), 100)).join("\n");
    expect(again).toContain("target-A");
    expect(again).not.toContain("target-B");
  });

  it("renders live RPC-streamed messages, not only persisted session entries", () => {
    initThemeSync(undefined, false, "dark");
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

  it("after dispose, renders nothing and stray renderer invalidations become no-ops", async () => {
    initThemeSync(undefined, false, "dark");
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
