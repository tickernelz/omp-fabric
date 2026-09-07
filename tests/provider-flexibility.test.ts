import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricMcpConfig, FabricMemoryConfig } from "../src/config.js";
import { sessionDirNamesForCwd } from "../src/memory/discovery.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { McpProvider } from "../src/providers/mcp-provider.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import { MeshProvider } from "../src/providers/mesh-provider.js";
import type { FabricParticipantInfo, FabricParticipantSource } from "../src/topology/types.js";
import { messageEntry, sessionHeader, userMessage, writeSessionFile } from "./fixtures/memory.js";

const { createRuntime, callTool } = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  callTool: vi.fn(),
}));
vi.mock("mcporter", () => ({ createRuntime }));

const context = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "flex",
  nestedToolCallId: "flex-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
} satisfies FabricInvocationContext;

const directories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-flex-${name}-`));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  callTool.mockClear();
});

const CONFIGURED_CALL_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_CEILING_MS = 900_000;

const mcpConfig = (configPath: string): FabricMcpConfig => ({
  enabled: true,
  configPath,
  disableOAuth: true,
  allowDynamicServers: false,
  callTimeoutMs: CONFIGURED_CALL_TIMEOUT_MS,
  cache: { enabled: false, revalidate: "off", revalidateBudgetMs: 1_000 },
});

const mcpProvider = (): McpProvider => {
  const cwd = temporaryDirectory("mcp");
  const configPath = path.join(cwd, "mcporter.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {}, imports: [] }));
  callTool.mockImplementation(async () => ({ content: [{ type: "text", text: "ok" }] }));
  createRuntime.mockImplementation(async () => ({
    listServers: () => ["probe"],
    listTools: async () => [{ name: "scan", description: "Scan", inputSchema: { type: "object" } }],
    getDefinition: () => ({ description: null, command: { kind: "stdio" } }),
    callTool,
    close: async () => {},
  }));
  return new McpProvider(cwd, mcpConfig(configPath));
};

const timeoutOfCall = (index: number): number =>
  (callTool.mock.calls[index]![2] as { timeoutMs: number }).timeoutMs;

describe("mcp per-call timeout", () => {
  it("defaults to the configured timeout and clamps an override to the ceiling", async () => {
    const provider = mcpProvider();
    try {
      const call = async (timeoutMs?: number) =>
        provider.invoke(
          "$call",
          { server: "probe", tool: "scan", args: {}, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
          context,
        );

      await expect(call()).resolves.toMatchObject({ text: "ok" });
      await call(300_000);
      await call(2_500);
      await call(5_000_000);

      expect(timeoutOfCall(0)).toBe(CONFIGURED_CALL_TIMEOUT_MS);
      expect(timeoutOfCall(1)).toBe(300_000);
      expect(timeoutOfCall(2)).toBe(2_500);
      expect(timeoutOfCall(3)).toBe(CALL_TIMEOUT_CEILING_MS);
    } finally {
      await provider.close();
    }
  });

  it("leaves the namespaced tool path on the configured timeout", async () => {
    const provider = mcpProvider();
    try {
      await expect(provider.invoke("probe.scan", { value: 1 }, context)).resolves.toMatchObject({
        text: "ok",
      });
      expect(timeoutOfCall(0)).toBe(CONFIGURED_CALL_TIMEOUT_MS);
      expect(callTool.mock.calls[0]![2]).toMatchObject({ args: { value: 1 } });
    } finally {
      await provider.close();
    }
  });

  it("declares timeoutMs on the \$call schema", async () => {
    const provider = mcpProvider();
    try {
      const described = await provider.describe("$call", context);
      expect(described?.inputSchema).toMatchObject({
        properties: { timeoutMs: { type: "number", minimum: 1 } },
      });
    } finally {
      await provider.close();
    }
  });
});

const identity: MeshIdentity = {
  id: "session:flex",
  name: "main",
  kind: "main",
  sessionId: "flex",
};

const participant = (id: string): FabricParticipantInfo => ({
  format: 1,
  id,
  kind: "actor",
  rootId: identity.id,
  ownerHostId: identity.id,
  ownerIdentityId: identity.id,
  parentId: identity.id,
  name: id,
  status: "idle",
  runner: "omp",
  transport: "host",
  capabilities: ["steer"],
  startedAt: 1,
  updatedAt: 2,
  controlProtocol: "v1",
  local: true,
  stale: false,
});

const meshProvider = (members: string[]): MeshProvider => {
  const root = temporaryDirectory("mesh");
  const source: FabricParticipantSource = {
    list: () => members.map(participant),
    get: () => undefined,
    self: () => participant("actor:self"),
    peers: () => [],
    async refresh() {},
    scheduleRefresh() {},
  };
  return new MeshProvider(
    new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
    identity,
    source,
  );
};

describe("mesh truncation reporting", () => {
  it("reports members totals only when asked, and both truncation states", async () => {
    const provider = meshProvider(["actor:a", "actor:b", "actor:c"]);

    const bare = await provider.invoke("members", { limit: 2 }, context);
    expect(Array.isArray(bare)).toBe(true);
    expect((bare as FabricParticipantInfo[]).map((entry) => entry.id)).toEqual([
      "actor:a",
      "actor:b",
    ]);

    const clipped = await provider.invoke("members", { limit: 2, withTotal: true }, context);
    expect(clipped).toEqual({ members: bare, total: 3, truncated: true });

    const complete = await provider.invoke("members", { withTotal: true }, context);
    expect(complete).toMatchObject({ total: 3, truncated: false });
    expect((complete as { members: FabricParticipantInfo[] }).members).toHaveLength(3);
  });

  it("reports state list totals only when asked, and both truncation states", async () => {
    const provider = meshProvider([]);
    for (const suffix of ["a", "b", "c"]) {
      await provider.invoke("put", { key: `task/${suffix}`, value: suffix }, context);
    }

    const bare = await provider.invoke("list", { prefix: "task/", limit: 2 }, context);
    expect(Array.isArray(bare)).toBe(true);
    expect((bare as { key: string }[]).map((entry) => entry.key)).toEqual(["task/a", "task/b"]);

    const clipped = await provider.invoke(
      "list",
      { prefix: "task/", limit: 2, withTotal: true },
      context,
    );
    expect(clipped).toEqual({ entries: bare, total: 3, truncated: true });

    const complete = await provider.invoke("list", { prefix: "task/", withTotal: true }, context);
    expect(complete).toMatchObject({ total: 3, truncated: false });
    expect((complete as { entries: unknown[] }).entries).toHaveLength(3);
  });
});

interface SessionsResult {
  scope: string;
  offset: number;
  total: number;
  truncated: boolean;
  sessions: { id: string }[];
  error?: { code: string; reason?: string; project?: string; projectPath?: string };
}

const memoryProvider = (
  maxSessions = 500,
  ids: string[] = ["first", "second", "third"],
): { provider: MemoryProvider; cwd: string; invocation: FabricInvocationContext } => {
  const agentDir = temporaryDirectory("agent");
  const indexDir = temporaryDirectory("index");
  const cwd = "/home/user/flexibility";
  const dir = path.join(agentDir, "sessions", sessionDirNamesForCwd(cwd).canonical);
  const base = Math.floor(Date.now() / 1_000) - 100;
  for (const [order, id] of ids.entries()) {
    const file = writeSessionFile(dir, `${order}-${id}.jsonl`, [
      sessionHeader(id, cwd),
      messageEntry(`${id}-u`, null, new Date(1_700_000_000_000 + order * 1_000).toISOString(), userMessage(id)),
    ]);
    fs.utimesSync(file, base + order, base + order);
  }
  const config: FabricMemoryConfig = {
    enabled: true,
    indexDir,
    maxSessions,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 3,
    digestTerms: 200,
  };
  return {
    provider: new MemoryProvider({ agentDir, cwd, config }),
    cwd,
    invocation: { ...context, cwd },
  };
};

const sessions = async (
  provider: MemoryProvider,
  args: Record<string, unknown>,
  invocation: FabricInvocationContext,
): Promise<SessionsResult> =>
  (await provider.invoke("sessions", args, invocation)) as SessionsResult;

describe("memory.sessions paging", () => {
  it("returns a complete unpaged answer when offset is omitted", async () => {
    const { provider, invocation } = memoryProvider();

    const result = await sessions(provider, { scope: "project" }, invocation);

    expect(result.sessions).toHaveLength(3);
    expect(result).toMatchObject({ offset: 0, total: 3, truncated: false });
  });

  it("pages with offset and reports truncation against the full total", async () => {
    const { provider, invocation } = memoryProvider();
    const all = await sessions(provider, { scope: "project" }, invocation);

    const head = await sessions(provider, { scope: "project", limit: 2 }, invocation);
    const tail = await sessions(provider, { scope: "project", limit: 2, offset: 2 }, invocation);

    expect(head).toMatchObject({ offset: 0, total: 3, truncated: true });
    expect(tail).toMatchObject({ offset: 2, total: 3, truncated: false });
    expect([...head.sessions, ...tail.sessions].map((entry) => entry.id)).toEqual(
      all.sessions.map((entry) => entry.id),
    );
  });

  it("returns an empty page past the end without claiming more remains", async () => {
    const { provider, invocation } = memoryProvider();

    const beyond = await sessions(provider, { scope: "project", offset: 9 }, invocation);

    expect(beyond.sessions).toEqual([]);
    expect(beyond).toMatchObject({ offset: 9, total: 3, truncated: false });
  });

  it("shapes an unresolvable project scope as a failure instead of throwing", async () => {
    const { provider, invocation } = memoryProvider();
    const missing = path.join(os.tmpdir(), "omp-fabric-flex-absent-project");

    const result = await sessions(provider, { scope: `project:${missing}` }, invocation);

    expect(result.error).toMatchObject({
      code: "invalid_project_scope",
      reason: "missing",
      project: missing,
      projectPath: missing,
    });

    const recalled = (await provider.invoke(
      "recall",
      { scope: `project:${missing}`, query: "anything" },
      invocation,
    )) as { hits: unknown[]; error?: { code: string } };
    expect(recalled.hits).toEqual([]);
    expect(recalled.error).toMatchObject({ code: "invalid_project_scope" });
  });

  it("reports the raw suffix and its expansion separately for a relative project scope", async () => {
    const { provider, cwd, invocation } = memoryProvider();

    const result = await sessions(provider, { scope: "project:./absent" }, invocation);

    expect(result.error).toMatchObject({
      code: "invalid_project_scope",
      project: "./absent",
      projectPath: path.resolve(cwd, "absent"),
    });
  });

  it("treats an empty project suffix as the session cwd rather than a failure", async () => {
    const { provider, invocation } = memoryProvider();

    const bare = await sessions(provider, { scope: "project" }, invocation);
    const empty = await sessions(provider, { scope: "project:" }, invocation);

    expect(empty.error).toBeUndefined();
    expect(empty.sessions.map((entry) => entry.id)).toEqual(
      bare.sessions.map((entry) => entry.id),
    );
  });
});

describe("memory.sessions total", () => {
  it("reports every session even when the browse cap is lower", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const { provider, invocation } = memoryProvider(3, ids);
    const page = await sessions(provider, { scope: "project", limit: 2 }, invocation);
    expect(page.total).toBe(ids.length);
    expect(page.sessions).toHaveLength(2);
    expect(page.truncated).toBe(true);
    const last = await sessions(provider, { scope: "project", limit: 2, offset: ids.length - 1 }, invocation);
    expect(last.sessions).toHaveLength(1);
    expect(last.truncated).toBe(false);
  });
});
