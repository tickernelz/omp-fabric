import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { GrepTool, MULTI_FILE_PER_FILE_MATCHES, SINGLE_FILE_MATCHES } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { piEscapeRegexLiteral, piJoinPath } from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
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
            try {
              mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
              const id = randomUUID();
              const artifactPath = path.join(artifactRoot, `${toolType}-${id}.log`);
              writeFileSync(artifactPath, "", { mode: 0o600 });
              artifactPaths.set(id, artifactPath);
              artifactAllocations.getStore()?.push(artifactPath);
              return { id, path: artifactPath };
            } catch {
              return {};
            }
          },
        }
      : {}),
  };
};

const artifactAllocations = new AsyncLocalStorage<string[]>();

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

const normalizeReadArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const offset = finiteNumber(args.offset);
  const limit = finiteNumber(args.limit);
  if (offset === undefined && limit === undefined) return args;
  const { offset: _offset, limit: _limit, ...rest } = args;
  const target = parseReadTarget(args.path);
  if (!target || target.selected) return rest;
  const start = offset === undefined ? 1 : Math.max(1, Math.floor(offset));
  const end = limit === undefined ? Number.POSITIVE_INFINITY : start + Math.max(1, Math.floor(limit)) - 1;
  return { ...rest, path: readPageSelector({ ...target, endLimit: end }, start) };
};

const GREP_SKIP_PROPERTY = {
  type: "number",
  description: "Files to skip before collecting results — paginate when a search hit the file limit",
} as const;

const withGrepSkipSchema = (document: unknown): unknown => {
  const schema = asRecord(document);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties || Object.hasOwn(properties, "skip")) return document;
  return { ...schema, properties: { ...properties, skip: GREP_SKIP_PROPERTY } };
};

const grepSession = (cwd: string, context?: number): ToolSession =>
  ({
    cwd,
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated(
      context === undefined
        ? undefined
        : { "grep.contextBefore": Math.max(0, Math.floor(context)), "grep.contextAfter": Math.max(0, Math.floor(context)) },
    ),
  }) as unknown as ToolSession;

const createGrepDefinitionWithSkip = (cwd: string): ToolDefinition<any, any> => {
  const legacy = createGrepToolDefinition(cwd);
  const defaultTool = new GrepTool(grepSession(cwd));
  return {
    ...legacy,
    parameters: withGrepSkipSchema(legacy.parameters) as ToolDefinition<any, any>["parameters"],
    execute: (toolCallId, params, signal, onUpdate, context) => {
      const record = asRecord(params) ?? {};
      const rawPattern = typeof record.pattern === "string" ? record.pattern : "";
      const searchPath = typeof record.path === "string" ? record.path : ".";
      const glob = typeof record.glob === "string" ? record.glob : undefined;
      const contextLines = typeof record.context === "number" ? record.context : undefined;
      const skip = typeof record.skip === "number" ? record.skip : undefined;
      const tool = contextLines === undefined ? defaultTool : new GrepTool(grepSession(cwd, contextLines));
      return tool.execute(
        toolCallId,
        {
          pattern: record.literal === true ? piEscapeRegexLiteral(rawPattern) : rawPattern,
          path: glob ? piJoinPath(searchPath, glob) : searchPath,
          case: record.ignoreCase === true ? false : undefined,
          ...(skip === undefined ? {} : { skip }),
        } as never,
        signal,
        onUpdate as never,
        context as never,
      );
    },
  };
};

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

export const TRUNCATION_MARKER = "[[omp-fabric:truncated]]";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const appendTruncationMarker = (text: string, signal: Record<string, unknown>): string =>
  `${text.endsWith("\n") || text.length === 0 ? text : `${text}\n`}${TRUNCATION_MARKER} ${JSON.stringify(signal)}\n`;

type ReadTruncationMeta = {
  truncatedBy?: string;
  totalLines?: number;
  totalBytes?: number;
  outputBytes?: number;
  nextOffset?: number;
  partialLine: boolean;
  shownStart?: number;
  shownEnd?: number;
};

