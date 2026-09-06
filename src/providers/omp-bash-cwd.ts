import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, type ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import type { OmpShellToolName } from "../core/omp-tools.js";

// Per-call execution directory for OMP's shell tools.
//
// OMP's shell backend already takes cwd as a first-class parameter
// (BashOperations.exec(command, cwd, options)), and pi-agent-core's harness
// shell goes further with a per-command ShellExecOptions.cwd. The shell tool
// schemas omit it, so Fabric advertises and honors it instead of silently
// executing in the session directory.
//
// The alternative — telling models to write `cd <dir> && <command>` — buries
// the directory in the command string, where it defeats extensions that match
// on command names (permission prompts, sandboxing) and hides the target from
// Fabric's own approval classifier.

export const OMP_BASH_CWD_KEY = "cwd";

/**
 * Resolve and validate a single shell call's execution directory.
 *
 * Relative paths resolve against the session cwd. Unlike the leaf-agent
 * resolver this deliberately does NOT canonicalize symlinks: agents commonly
 * target git worktrees whose paths are symlinks, and rewriting those to their
 * real targets changes what `pwd` reports inside the command and breaks
 * tooling that keys on the worktree path. `path.resolve` normalizes `..`
 * lexically, which is all the approval classifier needs to see a truthful
 * absolute target.
 *
 * Containment is intentionally not enforced. Models can already reach any
 * directory by changing directories inside a shell command, which Fabric
 * neither inspects nor contains. Directory containment belongs to OMP's
 * project-trust layer or a shell spawn hook.
 */
const resolveOmpShellCwd = (
  toolName: OmpShellToolName,
  sessionCwd: string,
  requested: unknown,
): string => {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new Error(
      `Invalid omp.${toolName} cwd ${JSON.stringify(requested)}: path must be a non-empty string`,
    );
  }
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(sessionCwd, requested);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("path is not a directory");
    accessSync(resolved, constants.R_OK | constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid omp.${toolName} cwd ${JSON.stringify(requested)} (${resolved}): ${reason}`,
    );
  }
  return resolved;
};

/** Compatibility wrapper retained for existing callers and tests. */
export const resolveOmpBashCwd = (sessionCwd: string, requested: unknown): string =>
  resolveOmpShellCwd("bash", sessionCwd, requested);

/**
 * Rewrite a shell call's cwd while leaving every other argument untouched.
 *
 * The extra key stays in the arguments so events, approval, and previews see
 * the resolved absolute target. The cwd-bound definition selected by the
 * provider is what ultimately passes it to the native shell backend.
 */
export const resolveShellCwdArgument = (
  toolName: OmpShellToolName,
  sessionCwd: string,
  args: Record<string, unknown>,
): Record<string, unknown> =>
  Object.hasOwn(args, OMP_BASH_CWD_KEY)
    ? {
        ...args,
        [OMP_BASH_CWD_KEY]: resolveOmpShellCwd(
          toolName,
          sessionCwd,
          args[OMP_BASH_CWD_KEY],
        ),
      }
    : args;

/** Compatibility wrapper retained for existing callers and tests. */
export const resolveBashCwdArgument = (
  sessionCwd: string,
  args: Record<string, unknown>,
): Record<string, unknown> => resolveShellCwdArgument("bash", sessionCwd, args);

const CWD_PROPERTY = Type.Optional(
  Type.String({
    description:
      "Execution directory for this command; relative paths resolve from the session cwd.",
  }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const schemaDocument = (schema: unknown): Record<string, unknown> | undefined => {
  if (isRecord(schema)) return schema;
  if (typeof schema !== "function" || !("toJsonSchema" in schema)) return undefined;
  const toJsonSchema = schema.toJsonSchema;
  if (typeof toJsonSchema !== "function") return undefined;
  const document = toJsonSchema.call(schema);
  return isRecord(document) ? document : undefined;
};

export const withShellCwdSchema = (schema: unknown): unknown => {
  const document = schemaDocument(schema);
  if (!document || !isRecord(document.properties)) return schema;
  if (Object.hasOwn(document.properties, OMP_BASH_CWD_KEY)) return schema;
  const cwdSchema = schemaDocument(CWD_PROPERTY);
  if (!cwdSchema) return schema;
  return Type.Unsafe({
    ...document,
    properties: { ...document.properties, [OMP_BASH_CWD_KEY]: cwdSchema },
  });
};

/** Compatibility wrapper retained for existing callers and tests. */
export const withBashCwdSchema = (schema: unknown): unknown => withShellCwdSchema(schema);

const MAX_CACHED_DEFINITIONS = 16;

type ShellDefinitionFactory = (cwd: string) => ToolDefinition<any, any>;

/** Definitions bound to execution directories, with a small LRU cache. */
class ShellCwdDefinitions {
  readonly #cache = new Map<string, ToolDefinition<any, any>>();

  constructor(private readonly createDefinition: ShellDefinitionFactory) {}

  get(cwd: string): ToolDefinition<any, any> {
    const cached = this.#cache.get(cwd);
    if (cached) {
      this.#cache.delete(cwd);
      this.#cache.set(cwd, cached);
      return cached;
    }
    const definition = this.createDefinition(cwd);
    this.#cache.set(cwd, definition);
    if (this.#cache.size > MAX_CACHED_DEFINITIONS) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    return definition;
  }
}

export class BashCwdDefinitions extends ShellCwdDefinitions {
  constructor() {
    super(createBashToolDefinition);
  }
}