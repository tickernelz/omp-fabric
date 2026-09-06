import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sessionDirNamesForCwd } from "../src/memory/discovery.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  userMessage,
  writeSessionFile,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-memory-guest-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-guest-test",
  nestedToolCallId: "memory-guest-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

it("lets a guest program page, walk, filter, join, and return a compact result", async () => {
  const agentDir = temporaryDirectory();
  const indexDir = temporaryDirectory();
  const cwd = "/project/memory-guest";
  const sessionDir = path.join(agentDir, "sessions", sessionDirNamesForCwd(cwd).canonical);
  const alpha = writeSessionFile(sessionDir, "alpha.jsonl", [
    sessionHeader("alpha", cwd),
    messageEntry(
      "alpha-root",
      null,
      timestamp(0),
      userMessage(`SHARED_GUEST_MARKER alpha request ${"a".repeat(600)}`),
    ),
    messageEntry(
      "alpha-answer",
      "alpha-root",
      timestamp(1),
      assistantText("alpha answer"),
    ),
  ]);
  const beta = writeSessionFile(sessionDir, "beta.jsonl", [
    sessionHeader("beta", cwd),
    messageEntry(
      "beta-root",
      null,
      timestamp(2),
      userMessage(`SHARED_GUEST_MARKER beta request ${"b".repeat(600)}`),
    ),
    messageEntry(
      "beta-answer",
      "beta-root",
      timestamp(3),
      assistantText("beta answer"),
    ),
  ]);
  fs.utimesSync(alpha, 1_700_000_000, 1_700_000_000);
  fs.utimesSync(beta, 1_700_000_001, 1_700_000_001);

  const provider = new MemoryProvider({
    agentDir,
    cwd,
    config: {
      enabled: true,
      indexDir,
      maxSessions: 20,
      maxEntryChars: 2_000,
      indexThinking: false,
      indexToolOutput: true,
      hotSessions: 20,
    },
  });
  const context = invocationContext(cwd);
  const result = await new QuickJsRuntime().execute(
    `
let page = await memory.recall({
  scope: "project",
  query: "SHARED_GUEST_MARKER",
  pageSize: 1,
});
const total = page.total;
const recalled = [];
while (true) {
  for (const hit of page.hits) {
    if (hit.kind === "entry") recalled.push(hit.sessionId + ":" + hit.entryId);
  }
  if (page.next === null) break;
  page = await memory.recall(page.next.args);
}

const catalog = await memory.sessions({ scope: "project" });
const summaries = {};
let visited = 0;
for (const session of catalog.sessions ?? []) {
  const parentById = {};
  let assistants = 0;
  const walk = await memory.walk(
    { session: session.id, maxChars: 256, maxEntries: 1 },
    (entry) => {
      visited += 1;
      if (entry.entryId) parentById[entry.entryId] = entry.parentId;
      if (entry.role === "assistant") assistants += 1;
    },
  );
  if (walk.error) throw new Error(walk.error.message);
  summaries[session.id] = { assistants, parentById };
}
return { total, recalled, visited, summaries };
`,
    async (ref, args) => {
      if (!ref.startsWith("memory.")) throw new Error(`Unexpected guest call: ${ref}`);
      const action = ref.slice("memory.".length);
      return provider.invoke(action, provider.prepareArguments(action, args), context);
    },
    { timeoutMs: 10_000, memoryLimitBytes: 32 * 1024 * 1024 },
  );

  expect(result.error).toBeUndefined();
  expect(result.value).toEqual({
    total: 2,
    recalled: ["beta:beta-root", "alpha:alpha-root"],
    visited: 4,
    summaries: {
      beta: {
        assistants: 1,
        parentById: { "beta-root": null, "beta-answer": "beta-root" },
      },
      alpha: {
        assistants: 1,
        parentById: { "alpha-root": null, "alpha-answer": "alpha-root" },
      },
    },
  });
});
