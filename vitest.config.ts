import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const agentDir = process.env.PI_CODING_AGENT_DIR
  ?? fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-suite-agent-"));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
    },
    maxWorkers: 2,
    restoreMocks: true,
    server: {
      deps: {
        external: [/\/node_modules\/(?:\.pnpm\/)?@oh-my-pi(?:[+/]|\/)/],
      },
    },
  },
});