const readTruncationMeta = (details: unknown): ReadTruncationMeta | undefined => {
  const truncation = asRecord(asRecord(asRecord(details)?.meta)?.truncation);
  if (!truncation) return undefined;
  const shown = asRecord(truncation.shownRange);
  const truncatedBy = typeof truncation.truncatedBy === "string" ? truncation.truncatedBy : undefined;
  const totalLines = finiteNumber(truncation.totalLines);
  const totalBytes = finiteNumber(truncation.totalBytes);
  const outputBytes = finiteNumber(truncation.outputBytes);
  const nextOffset = finiteNumber(truncation.nextOffset);
  const shownStart = finiteNumber(shown?.start);
  const shownEnd = finiteNumber(shown?.end);
  return {
    partialLine: truncation.partialLine === true,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
    ...(totalLines === undefined ? {} : { totalLines }),
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(shownStart === undefined ? {} : { shownStart }),
    ...(shownEnd === undefined ? {} : { shownEnd }),
  };
};

const UNREADABLE_READ_NOTE = /^\[Cannot read (?:binary file '|\.[^\s:]+ file: )/;

const REPEAT_READ_HINT_PATTERN =
  /\n\n\[You have received this identical output \d+ times\. Re-reading '[\s\S]*?' will not change it — use a narrower selector \(path:A-B\), or proceed with the edit\.\]$/;

const stripRepeatReadHint = (text: string): string =>
  text.endsWith("]") ? text.replace(REPEAT_READ_HINT_PATTERN, "") : text;

const dropLeadingLines = (text: string, count: number): string => {
  if (count <= 0) return text;
  let index = 0;
  for (let dropped = 0; dropped < count; dropped++) {
    const newline = text.indexOf("\n", index);
    if (newline === -1) return "";
    index = newline + 1;
  }
  return text.slice(index);
};

const keepLeadingLines = (text: string, count: number): string => {
  if (count <= 0) return "";
  let index = 0;
  for (let kept = 0; kept < count; kept++) {
    const newline = text.indexOf("\n", index);
    if (newline === -1) return text;
    index = newline + 1;
  }
  return text.slice(0, index - 1);
};

const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
  return text.endsWith("\n") ? lines - 1 : lines;
};

const READ_SELECTOR_PATTERN = /:(raw:)?(\d+)(-(\d+)?)?$/i;
const READ_RAW_SELECTOR_PATTERN = /:raw$/i;

type ReadTarget = { base: string; start: number; endLimit: number; pageable: boolean; selected: boolean };

const readPageSelector = (target: ReadTarget, offset: number): string =>
  target.endLimit === Number.POSITIVE_INFINITY
    ? `${target.base}:raw:${offset}-`
    : `${target.base}:raw:${offset}-${target.endLimit}`;

const parseReadTarget = (rawPath: unknown): ReadTarget | undefined => {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("://")) return undefined;
  const match = READ_SELECTOR_PATTERN.exec(rawPath);
  if (match) {
    const end = match[3] === undefined ? Number.POSITIVE_INFINITY : match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4]);
    return { base: rawPath.slice(0, match.index), start: Number(match[2]), endLimit: end, pageable: true, selected: true };
  }
  if (READ_RAW_SELECTOR_PATTERN.test(rawPath)) {
    return {
      base: rawPath.replace(READ_RAW_SELECTOR_PATTERN, ""),
      start: 1,
      endLimit: Number.POSITIVE_INFINITY,
      pageable: true,
      selected: true,
    };
  }
  const lastColon = rawPath.lastIndexOf(":");
  const suffix = lastColon === -1 ? "" : rawPath.slice(lastColon + 1);
  const pageable = suffix.length === 0;
  return { base: rawPath, start: 1, endLimit: Number.POSITIVE_INFINITY, pageable, selected: false };
};

