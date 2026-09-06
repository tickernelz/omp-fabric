import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { Settings, type ToolSession } from "@oh-my-pi/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";
import { tryExecuteGitWorktreeAdd } from "../agents/bash-worktree-add.js";
import { runAbortable, throwIfAborted } from "../async-settlement.js";
import { CapturedToolCatalog } from "../capture/catalog.js";
import {
  isOmpShellToolName,
  OMP_CORE_TOOL_NAMES,
  type OmpCoreToolName,
} from "../core/omp-tools.js";
import { classifyOmpBashError, ompBashExitError, ompBashResultError, stripOmpBashTiming } from "../core/omp-bash-error.js";
import { expandSkillDirMarkersForRead } from "../core/skill-dir.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricMediaBlock,
  FabricProvider,
  FabricProviderListRequest,
  FabricRisk,
} from "../protocol.js";
import { countContentLines } from "../ui/preview-lines.js";
import { CapturedToolsProvider } from "./captured-tools-provider.js";
import { BashCwdDefinitions, OMP_BASH_CWD_KEY, resolveShellCwdArgument, withShellCwdSchema } from "./omp-bash-cwd.js";
import { writeContentForPreview } from "./write-diff-limits.js";
import { createPreviewWriteToolDefinition } from "./write-preview.js";

import { readChildToolAllowlist } from "../core/child-tool-allowlist.js";

const MAX_RENDERER_ARGUMENT_CHARS = 200_000;
const GUEST_READ_LINE_LIMIT = 100_000;
const MAX_REPLACE_ALL_FILE_CHARS = 2_000_000;
const createNativeSession = (cwd: string, artifactPaths?: Map<string, string>): ToolSession => {
  const artifactRoot = artifactPaths
    ? mkdtempSync(path.join(os.tmpdir(), "omp-fabric-bash-"))
    : undefined;
  return {
    cwd,
    hasUI: false,
    hasEditTool: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated({
      readLineNumbers: false,
      "read.defaultLimit": GUEST_READ_LINE_LIMIT,
      "tools.outputMaxColumns": 0,
    }),
    ...(artifactRoot && artifactPaths
      ? {
          allocateOutputArtifact: async (toolType: string) => {
            const id = randomUUID();
            const artifactPath = path.join(artifactRoot, `${toolType}-${id}.log`);
            writeFileSync(artifactPath, "", { mode: 0o600 });
            artifactPaths.set(id, artifactPath);
            return { id, path: artifactPath };
          },
        }
      : {}),
  };
};

type NativeTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<AgentToolResult>;
};

const nativeDefinition = (tool: NativeTool): ToolDefinition<any, any> => {
  const execute: ToolDefinition<any, any>["execute"] = (toolCallId, params, signal, onUpdate, context) =>
    tool.execute(toolCallId, params, signal, onUpdate, context);
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as ToolDefinition<any, any>["parameters"],
    execute,
  };
};

const createNativeBashToolDefinition = (cwd: string, artifactPaths: Map<string, string>): ToolDefinition<any, any> =>
  nativeDefinition(new BashTool(createNativeSession(cwd, artifactPaths)) as unknown as NativeTool);

const createNativeReadToolDefinition = (cwd: string): ToolDefinition<any, any> =>
  nativeDefinition(new ReadTool(createNativeSession(cwd)) as unknown as NativeTool);

const createNativeReplaceEditToolDefinition = (cwd: string): ToolDefinition<any, any> =>
  nativeDefinition(new EditTool(createNativeSession(cwd), "replace") as unknown as NativeTool);

