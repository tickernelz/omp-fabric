import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject): () => void {
  const owned: string[] = [];
  const make = (prefix: string): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    owned.push(directory);
    return directory;
  };
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? make("omp-fabric-suite-agent-");
  const stateHome = make("omp-fabric-suite-state-");
  const suiteTmp = make("omp-fabric-suite-tmp-");
  project.provide("suiteEnv", { agentDir, stateHome, suiteTmp });
  Object.assign(project.config.env ??= {}, {
    PI_CODING_AGENT_DIR: agentDir,
    XDG_STATE_HOME: stateHome,
    TMPDIR: suiteTmp,
    TEMP: suiteTmp,
    TMP: suiteTmp,
  });
  return () => {
    for (const directory of owned) fs.rmSync(directory, { recursive: true, force: true });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    suiteEnv: { agentDir: string; stateHome: string; suiteTmp: string };
  }
}
