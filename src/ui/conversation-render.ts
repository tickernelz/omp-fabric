import type { ExtensionTheme, MessageRenderer, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { padTo, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { compactRedactedValue, redact, terminalSafe } from "./transcript-sanitization.js";
import type { FabricConversationTarget } from "./conversation.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";
import { asRows, type FabricViewHost } from "./tui/view.js";
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
}

export interface FabricConversationTranscriptRenderOptions {
  target: FabricConversationTarget;
  toolsExpanded: boolean;
  hideThinking?: boolean;
}

type AssistantAgentMessage = Extract<NativeAgentMessage, { role: "assistant" }>;
type BashExecutionAgentMessage = Extract<NativeAgentMessage, { role: "bashExecution" }>;
type CustomAgentMessage = Extract<NativeAgentMessage, { role: "custom" }>;

interface ToolRenderInput {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  partial: boolean;
  isError: boolean;
}

const COLLAPSED_RESULT_LINES = 6;
const EXPANDED_RESULT_LINES = 200;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
};

const resultContent = (raw: unknown): unknown =>
  typeof raw === "object" && raw !== null && "content" in raw ? raw.content : undefined;

const resultIsError = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && "isError" in raw && raw.isError === true;

const normalizeResult = (raw: unknown): { content: unknown[]; details?: unknown; isError?: boolean } => {
  const content = resultContent(raw);
  const details = typeof raw === "object" && raw !== null && "details" in raw ? raw.details : undefined;
  return {
    content: Array.isArray(content) ? content : [],
    ...(details !== undefined ? { details } : {}),
    ...(resultIsError(raw) ? { isError: true } : {}),
  };
};

export class FabricConversationTranscriptRenderer {
  private disposed = false;
  private prompts: number[] = [];
  private readonly cache = new Map<string, { signature: string; width: number; rows: string[] }>();

  constructor(
    private readonly host: FabricViewHost,
    private readonly theme: ExtensionTheme,
    private readonly rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {}

  invalidate(): void {
    if (this.disposed) return;
    this.cache.clear();
    this.host.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
  }

  get promptRows(): readonly number[] {
    return this.prompts;
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions): string[] {
    if (this.disposed || width <= 0) return [];
    if (transcript.messages.length === 0 && !transcript.streaming.partialAssistant && transcript.streaming.tools.length === 0) {
      return [this.theme.fg("dim", "No retained transcript yet; new agent activity will appear here.")];
    }
    const lines: string[] = [];
    this.prompts = [];
    if (transcript.hasMore) lines.push(this.theme.fg("dim", "↑ older activity available"));
    const renderedTools = new Set<string>();
    const results = new Map<string, Extract<NativeAgentMessage, { role: "toolResult" }>>();
    for (const message of transcript.messages) {
      if (message.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, message);
    }
    const streamingTools = new Map(transcript.streaming.tools.map((tool) => [tool.toolCallId, tool]));
    const pushTool = (input: ToolRenderInput): void => {
      if (renderedTools.has(input.id)) return;
      renderedTools.add(input.id);
      this.block(lines, `tool:${options.target.id}:${input.id}`, [input, options.toolsExpanded], width, () =>
        this.toolRows(input, width, options.toolsExpanded));
    };
    const pushAssistant = (message: AssistantAgentMessage): void => {
      this.block(lines, `assistant:${options.target.id}:${message.timestamp}`, [message.content, message.stopReason, options.hideThinking === true], width, () =>
        this.assistantRows(message, width, options.hideThinking === true));
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const result = results.get(block.id);
        const live = streamingTools.get(block.id);
        pushTool({
          id: block.id,
          name: block.name,
          args: block.arguments,
          result: result ?? live?.result ?? live?.partial,
          partial: result === undefined && live?.result === undefined,
          isError: result?.isError === true || live?.isError === true || resultIsError(live?.result),
        });
      }
    };
    for (const message of transcript.messages) {
      switch (message.role) {
        case "user": {
          const text = unwrapActorEnvelopeText(textOf(message.content)) ?? textOf(message.content);
          if (text) {
            this.prompts.push(lines.length + 1);
            lines.push(...this.userRows(text, width, false));
          }
          break;
        }
        case "assistant":
          pushAssistant(message);
          break;
        case "toolResult":
          if (typeof message.toolCallId === "string") {
            pushTool({
              id: message.toolCallId,
              name: message.toolName ?? "tool",
              args: undefined,
              result: message,
              partial: false,
              isError: message.isError === true,
            });
          }
          break;
        case "bashExecution":
          lines.push(...this.bashRows(message, width, options.toolsExpanded));
          break;
        case "custom":
          lines.push(...this.customRows(message, width, options.toolsExpanded));
          break;
        case "compactionSummary":
          lines.push(...this.summaryRows("Compaction summary", message.summary, width, options.toolsExpanded));
          break;
        case "branchSummary":
          lines.push(...this.summaryRows("Branch summary", message.summary, width, options.toolsExpanded));
          break;
        default:
          break;
      }
    }
    if (transcript.streaming.partialAssistant) pushAssistant(transcript.streaming.partialAssistant);
    for (const tool of transcript.streaming.tools) {
      pushTool({
        id: tool.toolCallId,
        name: tool.toolName,
        args: tool.args,
        result: tool.result ?? tool.partial,
        partial: tool.result === undefined,
        isError: tool.isError === true || tool.status === "failed",
      });
    }
    if (transcript.hasNewer) lines.push(this.theme.fg("dim", "↓ newer activity available"));
    return lines;
  }