const normalizeEditArguments = (
  args: Record<string, unknown>,
  replaceAll: boolean,
  cwd: string,
): Record<string, unknown> => {
  const filePath = args.path;
  if (typeof filePath !== "string") throw new Error("omp.edit requires a path");
  if (typeof args.old_string === "string" && typeof args.new_string === "string") return args;
  const rawEdits = Array.isArray(args.edits)
    ? args.edits
    : [{ oldText: args.oldText, newText: args.newText, all: replaceAll }];
  if (rawEdits.length === 0) throw new Error("omp.edit requires at least one edit");
  const edits = rawEdits.map((edit, index) => {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
      throw new Error(`omp.edit edits[${index}] must be an object`);
    }
    const record = edit as Record<string, unknown>;
    const oldString = record.old_string ?? record.oldText ?? record.old;
    const newString = record.new_string ?? record.newText ?? record.new ?? record.replacement;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      throw new Error(`omp.edit edits[${index}] requires old and new text strings`);
    }
    return {
      old_string: oldString,
      new_string: newString,
      ...(replaceAll || record.all === true || record.replace_all === true ? { replace_all: true } : {}),
    };
  });
  const resolvedPath = path.resolve(cwd, filePath.startsWith("@") ? filePath.slice(1) : filePath);
  const current = readFileSync(resolvedPath, "utf8");
  if (current.length > MAX_REPLACE_ALL_FILE_CHARS) {
    throw new Error(`omp.edit refuses files over ${MAX_REPLACE_ALL_FILE_CHARS} characters`);
  }
  let next = current;
  for (const [index, edit] of edits.entries()) {
    const occurrences = next.split(edit.old_string).length - 1;
    if (occurrences === 0) throw new Error(`omp.edit edits[${index}] oldText was not found`);
    if (!edit.replace_all && occurrences !== 1) {
      throw new Error(`omp.edit edits[${index}] found ${occurrences} occurrences; add all:true or use a unique anchor`);
    }
    next = edit.replace_all ? next.replaceAll(edit.old_string, edit.new_string) : next.replace(edit.old_string, edit.new_string);
  }
  return { path: filePath, edits };
};


const EDIT_COMPATIBILITY_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replacement: { type: "string" },
    old: { type: "string" },
    new: { type: "string" },
    all: { type: "boolean" },
    replace_all: { type: "boolean" },
    edits: { type: "array", items: { type: "object" } },
  },
  required: ["path"],
  anyOf: [
    { required: ["oldText", "newText"] },
    { required: ["old_string", "new_string"] },
    { required: ["edits"] },
  ],
  additionalProperties: false,
};

const readTools = new Set<OmpCoreToolName>(["read", "grep", "find", "ls"]);
const writeTools = new Set<OmpCoreToolName>(["edit", "write"]);

// The content array every OMP core tool returns: text and/or image blocks.
type ToolContent = AgentToolResult<unknown>["content"];

const riskForTool = (name: OmpCoreToolName): FabricRisk => {
  if (readTools.has(name)) return "read";
  if (writeTools.has(name)) return "write";
  return "execute";
};

const textContent = (content: ToolContent): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const imageBlocks = (content: unknown): FabricMediaBlock[] => {
  if (!Array.isArray(content)) return [];
  const blocks: FabricMediaBlock[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "image" &&
      typeof (part as { data?: unknown }).data === "string" &&
      typeof (part as { mimeType?: unknown }).mimeType === "string"
    ) {
      blocks.push({
        type: "image",
        data: (part as { data: string }).data,
        mimeType: (part as { mimeType: string }).mimeType,
      });
    }
  }
  return blocks;
};

const resultHasTruncation = (details: unknown): boolean => {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
  const meta = Reflect.get(details, "meta");
  const candidates = [Reflect.get(details, "truncation"), meta && typeof meta === "object" ? Reflect.get(meta, "truncation") : undefined];
  return candidates.some((truncation) =>
    truncation !== null && typeof truncation === "object" && !Array.isArray(truncation)
      && typeof Reflect.get(truncation, "truncatedBy") === "string",
  );
};