type NormalizeExtras = {
  read?: { signal?: Record<string, unknown>; path?: string };
  bashArtifactPath?: string;
  maxResultChars?: number;
};

const unreadableReadMessage = (note: string, readPath?: string): string => {
  const target = typeof readPath === "string" ? readPath.replace(READ_SELECTOR_PATTERN, "") : undefined;
  const remedy = target ? ` Read the bytes with omp.read("${target}:raw").` : "";
  return `omp.read returned no text content: ${note.trim()}${remedy}`;
};

const restoreBashOutput = (
  artifactPath: string | undefined,
  maxChars: number,
  delivered: string,
): string | undefined => {
  if (!artifactPath || maxChars <= 0) return undefined;
  let size: number;
  try {
    size = statSync(artifactPath).size;
  } catch {
    return undefined;
  }
  if (size === 0 || size > maxChars) return undefined;
  let full: string;
  try {
    full = readFileSync(artifactPath, "utf8");
  } catch {
    return undefined;
  }
  if (full.length < delivered.length) return undefined;
  const ellipsis = delivered.indexOf("…");
  const prefix = ellipsis === -1 ? delivered : delivered.slice(0, ellipsis);
  return full.startsWith(prefix) ? full : undefined;
};

const withoutColumnLimit = (
  detailRecord: Record<string, unknown>,
  metaRecord: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const limits = asRecord(metaRecord?.limits);
  if (!metaRecord || !limits || !Object.hasOwn(limits, "columnTruncated")) return detailRecord;
  const { columnTruncated: _dropped, ...remainingLimits } = limits;
  const { limits: _limits, ...remainingMeta } = metaRecord;
  const nextMeta = Object.keys(remainingLimits).length > 0
    ? { ...remainingMeta, limits: remainingLimits }
    : remainingMeta;
  if (Object.keys(nextMeta).length > 0) return { ...detailRecord, meta: nextMeta };
  const { meta: _meta, ...remainingDetails } = detailRecord;
  return remainingDetails;
};

const grepTruncationSignal = (details: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(details);
  if (!record || record.truncated !== true) return undefined;
  const perFile = finiteNumber(record.perFileLimitReached);
  const maxColumn = finiteNumber(asRecord(asRecord(asRecord(record.meta)?.limits)?.columnTruncated)?.maxColumn);
  const fileCount = finiteNumber(record.fileCount);
  const reasons: string[] = [];
  const notes: string[] = [];
  let continuation: unknown = null;
  if (perFile !== undefined) {
    reasons.push("matchLimit");
    notes.push(
      perFile <= MULTI_FILE_PER_FILE_MATCHES
        ? `Only ${perFile} matches per file are returned for a multi-file scope; point path at a single file to raise it to ${SINGLE_FILE_MATCHES}.`
        : `Only ${perFile} matches per file are returned; grep has no match cursor, so narrow the pattern or split the search by path.`,
    );
  }
  if (maxColumn !== undefined) {
    reasons.push("columnLimit");
    notes.push(
      `Match lines are cut at ${maxColumn} bytes by the host, so a reported line need not contain the match; read the full line with omp.read("<file>:<line>").`,
    );
  }
  if (reasons.length === 0) {
    reasons.push("fileLimit");
    if (fileCount !== undefined) continuation = { skip: fileCount };
    notes.push(
      fileCount === undefined
        ? "More files matched than were returned; narrow the pattern or path."
        : `More files matched than were returned; pass skip=${fileCount} for the next page.`,
    );
  }
  return {
    tool: "grep",
    partial: true,
    reasons,
    ...(finiteNumber(record.matchCount) === undefined ? {} : { matchCount: record.matchCount }),
    ...(fileCount === undefined ? {} : { fileCount }),
    ...(perFile === undefined ? {} : { perFileMatchLimit: perFile }),
    ...(maxColumn === undefined ? {} : { maxColumn }),
    continue: continuation,
    note: notes.join(" "),
  };
};

const GUEST_RESULT_CHAR_FALLBACK = 1_000_000;
const READ_MARKER_RESERVE_CHARS = 512;

