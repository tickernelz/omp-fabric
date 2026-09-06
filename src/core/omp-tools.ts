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