const resultExitCode = (details: unknown): number | undefined => {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const exitCode = Reflect.get(details, "exitCode");
  return Number.isSafeInteger(exitCode) && exitCode > 0 ? exitCode : undefined;
};
const normalizeResult = (
  name: OmpCoreToolName,
  result: { content: ToolContent; details?: unknown; isError?: boolean },
  artifactPaths?: ReadonlyMap<string, string>,
  appendReadNewline = true,
): unknown => {
  const text = isOmpShellToolName(name)
    ? stripOmpBashTiming(textContent(result.content))
    : textContent(result.content);
  if (result.isError && !resultHasTruncation(result.details)) throw new Error(text || `${name} failed`);
  if (name === "read") {
    return appendReadNewline && text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
  }
  if (name === "grep" || name === "find" || name === "ls") return text;
  let details = result.details;
  if (isOmpShellToolName(name) && details && typeof details === "object" && !Array.isArray(details)) {
    const detailRecord = details as Record<string, unknown>;
    const meta = detailRecord.meta;
    const metaRecord = meta && typeof meta === "object" && !Array.isArray(meta)
      ? meta as Record<string, unknown>
      : undefined;
    const truncation = detailRecord.truncation ?? metaRecord?.truncation;
    if (truncation && typeof truncation === "object" && !Array.isArray(truncation)) {
      const truncationRecord = truncation as Record<string, unknown>;
      const artifactId = truncationRecord.artifactId;
      const fullOutputPath = typeof artifactId === "string" ? artifactPaths?.get(artifactId) : undefined;
      details = {
        ...detailRecord,
        truncation: { ...truncationRecord, truncated: true },
        ...(fullOutputPath ? { fullOutputPath } : {}),
      };
    }
  }
  if (name === "write" && details && typeof details === "object" && !Array.isArray(details)) {
    const { codePreviewBeforeWrite: _before, ...publicDetails } = details as Record<string, unknown>;
    details = Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
  }
  return { ok: true, output: text, details: details ?? null };
};

// Shape of an OMP core tool's execute() result. AgentToolResult<unknown> is
// { content, details, terminate? }; OMP core tools throw on error rather than
// returning isError, so isError is tracked separately in #invokeWithEvents.
interface OmpToolResult {
  content: ToolContent;
  details: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export class OmpToolsProvider implements FabricProvider {
  static async create(
    cwd: string,
    catalog?: CapturedToolCatalog,
    capturedTools?: CapturedToolsProvider,
  ): Promise<OmpToolsProvider> {
    return new OmpToolsProvider(cwd, catalog, capturedTools);
  }
  readonly name = "omp";
  readonly description = "OMP's built-in coding tools";
  readonly #allowedTools = readChildToolAllowlist();
  readonly #tools: Partial<Record<OmpCoreToolName, ToolDefinition<any, any>>>;
  readonly #catalog: CapturedToolCatalog | undefined;
  readonly #capturedTools: CapturedToolsProvider | undefined;
  readonly #cwd: string;
  readonly #artifactPaths = new Map<string, string>();
  readonly #bashDefinitions = new BashCwdDefinitions();

  constructor(
    cwd: string,
    catalog?: CapturedToolCatalog,
    capturedTools?: CapturedToolsProvider,
  ) {
    this.#cwd = cwd;
    this.#tools = {
      read: createNativeReadToolDefinition(cwd),
      bash: createNativeBashToolDefinition(cwd, this.#artifactPaths),
      edit: createNativeReplaceEditToolDefinition(cwd),
      write: createPreviewWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
    };
    this.#catalog = catalog;
    this.#capturedTools = capturedTools;
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const descriptors = await Promise.all(
      OMP_CORE_TOOL_NAMES.map((name) => this.describe(name, _context)),
    );
    return descriptors
      .filter((descriptor): descriptor is FabricActionDescriptor => descriptor !== undefined)
      .filter((descriptor) =>
        query ? `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query) : true,
      );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    const name = actionName as OmpCoreToolName;
    if (this.#allowedTools && !this.#allowedTools.has(name)) return undefined;
    const tool = this.#tools[name];
    if (!tool) return undefined;
    const override = await this.#capturedTools?.describe(name, _context);
    if (override) return { ...override, namespace: "extension-override" };
    return this.#descriptor(name, tool);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    this.#assertAllowed(actionName);
    if (this.#catalog?.get(actionName)) {
      return this.#capturedTools!.prepareArguments(actionName, args);
    }
    const tool = this.#tools[actionName as OmpCoreToolName];
    if (!tool) return args;
    const prepared = args;
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
      throw new Error(`OMP tool ${actionName} prepared non-object arguments`);
    }
    const record = prepared as Record<string, unknown>;
    if (isOmpShellToolName(actionName)) {
      const shellArgs = Object.hasOwn(args, OMP_BASH_CWD_KEY)
        ? { ...record, [OMP_BASH_CWD_KEY]: args[OMP_BASH_CWD_KEY] }
        : record;
      return resolveShellCwdArgument(actionName, this.#cwd, shellArgs);
    }
    return actionName === "edit" ? normalizeEditArguments(record, args.all === true, this.#cwd) : record;
  }

  #assertAllowed(name: string): void {
    if (this.#allowedTools && !this.#allowedTools.has(name)) {
      throw new Error(`OMP tool ${name} is not permitted by this child's tool allowlist`);
    }
  }

  // Keep a cwd-bound definition for hosts without argument preparation, while newer hosts receive the
  // same directory through ExtensionContext.cwd. `cwd` also stays in the
  // arguments so lifecycle events, approval, and previews see it.
  #definitionFor(
    name: OmpCoreToolName,
    args: Record<string, unknown>,
  ): ToolDefinition<any, any> {
    const tool = this.#tools[name];
    if (!tool) throw new Error(`Unknown OMP tool: ${name}`);
    if (!isOmpShellToolName(name)) return tool;
    const cwd = args[OMP_BASH_CWD_KEY];
    if (typeof cwd !== "string") return tool;
    return this.#bashDefinitions.get(cwd);
  }