const resultCharBound = (context: FabricInvocationContext): number => {
  const value = Reflect.get(context, "maxResultChars");
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : GUEST_RESULT_CHAR_FALLBACK;
};

const byteBudgetSignal = (meta: ReadTruncationMeta): Record<string, unknown> => ({
  tool: "read",
  partial: true,
  reasons: ["byteBudget"],
  totalBytes: meta.totalBytes ?? null,
  deliveredBytes: meta.outputBytes ?? null,
  continue: null,
  note:
    "A single line exceeded the host per-read byte budget and no read selector continues a partial line; split the file (omp.bash with fold or split) and read the pieces.",
});

const lineBudgetSignal = (
  meta: ReadTruncationMeta,
  target: ReadTarget | undefined,
  progress: { nextOffset: number | undefined; delivered: number; reason: string } | undefined,
): Record<string, unknown> => {
  const nextOffset = progress ? progress.nextOffset : meta.nextOffset;
  const continuation = target && nextOffset !== undefined ? readPageSelector(target, nextOffset) : null;
  return {
    tool: "read",
    partial: true,
    reasons: [progress?.reason ?? "lineBudget"],
    totalLines: meta.totalLines ?? null,
    deliveredLines: progress?.delivered ?? null,
    continue: continuation,
    note: continuation
      ? `More lines remain; continue with omp.read("${continuation}").`
      : "More lines remain and the host offered no continuation offset.",
  };
};

