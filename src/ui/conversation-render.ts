import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  type ExtensionTheme,
  type MessageRenderer,
  type Theme,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { type HostSurface, wrap } from "./rows.js";
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
  private noticed = false;
  private readonly tui: HostSurface;
  private readonly theme: Theme;
  private readonly rendererOptions: FabricConversationTranscriptRendererOptions;

  constructor(
    tui: HostSurface,
    theme: Theme,
    rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.rendererOptions = rendererOptions;
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    if (this.disposed || width <= 0) return [];
    const lines: string[] = [];
    if (!this.noticed) {
      this.noticed = true;
      lines.push(this.theme.fg("dim", "Transcript rows — host message cards were removed in OMP 19.2."));
    }
    if (transcript.messages.length === 0 && !transcript.streaming.partialAssistant && transcript.streaming.tools.length === 0) {
      lines.push(this.theme.fg("dim", "No retained transcript yet; new agent activity will appear here."));
      return lines;
    }
    if (transcript.hasMore) lines.push(this.theme.fg("dim", "↑ older activity available"));
    const renderedTools = new Set<string>();
    for (const message of transcript.messages) this.renderMessage(message, width, options, lines, renderedTools);
    if (transcript.streaming.partialAssistant) {
      this.renderAssistant(transcript.streaming.partialAssistant, width, options, lines, renderedTools);
    }
    for (const tool of transcript.streaming.tools) {
      if (renderedTools.has(tool.toolCallId)) continue;
      renderedTools.add(tool.toolCallId);
      this.renderTool(tool.toolCallId, tool.toolName, tool.args, tool.result, tool.partial, tool.isError, width, options, lines);
    }
    if (transcript.hasNewer) lines.push(this.theme.fg("dim", "↓ newer activity available"));
    return lines;
  }

  private renderMessage(message: NativeAgentMessage, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], renderedTools: Set<string>): void {
    switch (message.role) {
      case "user": {
        const text = unwrapActorEnvelopeText(textOf(message.content)) ?? textOf(message.content);
        if (text) this.push(lines, this.fallback(text, width));
        return;
      }
      case "assistant":
        this.renderAssistant(message, width, options, lines, renderedTools);
        return;
      case "toolResult":
        if (typeof message.toolCallId === "string") {
          this.renderTool(message.toolCallId, message.toolName ?? "tool", undefined, message, undefined, message.isError, width, options, lines);
        }
        return;
      case "bashExecution":
        this.push(lines, this.fallback(message.command, width));
        if (message.output) this.push(lines, this.fallback(message.output, width));
        return;
      case "custom":
        this.renderCustom(message, width, lines);
        return;
      case "compactionSummary":
      case "branchSummary":
        this.push(lines, this.fallback(message.summary, width));
        return;
      default:
        return;
    }
  }

  private renderAssistant(message: Extract<NativeAgentMessage, { role: "assistant" }>, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[], renderedTools: Set<string>): void {
    const hideThinking = options.hideThinking === true;
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (!hideThinking && block.thinking) this.push(lines, this.fallback(block.thinking, width));
        continue;
      }
      if (block.type === "text" && block.text) this.push(lines, this.fallback(block.text, width));
      if (block.type !== "toolCall" || renderedTools.has(block.id)) continue;
      renderedTools.add(block.id);
      this.renderTool(block.id, block.name, block.arguments, undefined, undefined, message.stopReason === "error", width, options, lines);
    }
  }

  private renderTool(id: string, name: string, args: unknown, result: unknown, partial: unknown, isError: boolean | undefined, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[]): void {
    const tool = this.rendererOptions.getToolDefinition?.(name);
    const expanded = options.toolsExpanded;
    if (args !== undefined && tool?.renderCall) {
      const view = tool.renderCall(args, { expanded, isPartial: false }, extensionTheme(this.theme));
      const rows = paintRows(view, width);
      if (rows) lines.push(...rows);
    }
    const raw = result !== undefined ? result : partial;
    if (raw !== undefined && tool?.renderResult) {
      const view = tool.renderResult(normalizeToolResult(raw), { expanded, isPartial: result === undefined }, extensionTheme(this.theme), args);
      const rows = paintRows(view, width);
      if (rows) lines.push(...rows);
    } else if (!tool?.renderCall) {
      lines.push(...this.fallback(name, width));
    }
    if (isError) lines.push(this.theme.fg("error", "failed"));
  }

  private renderCustom(message: CustomAgentMessage, width: number, lines: string[]): void {
    const text = textOf(message.content);
    if (!message.display || !text) return;
    this.push(lines, this.fallback(text, width));
  }

  private push(lines: string[], block: string[]): void {
    lines.push(...block);
  }

  private fallback(text: string, width: number): string[] {
    return terminalSafe(text, false).split("\n").flatMap((line) => wrap(line, Math.max(1, width)).map((item) => this.theme.fg("text", item)));
  }
}

function normalizeToolResult(raw: unknown): AgentToolResult {
  const content: AgentToolResult["content"] = [];
  if (raw && typeof raw === "object" && "content" in raw && Array.isArray(raw.content)) {
    for (const part of raw.content) {
      if (!part || typeof part !== "object" || !("type" in part)) continue;
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
  }
  const details = raw && typeof raw === "object" && "details" in raw ? raw.details : undefined;
  const isError = raw && typeof raw === "object" && "isError" in raw && typeof raw.isError === "boolean" ? raw.isError : undefined;
  return {
    content,
    ...(details !== undefined ? { details } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
}

function extensionTheme(theme: Theme): ExtensionTheme {
  const attribute = (name: string, fallback: string, value: string): string => {
    if (name in theme) {
      const fn = Reflect.get(theme, name);
      if (typeof fn === "function") return String(fn.call(theme, value));
    }
    return typeof theme.style === "function" ? theme.style(fallback, value) : value;
  };
  return {
    ...theme,
    bold: (value) => attribute("bold", "strong", value),
    italic: (value) => attribute("italic", "em", value),
    underline: (value) => attribute("underline", "underline", value),
    strikethrough: (value) => attribute("strikethrough", "strike", value),
    inverse: (value) => attribute("inverse", "inverse", value),
  };
}

function paintRows(view: unknown, width: number): string[] | undefined {
  if (!view || typeof view !== "object" || !("render" in view) || typeof view.render !== "function") return undefined;
  const rows = view.render(width);
  return Array.isArray(rows) ? rows.map((row) => String(row)) : undefined;
}
