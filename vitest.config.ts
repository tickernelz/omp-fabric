import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const agentDir = process.env.PI_CODING_AGENT_DIR
  ?? fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-suite-agent-"));
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-suite-state-"));
// Windows runners execute this suite roughly three times slower than Linux, so
// the 5 s default turns process-spawn and fixture-heavy tests into timeouts
// that pass on rerun. Scale the deadlines there and keep the tight defaults
// everywhere else, where a hang is still worth catching quickly.
const slowRunner = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      XDG_STATE_HOME: stateHome,
    },
    maxWorkers: 2,
    testTimeout: slowRunner ? 30_000 : 5_000,
    hookTimeout: slowRunner ? 60_000 : 10_000,
    restoreMocks: true,
    server: {
      deps: {
        external: [/\/node_modules\/(?:\.pnpm\/)?@oh-my-pi(?:[+/]|\/)/],
      },
    },
  },
});
