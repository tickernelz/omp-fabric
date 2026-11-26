import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
  type ExtensionTheme,
  type MessageRenderer,
  type Theme,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { type HostSurface, truncate, visibleWidth, wrap } from "./rows.js";
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

/** One tool call's views, kept across frames so streaming reuses them like the native cards did. */
interface CachedToolView {
  readonly name: string;
  readonly definition: FabricToolDefinitionLike;
  call?: { readonly args: unknown; readonly expanded: boolean; readonly view: unknown };
  result?: { readonly raw: unknown; readonly expanded: boolean; readonly isPartial: boolean; readonly view: unknown };
}

const TOOL_VIEW_CACHE_LIMIT = 256;
const CARD_PADDING_X = 1;
const GENERIC_TOOL_PREVIEW_LINES = 5;
const PRIMARY_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "code"] as const;

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
  private readonly toolViews = new Map<string, CachedToolView>();
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
    if (!this.disposed) this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.toolViews.clear();
    this.tui.requestRender();
    this.disposed = true;
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    if (this.disposed || width <= 0) return [];
    const lines: string[] = [];
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
      if (block.type === "text" && block.text) this.push(lines, this.markdown(block.text, width));
      if (block.type !== "toolCall" || renderedTools.has(block.id)) continue;
      renderedTools.add(block.id);
      this.renderTool(block.id, block.name, block.arguments, undefined, undefined, message.stopReason === "error", width, options, lines);
    }
  }

  private renderTool(id: string, name: string, args: unknown, result: unknown, partial: unknown, isError: boolean | undefined, width: number, options: FabricConversationTranscriptRenderOptions, lines: string[]): void {
    const cached = this.toolView(`${options.target.id}\u0000${id}`, name);
    const tool = cached.definition;
    const expanded = options.toolsExpanded;
    const theme = extensionTheme(this.theme);
    const card: string[] = [];
    if (args !== undefined && tool?.renderCall) {
      if (!cached.call || cached.call.args !== args || cached.call.expanded !== expanded) {
        cached.call = { args, expanded, view: tool.renderCall(args, { expanded, isPartial: false }, theme) };
      }
      const rows = paintRows(cached.call.view, width - CARD_PADDING_X * 2);
      if (rows) card.push(...rows);
    }
    const raw = result !== undefined ? result : partial;
    if (raw !== undefined && tool?.renderResult) {
      const isPartial = result === undefined;
      if (!cached.result || cached.result.raw !== raw || cached.result.expanded !== expanded || cached.result.isPartial !== isPartial) {
        cached.result = { raw, expanded, isPartial, view: tool.renderResult(normalizeToolResult(raw), { expanded, isPartial }, theme, args) };
      }
      const rows = paintRows(cached.result.view, width - CARD_PADDING_X * 2);
      if (rows) card.push(...rows);
    } else if (!tool?.renderCall) {
      card.push(...this.genericTool(name, args, raw, expanded, width - CARD_PADDING_X * 2));
    }
    if (isError) card.push(this.theme.fg("error", "failed"));
    // OMP 19.2 only tints its own transcript cards, so this view paints the card a "default" shell expects.
    const selfShell = tool !== undefined && "renderShell" in tool && tool.renderShell === "self";
    const tint = isError ? "toolErrorBg" : result === undefined ? "toolPendingBg" : "toolSuccessBg";
    lines.push(...(selfShell ? card : this.paintCard(card, width, tint)));
  }

  private renderCustom(message: CustomAgentMessage, width: number, lines: string[]): void {
    const text = textOf(message.content);
    if (!message.display || !text) return;
    this.push(lines, this.fallback(text, width));
  }

  /** Card rows padded to the full width on a tool background, which survives inner background resets. */
  private paintCard(rows: readonly string[], width: number, tint: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string[] {
    const [open = "", close = ""] = this.theme.bg(tint, "\u0000").split("\u0000");
    if (!open) return [...rows];
    const inner = Math.max(0, width - CARD_PADDING_X * 2);
    const pad = " ".repeat(CARD_PADDING_X);
    return rows.map((row) => {
      const clipped = truncate(row, inner, "");
      const body = (clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))))
        .replaceAll("\x1b[49m", `\x1b[49m${open}`)
        .replaceAll("\x1b[0m", `\x1b[0m${open}`);
      return `${open}${pad}${body}${pad}${close}`;
    });
  }

  /** The cached views of one call; the definition is looked up once per target and call. */
  private toolView(key: string, name: string): CachedToolView {
    let cached = this.toolViews.get(key);
    if (cached && cached.name === name) {
      this.toolViews.delete(key);
    } else {
      cached = { name, definition: this.rendererOptions.getToolDefinition?.(name) };
    }
    this.toolViews.set(key, cached);
    while (this.toolViews.size > TOOL_VIEW_CACHE_LIMIT) {
      const oldest = this.toolViews.keys().next().value;
      if (oldest === undefined) break;
      this.toolViews.delete(oldest);
    }
    return cached;
  }

  /** A tool without fabric renderers: its name, main argument, and output (a few rows unless expanded). */
  private genericTool(name: string, args: unknown, raw: unknown, expanded: boolean, width: number): string[] {
    const summary = toolArgSummary(args);
    const title = this.theme.fg("accent", terminalSafe(name))
      + (summary ? ` ${this.theme.fg("muted", terminalSafe(summary))}` : "");
    const lines = wrap(title, Math.max(1, width));
    const output = normalizeToolResult(raw).content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .replace(/\n+$/, "");
    if (!output) return lines;
    const outputLines = terminalSafe(output, false).split("\n");
    const shown = expanded ? outputLines : outputLines.slice(0, GENERIC_TOOL_PREVIEW_LINES);
    for (const line of shown) {
      lines.push(...wrap(line, Math.max(1, width)).map((row) => this.theme.fg("toolOutput", row)));
    }
    const hidden = outputLines.length - shown.length;
    if (hidden > 0) lines.push(this.theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`));
    return lines;
  }

  /** Assistant prose as OMP draws it (Markdown, highlighted fences); plain rows when the theme cannot. */
  private markdown(text: string, width: number): string[] {
    try {
      return renderMarkdown(terminalSafe(text, false), Math.max(1, width), { theme: this.theme });
    } catch {
      return this.fallback(text, width);
    }
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
  const helpers = new Map<PropertyKey, (value: string) => string>([
    ["bold", (value) => attribute("bold", "strong", value)],
    ["italic", (value) => attribute("italic", "em", value)],
    ["underline", (value) => attribute("underline", "underline", value)],
    ["strikethrough", (value) => attribute("strikethrough", "strike", value)],
    ["inverse", (value) => attribute("inverse", "inverse", value)],
  ]);
  // A Proxy keeps a theme class's prototype methods (fg, bg, style); an object spread drops them.
  return new Proxy(theme, {
    get(target, prop) {
      const helper = helpers.get(prop);
      if (helper) return helper;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (target, prop) => helpers.has(prop) || Reflect.has(target, prop),
  }) as ExtensionTheme;
}

function toolArgSummary(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const values = new Map(Object.entries(args));
  const first = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const [line = ""] = value.trim().split("\n");
    return value.trim().includes("\n") ? `${line} …` : line;
  };
  for (const key of PRIMARY_ARG_KEYS) {
    const summary = first(values.get(key));
    if (summary) return summary;
  }
  for (const value of values.values()) {
    const summary = first(value);
    if (summary) return summary;
  }
  return undefined;
}

function paintRows(view: unknown, width: number): string[] | undefined {
  if (!view || typeof view !== "object" || !("render" in view) || typeof view.render !== "function") return undefined;
  const rows = view.render(width);
  return Array.isArray(rows) ? rows.map((row) => truncate(String(row), Math.max(0, width), "")) : undefined;
}