  private block(lines: string[], key: string, inputs: unknown, width: number, build: () => string[]): void {
    let signature: string;
    try {
      signature = JSON.stringify(inputs) ?? "";
    } catch {
      signature = String(Date.now());
    }
    const cached = this.cache.get(key);
    if (cached && cached.signature === signature && cached.width === width) {
      lines.push(...cached.rows);
      return;
    }
    let rows: string[];
    try {
      rows = build();
    } catch (error) {
      rows = [this.theme.fg("error", truncate(`render failed: ${error instanceof Error ? error.message : String(error)}`, width))];
    }
    this.cache.set(key, { signature, width, rows });
    lines.push(...rows);
  }

  private markdown(text: string, width: number, textStyle?: string): string[] {
    const source = terminalSafe(text, false);
    if (source.trim() === "") return [];
    return renderMarkdown(source, width, { theme: this.theme, ...(textStyle ? { textStyle } : {}) });
  }

  private userRows(text: string, width: number, synthetic: boolean): string[] {
    const body = terminalSafe(text, false);
    const rows = body.split("\n").flatMap((line) => (line === "" ? [""] : wrap(line, Math.max(1, width - 2))));
    const style = (row: string): string => {
      const padded = padTo(` ${row}`, width);
      return synthetic ? this.theme.fg("dim", padded) : this.theme.bg("userMessageBg", padded);
    };
    return ["", ...rows.map(style)];
  }

  private assistantRows(message: AssistantAgentMessage, width: number, hideThinking: boolean): string[] {
    const rows: string[] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (hideThinking) continue;
        const thinking = this.markdown(block.thinking, width, "muted em");
        if (thinking.length > 0) rows.push("", ...thinking);
      } else if (block.type === "text") {
        const text = this.markdown(block.text, width);
        if (text.length > 0) rows.push("", ...text);
      }
    }
    if (message.stopReason === "error" && message.errorMessage) {
      rows.push("", ...wrap(this.theme.fg("error", terminalSafe(`Error: ${message.errorMessage}`)), width));
    }
    return rows;
  }

  private toolRows(input: ToolRenderInput, width: number, expanded: boolean): string[] {
    const definition = this.rendererOptions.getToolDefinition?.(input.name);
    const renderOptions = { expanded, isPartial: input.partial };
    const call = definition?.renderCall
      ? asRows(definition.renderCall(input.args ?? {}, renderOptions, this.theme), this.theme).render(width)
      : this.genericCallRows(input, width);
    const result = input.result === undefined
      ? []
      : definition?.renderResult
        ? asRows(definition.renderResult(normalizeResult(input.result) as never, renderOptions, this.theme, input.args), this.theme).render(width)
        : this.genericResultRows(input, width, expanded);
    return ["", ...call, ...result];
  }

  private genericCallRows(input: ToolRenderInput, width: number): string[] {
    const status = input.partial
      ? this.theme.fg("warning", "◆")
      : input.isError
        ? this.theme.fg("error", "✗")
        : this.theme.fg("success", "✓");
    const args = input.args === undefined ? "" : ` ${this.theme.fg("muted", compactRedactedValue(redact(input.args)))}`;
    return [truncate(`${status} ${this.theme.fg("toolTitle", this.theme.style("strong", terminalSafe(input.name)))}${args}`, width)];
  }

  private genericResultRows(input: ToolRenderInput, width: number, expanded: boolean): string[] {
    const text = terminalSafe(textOf(resultContent(input.result)), false).replace(/\n+$/, "");
    if (text === "") return [];
    const lines = text.split("\n");
    const limit = expanded ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES;
    const color = input.isError ? "error" : "toolOutput";
    const rows = lines.slice(0, limit).map((line) => truncate(this.theme.fg(color, `  ${line}`), width));
    if (lines.length > limit) {
      rows.push(this.theme.fg("dim", truncate(`  … ${lines.length - limit} more lines`, width)));
    }
    return rows;
  }

  private bashRows(message: BashExecutionAgentMessage, width: number, expanded: boolean): string[] {
    const header = truncate(`${this.theme.fg("toolTitle", this.theme.style("strong", "$"))} ${terminalSafe(message.command)}`, width);
    const output = terminalSafe(message.output ?? "", false).replace(/\n+$/, "");
    const lines = output === "" ? [] : output.split("\n");
    const limit = expanded ? EXPANDED_RESULT_LINES : COLLAPSED_RESULT_LINES;
    const rows = ["", header, ...lines.slice(0, limit).map((line) => truncate(this.theme.fg("toolOutput", `  ${line}`), width))];
    if (lines.length > limit) rows.push(this.theme.fg("dim", truncate(`  … ${lines.length - limit} more lines`, width)));
    if (message.cancelled) rows.push(this.theme.fg("warning", "  cancelled"));
    else if (message.exitCode !== undefined && message.exitCode !== 0) {
      rows.push(this.theme.fg("error", `  exit ${message.exitCode}`));
    }
    return rows;
  }

  private customRows(message: CustomAgentMessage, width: number, expanded: boolean): string[] {
    if (!message.display) return [];
    const renderer = this.rendererOptions.getMessageRenderer?.(message.customType);
    if (renderer) {
      try {
        const rendered = asRows(renderer(message, { expanded }, this.theme), this.theme).render(width);
        if (rendered.length > 0) return ["", ...rendered];
      } catch {
        return [];
      }
    }
    const text = textOf(message.content);
    return text ? this.userRows(text, width, true) : [];
  }

  private summaryRows(label: string, summary: string, width: number, expanded: boolean): string[] {
    const header = this.theme.fg("dim", truncate(`◇ ${label}`, width));
    if (!expanded) return ["", header];
    return ["", header, ...this.markdown(summary, width, "muted")];
  }
}
