export const OMP_CORE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type OmpCoreToolName = (typeof OMP_CORE_TOOL_NAMES)[number];

const OMP_SHELL_TOOL_NAMES = ["bash"] as const;
export type OmpShellToolName = (typeof OMP_SHELL_TOOL_NAMES)[number];

export const isOmpShellToolName = (name: string): name is OmpShellToolName => name === "bash";

export const isOmpShellRef = (ref: string): boolean => ref === "omp.bash";

export const OMP_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(OMP_CORE_TOOL_NAMES);

/** The host tool a core tool replaces, when the two carry different names. `omp.find` runs the host's glob search; the host's own `find` is a semantic search fabric does not serve. */
const HOST_TOOL_FOR_CORE: ReadonlyMap<OmpCoreToolName, string> = new Map([["find", "glob"]]);

export const hostToolForCore = (name: OmpCoreToolName): string => HOST_TOOL_FOR_CORE.get(name) ?? name;

/** The host tools fabric replaces, and so the ones it owns while full code mode is on. */
export const FABRIC_OWNED_HOST_TOOLS: ReadonlySet<string> = new Set(OMP_CORE_TOOL_NAMES.map(hostToolForCore));

/** An empty host selection reads as unknown, so it denies nothing. */
export const ompCoreToolDenied = (
  name: string,
  hostActiveTools: ReadonlySet<string> | undefined,
): boolean => Boolean(hostActiveTools?.size)
  && !hostActiveTools!.has(OMP_CORE_TOOL_NAME_SET.has(name) ? hostToolForCore(name as OmpCoreToolName) : name);

export const deniedOmpCoreTools = (
  hostActiveTools: ReadonlySet<string> | undefined,
): readonly OmpCoreToolName[] =>
  OMP_CORE_TOOL_NAMES.filter((name) => ompCoreToolDenied(name, hostActiveTools));
