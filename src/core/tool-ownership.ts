import path from "node:path";
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { readFabricExecutionTraceV1 } from "../audit/index.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "./action-registry.js";
import { OMP_CORE_TOOL_NAME_SET } from "./omp-tools.js";

export interface FabricToolOwnershipHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface FabricTopLevelToolAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface FabricTopLevelToolApprover {
  approve(event: ToolCallEvent, context: ExtensionContext): Promise<void>;
}

const FABRIC_TOOL_NAME = "fabric_exec";
const TOP_LEVEL_SCHEMA_REF_PREFIX = "schema.top_level_tool.";

export const ownsFabricToolSource = (
  tools: Array<{ name: string; sourceInfo: { path: string } }>,
  extensionEntryPath: string,
): boolean => tools.some(
  (tool) =>
    tool.name === FABRIC_TOOL_NAME &&
    path.resolve(tool.sourceInfo.path) === path.resolve(extensionEntryPath),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finalFabricDetailsFailed = (details: unknown): boolean => {
  if (!isRecord(details)) return false;
  if (details.success === false) return true;
  const trace = readFabricExecutionTraceV1(details.trace);
  return trace !== undefined && trace.outcome !== "succeeded";
};

export class FabricToolLifecycle {
  readonly #outerCalls = new Set<string>();

  constructor(
    readonly ownsFabricTool: () => boolean,
    readonly authorizer: () => FabricTopLevelToolAuthorizer | undefined,
    readonly approver: () => FabricTopLevelToolApprover | undefined = () => undefined,
  ) {}

  async toolCall(
    event: ToolCallEvent,
    context?: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)) {
      if (this.#outerCalls.size > 0) return undefined;
      await this.#authorizeTopLevel(event);
      return undefined;
    }
    if (event.toolName === FABRIC_TOOL_NAME && this.ownsFabricTool()) {
      this.#outerCalls.add(event.toolCallId);
      return undefined;
    }
    await this.#authorizeTopLevel(event);
    const approver = this.approver();
    if (approver) {
      if (!context) throw new Error("Fabric direct tool approval needs an extension context");
      await approver.approve(event, context);
    }
    return undefined;
  }

  toolResult(event: ToolResultEvent): { isError: true } | undefined {
    if (
      event.toolName !== FABRIC_TOOL_NAME ||
      event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX) ||
      !this.#outerCalls.delete(event.toolCallId)
    ) {
      return undefined;
    }
    return !event.isError && finalFabricDetailsFailed(event.details)
      ? { isError: true }
      : undefined;
  }

  clear(): void {
    this.#outerCalls.clear();
  }

  async #authorizeTopLevel(event: ToolCallEvent): Promise<void> {
    await this.authorizer()?.authorize(
      `${TOP_LEVEL_SCHEMA_REF_PREFIX}${event.toolName}`,
      event.toolCallId,
    );
  }
}

const sameTools = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index]);

export interface ToolOwnershipReassertion {
  reassert(): void;
  schedule(): void;
}

// Re-asserts active-set ownership after registry refreshes and at turn
// boundaries. Refresh-driven microtasks can run before the host finished
// initializing (registry rebuilds happen before session_start), when neither
// the live config nor the active tool set is safe to touch — `ready` guards
// every entry point, including the deferred microtask.
export const createToolOwnershipReassertion = (options: {
  ready: () => boolean;
  active: () => boolean;
  hiddenNames: () => ReadonlySet<string>;
  apply: (hidden: ReadonlySet<string>) => boolean;
}): ToolOwnershipReassertion => {
  let queued = false;
  const reassert = (): void => {
    queued = false;
    if (!options.ready() || !options.active()) return;
    options.apply(options.hiddenNames());
  };
  return {
    reassert,
    schedule: () => {
      if (queued) return;
      queued = true;
      queueMicrotask(reassert);
    },
  };
};

export class FabricToolOwnership {
  #savedNativeCoreTools: Array<{ name: string; index: number }> | undefined;
  // Captured extension tools stay registered so host extensions (permission
  // systems, auditors) keep them in `omp.getAllTools()`; hiding from the model
  // happens here, in the active set. Removed names are remembered so leaving
  // full code mode (or adding a name to `capture.keepVisible`) re-exposes them.
  #savedHiddenExtensionTools = new Map<string, number>();

  constructor(readonly host: FabricToolOwnershipHost) {}

  apply(
    fullCodeModeOrPolicy: boolean | {
      fullCodeMode: boolean;
      schemaMode?: string;
      includeTools?: ReadonlySet<string>;
      excludeTools?: ReadonlySet<string>;
    },
    hiddenExtensionTools?: ReadonlySet<string>,
  ): boolean {
    const active = this.host.getActiveTools();
    const policy = typeof fullCodeModeOrPolicy === "boolean"
      ? { fullCodeMode: fullCodeModeOrPolicy, includeTools: new Set<string>(), excludeTools: new Set<string>() }
      : fullCodeModeOrPolicy;
    const enforce = policy.schemaMode === "enforce";
    const include = policy.includeTools ?? new Set<string>();
    const exclude = policy.excludeTools ?? new Set<string>();
    const hideCore = policy.fullCodeMode || enforce;
    const hidden = hiddenExtensionTools ?? new Set<string>();
    if (!hideCore && hidden.size === 0 && exclude.size === 0) return this.#restore(active);
    if (hideCore) {
      this.#savedNativeCoreTools ??= active.flatMap((name, index) =>
        OMP_CORE_TOOL_NAME_SET.has(name) ? [{ name, index }] : [],
      );
    }
    const next: string[] = [];
    for (const [index, name] of active.entries()) {
      const coreHidden = hideCore && OMP_CORE_TOOL_NAME_SET.has(name) && (enforce || !include.has(name));
      const extensionHidden = hidden.has(name) && !include.has(name);
      const explicitlyExcluded = exclude.has(name);
      if (coreHidden || extensionHidden || explicitlyExcluded) {
        if ((extensionHidden || explicitlyExcluded) && !this.#savedHiddenExtensionTools.has(name)) {
          this.#savedHiddenExtensionTools.set(name, index);
        }
        continue;
      }
      next.push(name);
    }
    for (const [name, index] of this.#savedHiddenExtensionTools) {
      if (hidden.has(name) || exclude.has(name) || next.includes(name)) continue;
      this.#savedHiddenExtensionTools.delete(name);
      next.splice(Math.min(index, next.length), 0, name);
    }
    return this.#setIfChanged(active, next);
  }

  release(): boolean {
    return this.#restore(this.host.getActiveTools());
  }

  #restore(active: string[]): boolean {
    const saved = this.#savedNativeCoreTools;
    const savedHidden = this.#savedHiddenExtensionTools;
    if (!saved && savedHidden.size === 0) return false;
    this.#savedNativeCoreTools = undefined;
    this.#savedHiddenExtensionTools = new Map();
    const next = [...active];
    for (const { name, index } of saved ?? []) {
      if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
    }
    for (const [name, index] of savedHidden) {
      if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
    }
    return this.#setIfChanged(active, next);
  }

  #setIfChanged(active: string[], next: string[]): boolean {
    if (sameTools(active, next)) return false;
    this.host.setActiveTools(next);
    return true;
  }
}