const findTruncationSignal = (details: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(details);
  if (!record || record.truncated !== true) return undefined;
  const reached = finiteNumber(record.resultLimitReached) ?? finiteNumber(record.fileCount);
  return {
    tool: "find",
    partial: true,
    reasons: ["resultLimit"],
    ...(reached === undefined ? {} : { resultLimit: reached }),
    continue: null,
    note: `The host caps find at ${reached ?? "its result limit"} results and clamps any larger limit, so narrow pattern or path, or enumerate with omp.bash.`,
  };
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
  extras?: NormalizeExtras,
): unknown => {
  const readSignal = extras?.read;
  const text = isOmpShellToolName(name)
    ? stripOmpBashTiming(textContent(result.content))
    : name === "read"
      ? stripRepeatReadHint(textContent(result.content))
      : textContent(result.content);
  if (result.isError && !resultHasTruncation(result.details)) throw new Error(text || `${name} failed`);
  if (name === "read") {
    const body = appendReadNewline && text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
    return readSignal?.signal ? appendTruncationMarker(body, readSignal.signal) : body;
  }
  if (name === "grep") {
    const signal = grepTruncationSignal(result.details);
    return signal ? appendTruncationMarker(text, signal) : text;
  }
  if (name === "find") {
    const signal = findTruncationSignal(result.details);
    return signal ? appendTruncationMarker(text, signal) : text;
  }
  if (name === "ls") return text;
  let details = result.details;
  let output = text;
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
      const fullOutputPath = typeof artifactId === "string"
        ? artifactPaths?.get(artifactId) ?? extras?.bashArtifactPath
        : extras?.bashArtifactPath;
      details = {
        ...detailRecord,
        truncation: { ...truncationRecord, truncated: true },
        ...(fullOutputPath ? { fullOutputPath } : {}),
      };
      if (truncationRecord.truncated !== false) {
        const columnCap = finiteNumber(asRecord(asRecord(metaRecord?.limits)?.columnTruncated)?.maxColumn);
        output = appendTruncationMarker(text, {
          tool: name,
          partial: true,
          reasons: columnCap === undefined ? ["outputLimit"] : ["outputLimit", "columnLimit"],
          truncatedBy: truncationRecord.truncatedBy ?? null,
          totalLines: finiteNumber(truncationRecord.totalLines) ?? null,
          totalBytes: finiteNumber(truncationRecord.totalBytes) ?? null,
          deliveredBytes: finiteNumber(truncationRecord.outputBytes) ?? null,
          ...(columnCap === undefined ? {} : { maxColumn: columnCap }),
          fullOutputPath: fullOutputPath ?? null,
          continue: null,
          note: fullOutputPath
            ? `Output exceeded the host bash result budget; the complete stream is on disk at ${fullOutputPath}.`
            : "Output exceeded the host bash result budget and no full-output artifact was retained.",
        });
      }
    } else {
      const columnCap = finiteNumber(asRecord(asRecord(metaRecord?.limits)?.columnTruncated)?.maxColumn);
      if (columnCap !== undefined) {
        const restored = restoreBashOutput(extras?.bashArtifactPath, extras?.maxResultChars ?? 0, text);
        if (restored === undefined) {
          details = {
            ...detailRecord,
            columnTruncated: { maxColumn: columnCap, restored: false },
            ...(extras?.bashArtifactPath ? { fullOutputPath: extras.bashArtifactPath } : {}),
          };
          output = appendTruncationMarker(text, {
            tool: name,
            partial: true,
            reasons: ["columnLimit"],
            maxColumn: columnCap,
            fullOutputPath: extras?.bashArtifactPath ?? null,
            continue: null,
            note: `Output lines were cut at ${columnCap} bytes by the host bash executor, which reads global settings and ignores this session's tools.outputMaxColumns.`,
          });
        } else {
          output = restored;
          details = {
            ...withoutColumnLimit(detailRecord, metaRecord),
            columnTruncated: { maxColumn: columnCap, restored: true },
          };
        }
      }
    }
  }
  if (name === "write" && details && typeof details === "object" && !Array.isArray(details)) {
    const { codePreviewBeforeWrite: _before, ...publicDetails } = details as Record<string, unknown>;
    details = Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
  }
  return { ok: true, output, details: details ?? null };
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
      grep: createGrepDefinitionWithSkip(cwd),
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
    if (actionName === "read") return normalizeReadArguments(record);
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
        return this.#normalizeResult(name, intercepted, args, context);
      }
    }
    // A captured extension override (e.g. an extension that registered a "read"
    // tool) already replays the full event lifecycle itself via
    // CapturedToolsProvider, so delegate to it unchanged.
    if (this.#catalog?.get(name)) {
      const result = await this.#capturedTools!.invoke(name, args, context);
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      return this.#normalizeResult(name, result, args, context, false);
    }
    const tool = this.#definitionFor(name, args);
    const runner = this.#catalog?.runner;
    // Without a runner (e.g. before the first tool refresh populated the
    // catalog) fall back to a direct execute — no extension hooks fire, but
    // the call still works. Once tools are refreshed the runner is available.
    if (!runner) {
      const artifacts: string[] = [];
      const result = await runAbortable(context.signal, () =>
        artifactAllocations.run(artifacts, () => tool.execute(
          context.nestedToolCallId,
          args,
          context.signal,
          (partialResult) => this.#attachPartialPreview(name, partialResult, args, context),
          this.#executionContextFor(name, args, context.extensionContext),
        )),
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
      return this.#normalizeResult(name, result, args, context, true, artifacts);
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
    const artifacts: string[] = [];
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
      result = (await runAbortable(context.signal, () => artifactAllocations.run(artifacts, () => tool.execute(
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
      )))) as OmpToolResult;
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
    return this.#normalizeResult(name, result, args, context, patch?.content === undefined, artifacts);
  }

  // Schema-enforce and early-startup calls may have no ExtensionRunner, so the
  // top-level tool_result marker middleware cannot run. Expand again at the
  // provider boundary; replacement is idempotent when middleware already ran.
  async #normalizeResult(
    name: OmpCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    appendReadNewline = true,
    artifacts?: readonly string[],
  ): Promise<unknown> {
    const extras: NormalizeExtras = {};
    if (isOmpShellToolName(name)) {
      const artifactPath = artifacts?.at(-1);
      if (artifactPath !== undefined) extras.bashArtifactPath = artifactPath;
      extras.maxResultChars = resultCharBound(context);
    }
    let effective = result;
    if (name === "read" && !this.#catalog?.get(name)) {
      const paged = await this.#completeRead(result, args, context);
      effective = paged.result;
      extras.read = paged.read;
    }
    const normalized = normalizeResult(name, effective, this.#artifactPaths, appendReadNewline, extras);
    if (name !== "read" || typeof normalized !== "string") return normalized;
    if (UNREADABLE_READ_NOTE.test(normalized)) throw new Error(unreadableReadMessage(normalized, extras.read?.path));
    return expandSkillDirMarkersForRead(normalized, args, this.#cwd);
  }

  async #completeRead(
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<{
    result: { content: ToolContent; details?: unknown; isError?: boolean };
    read: { signal?: Record<string, unknown>; path?: string };
  }> {
    const rawPath = args.path;
    const readPath = typeof rawPath === "string" ? rawPath : undefined;
    const base: { path?: string } = readPath === undefined ? {} : { path: readPath };
    const meta = readTruncationMeta(result.details);
    const target = parseReadTarget(rawPath);
    if (!meta || !target || result.isError === true) return { result, read: base };
    if (meta.truncatedBy === "bytes" || meta.partialLine) {
      return { result, read: { ...base, signal: byteBudgetSignal(meta) } };
    }
    const tool = this.#tools.read;
    if (!tool || !target.pageable || meta.nextOffset === undefined) {
      return { result, read: { ...base, signal: lineBudgetSignal(meta, target, undefined) } };
    }
    const budget = resultCharBound(context) - READ_MARKER_RESERVE_CHARS;
    let text = stripRepeatReadHint(textContent(result.content));
    let covered = meta.shownEnd ?? countLines(text);
    let nextOffset: number | undefined = meta.nextOffset;
    let stopped: "budget" | "bytes" | undefined;
    while (nextOffset !== undefined && covered < target.endLimit) {
      if (text.length + covered >= budget) {
        stopped = "budget";
        break;
      }
      const selector = readPageSelector(target, nextOffset);
      const page = await runAbortable(context.signal, () =>
        tool.execute(
          context.nestedToolCallId,
          { ...args, path: selector },
          context.signal,
          () => {},
          this.#executionContextFor("read", args, context.extensionContext),
        ),
      );
      const pageMeta = readTruncationMeta(page.details);
      const pageText = stripRepeatReadHint(textContent(page.content));
      const start = pageMeta?.shownStart ?? nextOffset;
      const body = dropLeadingLines(pageText, Math.max(0, covered - start + 1));
      const pageEnd = pageMeta?.shownEnd ?? start + countLines(pageText) - 1;
      if (body.length === 0 || pageEnd <= covered) {
        nextOffset = undefined;
        break;
      }
      const candidate = `${text.endsWith("\n") ? text : `${text}\n`}${body}`;
      if (candidate.length + pageEnd >= budget) {
        stopped = "budget";
        break;
      }
      text = candidate;
      covered = pageEnd;
      nextOffset = pageMeta?.nextOffset;
      if (pageMeta?.truncatedBy === "bytes" || pageMeta?.partialLine === true) {
        stopped = "bytes";
        break;
      }
    }
    if (target.endLimit !== Number.POSITIVE_INFINITY && covered > target.endLimit) {
      text = keepLeadingLines(text, target.endLimit - target.start + 1);
      covered = target.endLimit;
    }
    const remaining = stopped !== undefined || (nextOffset !== undefined && covered < target.endLimit);
    const paged: { content: ToolContent; details?: unknown; isError?: boolean } = {
      content: [{ type: "text", text }],
      details: result.details,
    };
    if (!remaining) return { result: paged, read: base };
    return {
      result: paged,
      read: {
        ...base,
        signal: lineBudgetSignal(meta, target, {
          nextOffset,
          delivered: covered,
          reason: stopped === "bytes" ? "byteBudget" : "resultBudget",
        }),
      },
    };
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
