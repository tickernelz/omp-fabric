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

/** Host names for a capability fabric routes under a different core name. */
export const OMP_CORE_TOOL_ALIASES: ReadonlyMap<string, OmpCoreToolName> = new Map([
  ["glob", "find"],
  ["search", "grep"],
]);

/** An alias is fabric's to hide only while the core tool it routes to is itself routed. */
export const routedAliasTarget = (
  name: string,
  routedNames: ReadonlySet<string>,
): OmpCoreToolName | undefined => {
  const target = OMP_CORE_TOOL_ALIASES.get(name);
  return target !== undefined && routedNames.has(target) ? target : undefined;
};

/** An empty host selection reads as unknown, so it denies nothing. */
export const ompCoreToolDenied = (
  name: string,
  hostActiveTools: ReadonlySet<string> | undefined,
): boolean => Boolean(hostActiveTools?.size) && !hostActiveTools!.has(name);

export const deniedOmpCoreTools = (
  hostActiveTools: ReadonlySet<string> | undefined,
): readonly OmpCoreToolName[] =>
  OMP_CORE_TOOL_NAMES.filter((name) => ompCoreToolDenied(name, hostActiveTools));