  #executionContextFor(
    name: OmpCoreToolName,
    args: Record<string, unknown>,
    context: ExtensionContext,
  ): ExtensionContext {
    const cwd = args[OMP_BASH_CWD_KEY];
    return isOmpShellToolName(name) && typeof cwd === "string"
      ? { ...context, cwd }
      : context;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const name = actionName as OmpCoreToolName;
    this.#assertAllowed(name);
    if (!this.#tools[name]) throw new Error(`Unknown OMP tool: ${actionName}`);
    if (name === "bash") {
      const intercepted = await tryExecuteGitWorktreeAdd(args, this.#cwd);
      if (intercepted) {
        this.#attachPreview(name, intercepted, args, context);
        return this.#normalizeResult(name, intercepted, args);
      }
    }
    // A captured extension override (e.g. an extension that registered a "read"
    // tool) already replays the full event lifecycle itself via
    // CapturedToolsProvider, so delegate to it unchanged.
    if (this.#catalog?.get(name)) {
      const result = await this.#capturedTools!.invoke(name, args, context);
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      return this.#normalizeResult(name, result, args, false);
    }
    const tool = this.#definitionFor(name, args);
    const runner = this.#catalog?.runner;
    // Without a runner (e.g. before the first tool refresh populated the
    // catalog) fall back to a direct execute — no extension hooks fire, but
    // the call still works. Once tools are refreshed the runner is available.
    if (!runner) {
      const result = await runAbortable(context.signal, () =>
        tool.execute(
          context.nestedToolCallId,
          args,
          context.signal,
          (partialResult) => this.#attachPartialPreview(name, partialResult, args, context),
          this.#executionContextFor(name, args, context.extensionContext),
        ),
      ).catch((error) => {
        throwIfAborted(context.signal);
        throw isOmpShellToolName(name) ? classifyOmpBashError(error) : error;
      });
      if (name === "bash" && result.isError && !resultHasTruncation(result.details)) {
        const exitCode = resultExitCode(result.details);
        if (exitCode !== undefined) throw ompBashExitError(exitCode, textContent(result.content));
      }
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      this.#attachPreview(name, result, args, context);
      return this.#normalizeResult(name, result, args);
    }
    return this.#invokeWithEvents(name, tool, args, context, runner);
  }

  // Replay the agent-core tool-execution lifecycle for a nested omp.* call, so
  // extensions that hook tool_call / tool_result / tool_execution_* see OMP
  // core tools invoked through fabric_exec in full-code mode — exactly as
  // they would for a top-level call in the normal (non-codemode) flow, and
  // exactly as CapturedToolsProvider already does for captured extension
  // tools. tool_result patches (content/details/isError) are applied, so
  // extensions like pi-vision-handoff can replace image blocks with text
  // descriptions before the result returns to the sandbox.
  async #invokeWithEvents(
    name: OmpCoreToolName,
    tool: ToolDefinition<any, any>,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    runner: ExtensionRunner,
  ): Promise<unknown> {
    const toolCallId = context.nestedToolCallId;
    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: name,
      args,
    }));
    let result: OmpToolResult;
    let isError = false;
    let thrown: unknown;
    let executionStarted = false;
    let updateTail: Promise<void> = Promise.resolve();
    try {
      const preflight = await runAbortable(context.signal, () => runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId,
        input: args,
      }));
      context.updateArguments?.(args);
      if (preflight?.block) {
        throw new Error(preflight.reason || `OMP tool ${name} was blocked`);
      }
      executionStarted = true;
      result = (await runAbortable(context.signal, () => tool.execute(
        toolCallId,
        args,
        context.signal,
        (partialResult) => {
          this.#attachPartialPreview(name, partialResult, args, context);
          updateTail = updateTail
            .then(() =>
              runAbortable(context.signal, () => runner.emit({
                type: "tool_execution_update",
                toolCallId,
                toolName: name,
                args,
                partialResult,
              })),
            )
            .catch(() => undefined);
        },
        this.#executionContextFor(name, args, context.extensionContext),
      ))) as OmpToolResult;
      isError = result.isError === true;
    } catch (error) {
      thrown = isOmpShellToolName(name) && executionStarted ? classifyOmpBashError(error) : error;
      isError = true;
      result = {
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
        details: undefined,
      };
    }

    await updateTail;
    throwIfAborted(context.signal);

    // Capture the read's image blocks BEFORE any tool_result patch —
    // pi-vision-handoff swaps image→description here, which would leave
    // nothing to re-attach for the kitty preview.
    this.#attachReadMedia(name, result, context);

    const patch = await runAbortable(context.signal, () => runner.emitToolResult({
      type: "tool_result",
      toolName: name,
      toolCallId,
      input: args,
      content: result.content,
      details: result.details,
      isError,
    }));
    if (patch) {
      result = {
        ...result,
        content: patch.content ?? result.content,
        ...(patch.details !== undefined ? { details: patch.details } : {}),
        ...(patch.isError !== undefined ? { isError: patch.isError } : {}),
      };
      isError = patch.isError ?? isError;
    }

    // Capture the read's clean text note AFTER the patch — the handoff strips
    // OMP's non-vision note and swaps the image for a description, so the first
    // surviving text block is the short read note (not the verbose description).
    this.#attachReadNote(name, result, context);

    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: name,
      result,
      isError,
    }));

    if (isError) {
      if (isOmpShellToolName(name)) {
        if (thrown === undefined && !resultHasTruncation(result.details)) {
          const exitCode = resultExitCode(result.details);
          if (exitCode !== undefined) throw ompBashExitError(exitCode, textContent(result.content));
        }
        throw ompBashResultError(thrown, textContent(result.content));
      }
      const text = textContent(result.content).trim();
      throw new Error(text || (thrown instanceof Error ? thrown.message : `OMP tool ${name} failed`));
    }
    this.#attachPreview(name, result, args, context);
    return this.#normalizeResult(name, result, args, patch?.content === undefined);
  }

  // Schema-enforce and early-startup calls may have no ExtensionRunner, so the
  // top-level tool_result marker middleware cannot run. Expand again at the
  // provider boundary; replacement is idempotent when middleware already ran.
  #normalizeResult(
    name: OmpCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    appendReadNewline = true,
  ): unknown {
    const normalized = normalizeResult(name, result, this.#artifactPaths, appendReadNewline);
    if (name !== "read" || typeof normalized !== "string") return normalized;
    return expandSkillDirMarkersForRead(normalized, args, this.#cwd);
  }

  #attachPartialPreview(
    name: OmpCoreToolName,
    partialResult: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): void {
    const progress = textContent(partialResult.content).trim();
    const boundedProgress = Array.from(progress).slice(-4_000).join("");
    const bashCommand =
      isOmpShellToolName(name) &&
      typeof args.command === "string" &&
      args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
        ? args.command
        : undefined;
    context.attachPreview?.({
      result: boundedProgress,
      ...(bashCommand !== undefined ? { bashCommand } : {}),
    });
    context.update(`${name}: ${boundedProgress.slice(-500) || "running"}`);
  }

  #attachPreview(
    name: OmpCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): void {
    if (result.isError) return;
    const details = result.details;
    const detailRecord =
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const bashCommand =
      isOmpShellToolName(name) &&
      typeof args.command === "string" &&
      args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
        ? args.command
        : undefined;
    const writeInput =
      name === "write" && typeof args.content === "string" ? args.content : undefined;
    const writeContent =
      writeInput !== undefined ? writeContentForPreview(writeInput) : undefined;
    const writeByteLength =
      writeInput !== undefined ? Buffer.byteLength(writeInput, "utf8") : undefined;
    const writeLineCount =
      writeInput !== undefined ? countContentLines(writeInput) : undefined;
    const hasWriteBefore =
      name === "write" &&
      detailRecord !== undefined &&
      Object.prototype.hasOwnProperty.call(detailRecord, "codePreviewBeforeWrite");
    context.attachPreview?.({
      result: normalizeResult(name, result),
      ...(bashCommand !== undefined ? { bashCommand } : {}),
      ...(writeContent !== undefined ? { writeContent } : {}),
      ...(writeByteLength !== undefined ? { writeByteLength } : {}),
      ...(writeLineCount !== undefined ? { writeLineCount } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(hasWriteBefore
        ? {
            codePreviewBeforeWrite: detailRecord?.codePreviewBeforeWrite,
            writeBeforeCaptured: true,
          }
        : {}),
    });
  }

  // `omp.read` of an image file returns `{ type: "image" }` content blocks.
  // normalizeResult strips them — the sandbox holds text only and the model
  // return is a string — but the single-call render wants them re-attached so
  // OMP core's ToolExecutionComponent renders the kitty image preview, the same
  // path a native `read` takes. Hand them out-of-band via context.attachMedia,
  // which the ActionRegistry stashes on the call audit; this bypasses the
  // result char bound that would otherwise truncate the base64 payload.
  //
  // Must run BEFORE any tool_result patch: pi-vision-handoff SWAPS image blocks
  // for text descriptions here (so the description becomes the sandbox value),
  // which would leave no image to capture. Capturing the original blocks lets
  // the single-call render show the kitty image, and the handoff's `context`
  // hook supplies the description to the model — exactly how a native `read`
  // keeps its image for kitty and swaps it only on the LLM-bound clone.
  #attachReadMedia(
    name: OmpCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read") return;
    const blocks = imageBlocks(result?.content);
    if (blocks.length > 0) context.attachMedia?.(blocks);
  }

  // The read tool's own text note (e.g. "Read image file [image/png]"), captured
  // AFTER any tool_result patch — pi-vision-handoff swaps image→description and
  // strips OMP's "[Current model does not support images…]" note there, so the
  // first surviving text block is the clean note. Used as the single-call body
  // and content text so the preview shows the kitty image + the clean note
  // instead of the handoff's verbose description; the model still receives the
  // description via the handoff's `context` hook swapping the image block.
  #attachReadNote(
    name: OmpCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read") return;
    const content = result?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        context.attachMedia?.([], (block as { text: string }).text);
        return;
      }
    }
  }

  #descriptor(
    name: OmpCoreToolName,
    tool: ToolDefinition<any, any>,
  ): FabricActionDescriptor {
    const sourceSchema = tool.parameters;
    const document = name === "edit"
      ? EDIT_COMPATIBILITY_SCHEMA
      : typeof sourceSchema === "function" && "toJsonSchema" in sourceSchema
        && typeof sourceSchema.toJsonSchema === "function"
        ? sourceSchema.toJsonSchema()
        : sourceSchema;
    const augmented = isOmpShellToolName(name) ? withShellCwdSchema(document) : document;
    const inputSchema = typeof augmented === "function" && "toJsonSchema" in augmented
      && typeof augmented.toJsonSchema === "function"
      ? augmented.toJsonSchema()
      : augmented;
    return {
      name,
      description: tool.description,
      inputSchema: inputSchema as Record<string, unknown>,
      risk: riskForTool(name),
      namespace: "builtin",
    };
  }
}
