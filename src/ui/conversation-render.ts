import type {
  ExtensionRender,
  ExtensionRows,
  ExtensionUiHost,
  MessageRenderer,
  ExtensionTheme,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/ui/styles/messages/assistant";
import "@oh-my-pi/pi-coding-agent/ui/styles/messages/user";
import { isUiNode, jsx } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { terminalSafe } from "./transcript-sanitization.js";
import type { FabricConversationTarget } from "./conversation.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";
import type { CodePreviewSettings } from "./code-preview.js";
import { disposeToolPreviewTiming } from "./code-preview-shell.js";
import type {
  NativeAgentMessage,
  NativeConversationTranscript,
  NativeToolExecution,
} from "./conversation-native-reader.js";

export type {
  NativeAgentMessage,
  NativeConversationTranscript,
} from "./conversation-native-reader.js";

type FabricToolDefinitionLike = (ToolDefinition<any, any> & { renderShell?: "default" | "self" }) | undefined;
export type FabricGetToolDefinition = (toolName: string) => FabricToolDefinitionLike;

export interface FabricConversationTranscriptRendererOptions {
  getToolDefinition?: FabricGetToolDefinition;
  getMessageRenderer?: ((customType: string) => MessageRenderer | undefined) | undefined;
  hiddenThinkingLabel?: string | undefined;
  imageWidthCells?: number | undefined;
}

export interface FabricConversationTranscriptRenderOptions {
  target: FabricConversationTarget;
  toolsExpanded: boolean;
  outputPad?: 0 | 1;
  codeBlockIndent?: string;
  codePreviewSettings?: CodePreviewSettings | undefined;
  hideThinking?: boolean;
  showImages?: boolean;
}

type BashExecutionAgentMessage = Extract<NativeAgentMessage, { role: "bashExecution" }>;
type CustomAgentMessage = Extract<NativeAgentMessage, { role: "custom" }>;

type Renderable = { render(width: number): readonly string[] };

type ToolRenderState = {
  name: string;
  definition: FabricToolDefinitionLike;
  state: Record<string, unknown>;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
};

const safeRender = (component: Renderable, width: number, fallback: () => string[]): string[] => {
  try {
    return [...component.render(width)];
  } catch {
    return fallback();
  }
};

export class FabricConversationTranscriptRenderer {
  private disposed = false;
  private readonly tools = new Map<string, Map<string, ToolRenderState>>();
  private readonly requestRender = (): void => {
    if (!this.disposed) this.ui.requestRender();
  };

  constructor(
    private readonly ui: ExtensionUiHost,
    private readonly theme: ExtensionTheme,
    private readonly rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {}

  invalidate(): void {
    if (this.disposed) return;
    this.clearTools();
    this.ui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTools();
  }

  private clearTools(): void {
    for (const calls of this.tools.values()) {
      for (const { state } of calls.values()) disposeToolPreviewTiming(state);
    }
    this.tools.clear();
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    if (this.disposed || width <= 0) return [];
    const lines: string[] = [];
    if (transcript.messages.length === 0 && !transcript.streaming.partialAssistant && transcript.streaming.tools.length === 0) {
      return [this.theme.fg("dim", "No retained transcript yet; new agent activity will appear here.")];
    }
    if (transcript.hasMore) lines.push(this.theme.fg("dim", "↑ older activity available"));
    const tools = new Map(transcript.streaming.tools.map(tool => [tool.toolCallId, tool]));
    for (const message of transcript.messages) {
      if (message.role !== "toolResult") continue;
      tools.set(message.toolCallId, {
        ...tools.get(message.toolCallId),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        status: message.isError ? "failed" : "completed",
        result: message,
        isError: message.isError,
      });
    }
    const renderedTools = new Set<string>();
    const drawTool = (tool: NativeToolExecution): void => {
      if (renderedTools.has(tool.toolCallId)) return;
      renderedTools.add(tool.toolCallId);
      lines.push(...this.renderTool(tool, width, options));
    };
    for (const message of transcript.messages) this.renderMessage(message, width, options, lines, tools, drawTool);
    if (transcript.streaming.partialAssistant) {
      this.renderAssistant(transcript.streaming.partialAssistant, width, options, lines, tools, drawTool, true);
    }
    for (const tool of tools.values()) drawTool(tool);
    if (transcript.hasNewer) lines.push(this.theme.fg("dim", "↓ newer activity available"));
    return lines;
  }

  private renderMessage(message: NativeAgentMessage, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], tools: ReadonlyMap<string, NativeToolExecution>, drawTool: (tool: NativeToolExecution) => void): void {
    switch (message.role) {
      case "user": {
        const raw = textOf(message.content);
        const text = unwrapActorEnvelopeText(raw) ?? raw;
        if (text) lines.push(...this.nodeRows(jsx("card", {
          role: "omp.user", tone: "user", term: { zones: false },
          children: jsx("md", { text: terminalSafe(text, false) }),
        }), width));
        return;
      }
      case "assistant":
        this.renderAssistant(message, width, options, lines, tools, drawTool, false);
        return;
      case "toolResult":
        if (tools.has(message.toolCallId)) drawTool(tools.get(message.toolCallId)!);
        return;
      case "bashExecution":
        this.renderBash(message, width, lines);
        return;
      case "custom":
        this.renderCustom(message, width, lines);
        return;
      case "compactionSummary":
      case "branchSummary":
        lines.push(...this.message(message.summary, width));
        return;
      default:
        return;
    }
  }

  private renderAssistant(message: Extract<NativeAgentMessage, { role: "assistant" }>, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], tools: ReadonlyMap<string, NativeToolExecution>, drawTool: (tool: NativeToolExecution) => void, transient: boolean): void {
    let children: ReturnType<typeof jsx>[] = [];
    const flush = (): void => {
      if (!children.length) return;
      lines.push(...this.nodeRows(jsx("col", { role: "omp.assistant", children }), width));
      children = [];
    };
    for (const [index, block] of message.content.entries()) {
      if (block.type === "toolCall") {
        flush();
        const tool = tools.get(block.id);
        drawTool({
          toolCallId: block.id,
          toolName: block.name,
          status: message.stopReason === "error" ? "failed" : "running",
          ...tool,
          args: tool?.args ?? block.arguments,
        });
      } else if (block.type === "text" && block.text) {
        children.push(jsx("md", { text: terminalSafe(block.text, false), stream: transient && index === message.content.length - 1 }));
      } else if (block.type === "thinking" && block.thinking && !options.hideThinking) {
        children.push(jsx("section", {
          role: "omp.thinking", term: { spaceAfter: true },
          children: jsx("md", { text: terminalSafe(block.thinking, false) }),
        }));
      }
    }
    flush();
  }

  private renderTool(tool: NativeToolExecution, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    const { toolCallId, toolName, args, result, partial, status } = tool;
    let calls = this.tools.get(options.target.id);
    if (!calls) this.tools.set(options.target.id, calls = new Map());
    let entry = calls.get(toolCallId);
    if (!entry || entry.name !== toolName) {
      if (entry) disposeToolPreviewTiming(entry.state);
      entry = { name: toolName, definition: this.rendererOptions.getToolDefinition?.(toolName), state: {} };
      calls.set(toolCallId, entry);
    }
    const { definition, state } = entry;
    const isPartial = status === "running";
    const isError = tool.isError ?? status === "failed";
    const toolOptions = {
      expanded: options.toolsExpanded,
      isPartial,
      renderContext: {
        toolCallId, state, invalidate: this.requestRender,
        cwd: options.target.cwd ?? process.cwd(),
        executionStarted: tool.executionStarted ?? false,
        argsComplete: tool.argsComplete ?? !isPartial,
        showImages: options.showImages ?? true,
        isError,
      },
    };
    const raw = result ?? partial;
    const output = raw && definition?.renderResult
      ? definition.renderResult({
          content: raw.content ?? [], details: raw.details, ...(isError ? { isError: true } : {}),
        } as Parameters<NonNullable<typeof definition.renderResult>>[0], toolOptions, this.theme, args)
      : definition?.renderCall?.(args, toolOptions, this.theme);
    const shell = definition?.renderShell ?? options.codePreviewSettings?.toolCallBackground ?? "default";
    const boxed = width > 2 && shell !== "self" && shell !== "off" && shell !== "border";
    const inner = boxed ? width - 2 : width;
    let rows = this.nodeRows(output, inner);
    if (output == null) {
      const text = textOf(raw?.content);
      const body = text ? terminalSafe(text, false).split("\n") : [];
      const summary = args && Object.values(args).find(value => typeof value === "string" && value.length > 0);
      rows = this.fallback(summary ? `${toolName} ${summary}` : toolName, inner);
      for (const line of options.toolsExpanded ? body : body.slice(0, 4)) rows.push(...wrap(line, inner));
    }
    if (!boxed || rows.length === 0) return rows;
    const bg = isError ? "toolErrorBg" : isPartial ? "toolPendingBg" : "toolSuccessBg";
    const theme = this.theme as ExtensionTheme & { bgFill?(key: string, text: string): string };
    const fill = (line: string): string => theme.bgFill?.(bg, line) ?? theme.bg(bg, line);
    const blank = fill(" ".repeat(width));
    const painted = [blank];
    for (const row of rows) {
      for (const line of row.split("\n")) {
        for (const part of visibleWidth(line) > inner ? wrap(line, inner) : [line]) {
          painted.push(fill(` ${truncate(part, inner, "", true)} `));
        }
      }
    }
    painted.push(blank);
    return painted;
  }

  private nodeRows(output: ExtensionRender, width: number): string[] {
    if (typeof output === "string") return [output];
    if (typeof output === "number" || typeof output === "boolean" || output === null || output === undefined) return [];
    if (Array.isArray(output)) return output.flatMap((item) => this.nodeRows(item as ExtensionRender, width));
    if (typeof output === "function") return this.nodeRows(output(), width);
    if (isUiNode(output)) return [...renderBlock(output, width, { theme: this.theme }).rows];
    const rows = output as ExtensionRows;
    return [...safeRender(rows, width, () => [])];
  }

  private renderBash(message: BashExecutionAgentMessage, width: number, lines: string[]): void {
    const text = [message.command, message.output ?? ""].filter(Boolean).join("\n");
    lines.push(...this.message(text, width));
  }

  private renderCustom(message: CustomAgentMessage, width: number, lines: string[]): void {
    const text = textOf(message.content);
    if (!message.display || !text) return;
    const output = this.rendererOptions.getMessageRenderer?.(message.customType)?.(message, { expanded: false }, this.theme);
    if (output != null) lines.push(...this.nodeRows(output, width));
    else lines.push(...this.message(text, width));
  }

  private message(text: string, width: number): string[] {
    return renderMarkdown(terminalSafe(text, false), width, { theme: this.theme });
  }

  private fallback(text: string, width: number): string[] {
    return terminalSafe(text, false).split("\n").flatMap((line) => wrap(line, Math.max(1, width)).map((item) => this.theme.fg("text", item)));
  }
}
