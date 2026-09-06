import os from "node:os";
import path from "node:path";
import type { FabricAgentConfig } from "../config.js";
import { resolveAgentDir } from "../core/agent-dir.js";


export const SESSION_EXPORT_ENV = "OMP_FABRIC_AGENT_DIR";

const expandHome = (value: string): string =>
  value === "~"
    ? os.homedir()
    : value.startsWith("~/") || value.startsWith(`~${path.win32.sep}`)
      ? path.join(os.homedir(), value.slice(2))
      : value;

/** Encode a project directory for the session export store. */
export const encodeSessionExportCwd = (cwd: string): string => {
  const absolute =
    path.isAbsolute(cwd) || path.win32.isAbsolute(cwd) ? cwd : path.resolve(cwd);
  return `--${absolute.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
};

/** Root of the export store, or undefined when `agents.sessionExport` is off. */
export const resolveSessionExportDir = (config: FabricAgentConfig): string | undefined => {
  if (!config.sessionExport) return undefined;
  const raw =
    process.env[SESSION_EXPORT_ENV]?.trim() ||
    config.sessionExportDir.trim() ||
    path.join(resolveAgentDir(), "fabric");
  return expandHome(raw);
};

/** Resolve one run's usage-only JSONL export path. */
export const sessionExportFileFor = (
  root: string,
  cwd: string,
  runId: string,
  at: Date,
): string => {
  const fileTimestamp = at.toISOString().replace(/[:.]/g, "-");
  return path.join(
    root,
    "sessions",
    ".fabric",
    encodeSessionExportCwd(cwd),
    `${fileTimestamp}_${runId}.jsonl`,
  );
};
