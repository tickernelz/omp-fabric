import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  type MessageRenderer,
  type Theme,
  ToolExecutionComponent,
  type ToolDefinition,
  UserMessageComponent,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { terminalSafe } from "./transcript-sanitization.js";
import type { FabricConversationTarget } from "./conversation.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";
import type { CodePreviewSettings } from "./code-preview.js";
import type {
  NativeAgentMessage,
  NativeConversationTranscript,
} from "./conversation-native-reader.js";

export type {
  NativeAgentMessage,
  NativeConversationTranscript,
} from "./conversation-native-reader.js";

type FabricToolDefinitionLike = ToolDefinition<any, any> | undefined;
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

type UserAgentMessage = Extract<NativeAgentMessage, { role: "user" }>;
type ToolResultAgentMessage = Extract<NativeAgentMessage, { role: "toolResult" }>;
type BashExecutionAgentMessage = Extract<NativeAgentMessage, { role: "bashExecution" }>;
type CustomAgentMessage = Extract<NativeAgentMessage, { role: "custom" }>;
type CompactionSummaryAgentMessage = Extract<NativeAgentMessage, { role: "compactionSummary" }>;
type BranchSummaryAgentMessage = Extract<NativeAgentMessage, { role: "branchSummary" }>;

type Renderable = { render(width: number): readonly string[] };

