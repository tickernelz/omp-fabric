import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const expandEnvDir = (envDir: string): string => {
  if (/^file:\/\//.test(envDir)) return fileURLToPath(envDir);
  if (envDir === "~") return homedir();
  if (envDir.startsWith("~/") || (process.platform === "win32" && envDir.startsWith("~\\"))) {
    return path.join(homedir(), envDir.slice(2));
  }
  return envDir;
};

export const resolveAgentDir = (): string => {
  const envDir = process.env.OMP_FABRIC_AGENT_DIR;
  if (envDir) return expandEnvDir(envDir);
  return getAgentDir();
};