// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { ExtensionTheme, ToolDefinition, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { TextBlock } from "./tui/rows.js";
import { asRows, isRows, type Rows } from "./tui/view.js";
import { continueArcGroup } from "./arc-group.js";

type ToolCallBackgroundMode = "on" | "border" | "off";
type AnyTool = ToolDefinition;

export type FabricToolShellDecorator = <TTool extends AnyTool>(
  tool: TTool,
  options?: {
    mode?: ToolCallBackgroundMode;
    preserveSelfShell?: boolean;
    toolCallTiming?: boolean;
  },
) => TTool;

export type PreviewRenderContext = {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Rows | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

type TimingState = Record<string, unknown> & {
  codePreviewTimingStartedAt?: number;
  codePreviewTimingEndedAt?: number;
  codePreviewTimingInterval?: ReturnType<typeof setInterval>;
  codePreviewTimingOnlyRenderToken?: number;
  codePreviewTimingCallComponent?: Rows;
  codePreviewTimingResultComponent?: Rows;
};

type BorderState = TimingState & {
  codePreviewBorderCallComponent?: Rows;
  codePreviewBorderResultComponent?: Rows;
  codePreviewBorderShell?: BorderedToolCall;
  codePreviewBorderTheme?: Theme;
  codePreviewBorderLastCallExecutionStarted?: boolean;
  codePreviewBorderLastCallPartial?: boolean;
};

const timingState = (context: { state?: unknown } | undefined): TimingState | undefined =>
  context?.state as TimingState | undefined;

const isTimingOnlyRender = (state: TimingState | undefined): boolean =>
  state?.codePreviewTimingOnlyRenderToken !== undefined;

const unwrapTimingComponent = (component: Rows | undefined): Rows | undefined =>
  component instanceof TimingPreservedComponent ? component.component : component;

const clearTimingInterval = (state: TimingState): void => {
  if (!state.codePreviewTimingInterval) return;
  clearInterval(state.codePreviewTimingInterval);
  delete state.codePreviewTimingInterval;
  delete state.codePreviewTimingOnlyRenderToken;
};

const ensureTimingInterval = (state: TimingState, invalidate: () => void): void => {
  state.codePreviewTimingInterval ??= setInterval(() => {
    const token = (state.codePreviewTimingOnlyRenderToken ?? 0) + 1;
    state.codePreviewTimingOnlyRenderToken = token;
    try {
      invalidate();
    } finally {
      queueMicrotask(() => {
        if (state.codePreviewTimingOnlyRenderToken === token) {
          delete state.codePreviewTimingOnlyRenderToken;
        }
      });
    }
  }, 100);
};

const formatDuration = (milliseconds: number): string => {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
};

const updateTiming = (
  context: PreviewRenderContext,
  enabled: boolean,
  options: { animate?: boolean; formatLabel?: boolean } = {},
): string | undefined => {
  const state = timingState(context);
  if (!state) return undefined;
  if (!enabled) {
    clearTimingInterval(state);
    return undefined;
  }
  if (
    context.executionStarted &&
    state.codePreviewTimingStartedAt === undefined &&
    context.isPartial !== false
  ) {
    state.codePreviewTimingStartedAt = Date.now();
    delete state.codePreviewTimingEndedAt;
  }
  const startedAt = state.codePreviewTimingStartedAt;
  if (startedAt === undefined) return undefined;
  if (context.isPartial && options.animate !== false) {
    ensureTimingInterval(state, context.invalidate);
  } else if (!context.isPartial) {
    state.codePreviewTimingEndedAt ??= Date.now();
    clearTimingInterval(state);
  }
  if (options.formatLabel === false) return undefined;
  const running = context.isPartial;
  const endedAt = running ? Date.now() : (state.codePreviewTimingEndedAt ?? Date.now());
  return `${running ? "Elapsed" : "Took"} ${formatDuration(endedAt - startedAt)}`;
};

class TimingPreservedComponent implements Rows {
  constructor(readonly component: Rows, private readonly state: TimingState) {}
  render(width: number): readonly string[] {
    return this.component.render(width);
  }
  invalidate(): void {
    if (!isTimingOnlyRender(this.state)) this.component.invalidate?.();
  }
}

class TimingFooter implements Rows {
  constructor(
    private readonly component: Rows,
    private readonly footer: string,
    private readonly state: TimingState,
  ) {}
  render(width: number): readonly string[] {
    return [
      ...continueArcGroup([...this.component.render(width)]),
      truncate(this.footer, width, ""),
    ];
  }
  invalidate(): void {
    if (!isTimingOnlyRender(this.state)) this.component.invalidate?.();
  }
}

const renderTimedResult = (
  context: PreviewRenderContext,
  theme: Theme,
  render: (context: PreviewRenderContext) => Rows,
  label: string | undefined,
): Rows => {
  const state = timingState(context);
  if (!state) return render(context);
  const reused = isTimingOnlyRender(state) ? state.codePreviewTimingResultComponent : undefined;
  const component = reused ?? render({
    ...context,
    lastComponent: unwrapTimingComponent(
      state.codePreviewTimingResultComponent ?? context.lastComponent,
    ),
  });
  state.codePreviewTimingResultComponent = component;
  return label
    ? new TimingFooter(component, theme.fg("muted", `╰─ ${label}`), state)
    : component;
};

const borderState = (context: PreviewRenderContext): BorderState =>
  context.state as BorderState;

const shellStates = new WeakMap<object, BorderState>();

const shellStateFor = (key: unknown): BorderState => {
  const object = typeof key === "object" && key !== null ? key : shellStates;
  const existing = shellStates.get(object);
  if (existing) return existing;
  const created: BorderState = {};
  shellStates.set(object, created);
  return created;
};

const buildRenderContext = (
  args: unknown,
  options: ToolRenderResultOptions & { renderContext?: unknown },
  supplied: Record<string, unknown>,
  fallbackState: BorderState,
): PreviewRenderContext => {
  const executionStarted = typeof supplied.executionStarted === "boolean"
    ? supplied.executionStarted
    : !options.isPartial;
  const argsComplete = typeof supplied.argsComplete === "boolean"
    ? supplied.argsComplete
    : !options.isPartial;
  const state = typeof supplied.state === "object" && supplied.state !== null
    ? supplied.state as BorderState
    : fallbackState;
  return {
    args,
    toolCallId: typeof supplied.toolCallId === "string" ? supplied.toolCallId : "fabric_exec",
    invalidate: typeof supplied.invalidate === "function"
      ? supplied.invalidate as () => void
      : () => undefined,
    lastComponent: isRows(supplied.lastComponent) ? supplied.lastComponent : undefined,
    state,
    cwd: typeof supplied.cwd === "string" ? supplied.cwd : process.cwd(),
    executionStarted,
    argsComplete,
    isPartial: options.isPartial,
    expanded: options.expanded,
    showImages: typeof supplied.showImages === "boolean" ? supplied.showImages : true,
    isError: supplied.isError === true,
  };
};

const borderColor = (context: PreviewRenderContext): "warning" | "success" | "error" => {
  if (context.isError) return "error";
  return context.isPartial ? "warning" : "success";
};

class BorderedToolCall implements Rows {
  private callComponent: Rows | undefined;
  private resultComponent: Rows | undefined;
  private color: "borderMuted" | "warning" | "success" | "error" = "borderMuted";
  private timingLabel: string | undefined;
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;

  constructor(private readonly theme: Theme, private readonly state: TimingState) {}

  setCall(component: Rows | undefined): void {
    this.callComponent = component;
    this.invalidateCache();
  }
  setResult(component: Rows | undefined): void {
    this.resultComponent = component;
    this.invalidateCache();
  }
  setColor(color: typeof this.color): void {
    if (color === this.color) return;
    this.color = color;
    this.invalidateCache();
  }
  setTimingLabel(label: string | undefined): void {
    if (label === this.timingLabel) return;
    this.timingLabel = label;
    this.invalidateCache();
  }
  render(width: number): readonly string[] {
    if (width === this.cachedWidth && this.cachedRows) return this.cachedRows;
    const rows = this.renderUncached(width);
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
  }
  invalidate(): void {
    this.invalidateCache();
    if (isTimingOnlyRender(this.state)) return;
    this.callComponent?.invalidate?.();
    this.resultComponent?.invalidate?.();
  }
  private invalidateCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }
  private renderUncached(width: number): string[] {
    const body = [
      ...(this.callComponent?.render(Math.max(1, width - 4)) ?? []),
      ...(this.resultComponent?.render(Math.max(1, width - 4)) ?? []),
    ];
    if (width < 4) return body;
    const innerWidth = width - 4;
    const border = (value: string) => this.theme.fg(this.color, value);
    const label = this.timingLabel ? ` ${this.theme.fg("muted", this.timingLabel)} ` : "";
    const labelWidth = visibleWidth(label);
    const top = labelWidth > 0 && labelWidth <= width - 2
      ? `${border("╭")}${border("─".repeat(width - 2 - labelWidth))}${label}${border("╮")}`
      : border(`╭${"─".repeat(width - 2)}╮`);
    return [
      top,
      ...body.map((line) => this.frameLine(line, innerWidth, border)),
      border(`╰${"─".repeat(width - 2)}╯`),
    ];
  }
  private frameLine(
    line: string,
    innerWidth: number,
    border: (value: string) => string,
  ): string {
    const text = truncate(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const hasDiffBackground = /^\x1b\[48;2;\d+;\d+;\d+m/.test(text);
    return hasDiffBackground
      ? `${border("│")} ${text}${padding} \x1b[49m${border("│")}\x1b[0m`
      : `${border("│")} ${text}\x1b[0m${padding} ${border("│")}`;
  }
}

const shouldRenderResultSeparately = (state: BorderState, isPartial: boolean): boolean =>
  state.codePreviewBorderLastCallPartial === undefined ||
  (state.codePreviewBorderLastCallPartial !== isPartial &&
    state.codePreviewBorderLastCallExecutionStarted === true);

export const withCodePreviewShell: FabricToolShellDecorator = <TTool extends AnyTool>(
  tool: TTool,
  options: {
    mode?: ToolCallBackgroundMode;
    preserveSelfShell?: boolean;
    toolCallTiming?: boolean;
  } = {},
): TTool => {
  const mode = options.mode ?? "on";
  const timingEnabled = options.toolCallTiming ?? true;
  if ((options.preserveSelfShell ?? true) && (tool as AnyTool & { renderShell?: string }).renderShell === "self") return tool;
  const originalRenderCall = tool.renderCall;
  const originalRenderResult = tool.renderResult;
  const renderCall = (args: unknown, options: ToolRenderResultOptions, theme: ExtensionTheme, context: PreviewRenderContext): Rows => {
    const renderOptions = { ...options, renderContext: context };
    return originalRenderCall
      ? asRows(originalRenderCall.call(tool, args as never, renderOptions, theme), theme)
      : new TextBlock(theme.fg("toolTitle", theme.style("strong", tool.label || tool.name)));
  };
  const renderResult = (
    result: unknown,
    resultOptions: unknown,
    theme: ExtensionTheme,
    context: PreviewRenderContext,
    args?: unknown,
  ): Rows => {
    const renderOptions = { ...(resultOptions as ToolRenderResultOptions), renderContext: context };
    return asRows(
      originalRenderResult?.call(tool, result as never, renderOptions, theme, args),
      theme,
    );
  };

  return {
    ...tool,
    renderShell: mode === "on" ? "default" : "self",
    renderCall(args, options, theme) {
      const renderOptions = options as ToolRenderResultOptions & { renderContext?: Record<string, unknown> };
      if (!renderOptions) {
        return originalRenderCall
          ? originalRenderCall.call(tool, args, { expanded: false, isPartial: false }, theme)
          : new TextBlock(theme.fg("toolTitle", theme.style("strong", tool.label || tool.name)));
      }
      const supplied = renderOptions.renderContext && typeof renderOptions.renderContext === "object"
        ? renderOptions.renderContext
        : (renderOptions as unknown as Record<string, unknown>);
      const context = buildRenderContext(
        args,
        renderOptions,
        supplied,
        shellStateFor(renderOptions),
      );
      if (mode !== "border") {
        const state = timingState(context);
        if (
          context.isPartial &&
          isTimingOnlyRender(state) &&
          state?.codePreviewTimingCallComponent
        ) {
          updateTiming(context, timingEnabled, { animate: false, formatLabel: false });
          return state.codePreviewTimingCallComponent;
        }
        const component = renderCall(args, { expanded: context.expanded, isPartial: context.isPartial }, theme, {
          ...context,
          lastComponent: unwrapTimingComponent(context.lastComponent),
        });
        const wrapped = state
          ? new TimingPreservedComponent(component, state)
          : component;
        if (state) state.codePreviewTimingCallComponent = wrapped;
        updateTiming(context, timingEnabled, { animate: false, formatLabel: false });
        return wrapped;
      }

      const state = borderState(context);
      const timingOnly = context.isPartial && isTimingOnlyRender(state);
      const component = timingOnly && state.codePreviewBorderCallComponent
        ? state.codePreviewBorderCallComponent
        : renderCall(args, { expanded: context.expanded, isPartial: context.isPartial }, theme, {
            ...context,
            lastComponent: state.codePreviewBorderCallComponent,
          });
      const label = updateTiming(context, timingEnabled);
      state.codePreviewBorderCallComponent = component;
      state.codePreviewBorderLastCallExecutionStarted = context.executionStarted;
      state.codePreviewBorderLastCallPartial = context.isPartial;
      const shell = state.codePreviewBorderShell instanceof BorderedToolCall &&
          state.codePreviewBorderTheme === theme
        ? state.codePreviewBorderShell
        : new BorderedToolCall(theme, state);
      shell.setCall(component);
      shell.setResult(state.codePreviewBorderResultComponent);
      shell.setColor(borderColor(context));
      shell.setTimingLabel(label);
      state.codePreviewBorderShell = shell;
      state.codePreviewBorderTheme = theme;
      return shell;
    },
    renderResult(result, resultOptions, theme, args?: unknown) {
      const renderOptions = (resultOptions ?? {}) as ToolRenderResultOptions & { renderContext?: Record<string, unknown> };
      const supplied = renderOptions.renderContext && typeof renderOptions.renderContext === "object"
        ? renderOptions.renderContext
        : (renderOptions as unknown as Record<string, unknown>);
      const context = buildRenderContext(
        result,
        renderOptions,
        supplied,
        shellStateFor(renderOptions),
      );
      const optionsRecord = resultOptions as { isPartial: boolean };
      const label = updateTiming(context, timingEnabled);
      if (mode !== "border") {
        return renderTimedResult(
          context,
          theme,
          (next) => renderResult(result, resultOptions, theme, next, args),
          label,
        );
      }

      const state = borderState(context);
      const timingOnly = context.isPartial && isTimingOnlyRender(state);
      const component = timingOnly && state.codePreviewBorderResultComponent
        ? state.codePreviewBorderResultComponent
        : renderResult(result, resultOptions, theme, {
            ...context,
            lastComponent: state.codePreviewBorderResultComponent,
          }, args);
      state.codePreviewBorderResultComponent = component;
      const shell = state.codePreviewBorderShell instanceof BorderedToolCall &&
          state.codePreviewBorderTheme === theme
        ? state.codePreviewBorderShell
        : new BorderedToolCall(theme, state);
      shell.setCall(state.codePreviewBorderCallComponent);
      shell.setResult(component);
      shell.setColor(borderColor(context));
      shell.setTimingLabel(label);
      state.codePreviewBorderShell = shell;
      state.codePreviewBorderTheme = theme;
      return shouldRenderResultSeparately(state, optionsRecord.isPartial)
        ? component
        : state.codePreviewBorderShell ?? component;
    },
  } as TTool;
};