const stableKey = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return String(value);
  }
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
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  private readonly assistantComponents = new Map<string, AssistantMessageComponent>();
  private readonly messageComponents = new Map<string, Renderable>();

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {}

  invalidate(): void {
    if (this.disposed) return;
    this.toolComponents.clear();
    this.assistantComponents.clear();
    this.messageComponents.clear();
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    if (this.disposed || width <= 0) return [];
    const lines: string[] = [];
    if (transcript.messages.length === 0 && !transcript.streaming.partialAssistant && transcript.streaming.tools.length === 0) {
      return [this.theme.fg("dim", "No retained transcript yet; new agent activity will appear here.")];
    }
    if (transcript.hasMore) lines.push(this.theme.fg("dim", "↑ older activity available"));
    const renderedTools = new Set<string>();
    for (const message of transcript.messages) this.renderMessage(message, width, options, lines, renderedTools);
    if (transcript.streaming.partialAssistant) {
      this.renderAssistant(transcript.streaming.partialAssistant, width, options, lines, renderedTools, true);
    }
    for (const tool of transcript.streaming.tools) {
      if (renderedTools.has(tool.toolCallId)) continue;
      renderedTools.add(tool.toolCallId);
      this.renderTool(tool.toolCallId, tool.toolName, tool.args, tool.result, tool.partial, tool.isError, width, options, lines, true);
    }
    if (transcript.hasNewer) lines.push(this.theme.fg("dim", "↓ newer activity available"));
    return lines;
  }

  private renderMessage(message: NativeAgentMessage, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], renderedTools: Set<string>): void {
    switch (message.role) {
      case "user": {
        const text = unwrapActorEnvelopeText(textOf(message.content)) ?? textOf(message.content);
        if (text) this.push(lines, safeRender(new UserMessageComponent(terminalSafe(text, false)), width, () => this.fallback(text, width)));
        return;
      }
      case "assistant":
        this.renderAssistant(message, width, options, lines, renderedTools, false);
        return;
      case "toolResult":
        if (typeof message.toolCallId === "string") {
          this.renderTool(message.toolCallId, message.toolName ?? "tool", undefined, message, undefined, message.isError, width, options, lines, false);
        }
        return;
      case "bashExecution":
        this.renderBash(message, width, options, lines);
        return;
      case "custom":
        this.renderCustom(message, width, options, lines);
        return;
      case "compactionSummary":
        this.renderSummary(message, width, options, lines, CompactionSummaryMessageComponent);
        return;
      case "branchSummary":
        this.renderSummary(message, width, options, lines, BranchSummaryMessageComponent);
        return;
      default:
        return;
    }
  }

  private renderAssistant(message: Extract<NativeAgentMessage, { role: "assistant" }>, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], renderedTools: Set<string>, transient: boolean): void {
    const key = `${message.timestamp}:${options.target.id}:${options.hideThinking === true}`;
    let component = this.assistantComponents.get(key);
    if (!component) {
      component = new AssistantMessageComponent(message, options.hideThinking ?? false);
      this.assistantComponents.set(key, component);
    } else {
      component.updateContent(message, { transient });
    }
    this.push(lines, safeRender(component, width, () => this.fallback(textOf(message.content), width)));
    for (const block of message.content) {
      if (block.type !== "toolCall" || renderedTools.has(block.id)) continue;
      renderedTools.add(block.id);
      this.renderTool(block.id, block.name, block.arguments, undefined, undefined, message.stopReason === "error", width, options, lines, transient);
    }
  }

  private renderTool(id: string, name: string, args: unknown, result: unknown, partial: unknown, isError: boolean | undefined, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], transient: boolean): void {
    let component = this.toolComponents.get(`${options.target.id}:${id}`);
    if (!component) {
      const tool = this.rendererOptions.getToolDefinition?.(name);
      // ToolDefinition and AgentTool are the same registration shape (OMP casts
      // between them internally); the native component consumes AgentTool.
      component = new ToolExecutionComponent(name, args, { showImages: options.showImages ?? true }, tool as import("@oh-my-pi/pi-agent-core").AgentTool | undefined, {
        requestRender: () => this.tui.requestRender(),
        requestComponentRender: () => this.tui.requestRender(),
        resetDisplay: () => undefined,
        imageBudget: this.tui.imageBudget,
      }, options.target.cwd ?? process.cwd(), id);
      this.toolComponents.set(`${options.target.id}:${id}`, component);
    }
    component.setExpanded(options.toolsExpanded);
    const normalizeResult = (raw: unknown): { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError?: boolean } => {
      const record = (raw ?? {}) as { content?: unknown; details?: unknown; isError?: boolean };
      return {
        content: Array.isArray(record.content) ? record.content : [],
        ...(record.details !== undefined ? { details: record.details } : {}),
        ...(record.isError !== undefined ? { isError: record.isError } : {}),
      };
    };
    if (args !== undefined) component.updateArgs(args, id);
    if (result !== undefined) component.updateResult(normalizeResult(result), false, id);
    else if (partial !== undefined) component.updateResult(normalizeResult(partial), true, id);
    if (isError) component.seal();
    lines.push(...safeRender(component, width, () => this.fallback(name, width)));
  }

  private renderBash(message: BashExecutionAgentMessage, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[]): void {
    const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
    component.appendOutput(terminalSafe(message.output ?? "", false));
    component.setComplete(message.exitCode, message.cancelled, { output: message.output ?? "" });
    component.setExpanded(options.toolsExpanded);
    this.push(lines, safeRender(component, width, () => this.fallback(message.command, width)));
  }

  private renderCustom(message: CustomAgentMessage, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[]): void {
    const text = textOf(message.content);
    if (!message.display || !text) return;
    this.push(lines, safeRender(new UserMessageComponent(terminalSafe(text, false), true), width, () => this.fallback(text, width)));
  }

  private renderSummary<M extends CompactionSummaryAgentMessage | BranchSummaryAgentMessage>(message: M, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], ComponentClass: new (message: M) => Component): void {
    const component = new ComponentClass(message);
    if ("setExpanded" in component && typeof component.setExpanded === "function") component.setExpanded(options.toolsExpanded);
    this.push(lines, safeRender(component, width, () => this.fallback(message.summary, width)));
  }

  private push(lines: string[], block: string[]): void {
    // Native transcript components stack directly (each carries its own
    // internal top/bottom padding); extra separators break exact parity.
    lines.push(...block);
  }

  private fallback(text: string, width: number): string[] {
    return terminalSafe(text, false).split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)).map((item) => this.theme.fg("text", item)));
  }
}
