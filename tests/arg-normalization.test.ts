import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, afterEach } from "vitest";
import {
  actionArgNormalizer,
  normalizeActionArgs,
} from "../src/providers/arg-normalization.js";
import {
  normalizeMemoryArgs,
  MemoryProvider,
} from "../src/providers/memory-provider.js";
import { normalizeStateArgs } from "../src/providers/state-provider.js";
import { normalizeSchemaArgs } from "../src/providers/schema-provider.js";
import { normalizeCompactArgs } from "../src/providers/compact-provider.js";
import { normalizeMeshArgs } from "../src/providers/mesh-provider.js";
import { normalizeAgentsArgs } from "../src/providers/agents-provider.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";
import type { FabricMemoryConfig } from "../src/config.js";
import { sessionDirNamesForCwd } from "../src/memory/discovery.js";
import {
  sessionHeader,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";

const tmpRoots: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-argnorm-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeActionArgs", () => {
  it("repairs alias spellings and drops the alias key", () => {
    expect(
      normalizeActionArgs({ id: "s1", extra: true }, { aliases: { id: "session" } }),
    ).toEqual({ session: "s1", extra: true });
  });

  it("keeps the canonical key on conflict and still drops the alias", () => {
    expect(
      normalizeActionArgs(
        { id: "alias", session: "canonical" },
        { aliases: { id: "session" } },
      ),
    ).toEqual({ session: "canonical" });
  });

  it("remaps value spellings", () => {
    expect(
      normalizeActionArgs({ scope: "cwd" }, { values: { scope: { cwd: "project" } } }),
    ).toEqual({ scope: "project" });
  });

  it("coerces numeric strings and leaves non-numeric strings untouched", () => {
    expect(
      normalizeActionArgs(
        { limit: "10", scope: "abc" },
        { numerics: ["limit", "scope"] },
      ),
    ).toEqual({ limit: 10, scope: "abc" });
  });

  it("coerces numeric-string array elements element-wise", () => {
    expect(
      normalizeActionArgs({ indices: ["2", 4, "x"] }, { numericArrays: ["indices"] }),
    ).toEqual({ indices: [2, 4, "x"] });
  });

  it("strips nullish values for declared keys only", () => {
    const out = normalizeActionArgs(
      { limit: null, bogus: undefined } as unknown as Record<string, unknown>,
      { knownKeys: ["limit"] },
    );
    expect(Object.keys(out)).toEqual(["bogus"]);
  });

  it("leaves unknown keys untouched for the validation stage", () => {
    expect(
      normalizeActionArgs({ before: 8, session: "s" }, { aliases: { id: "session" } }),
    ).toEqual({ before: 8, session: "s" });
  });

  it("never mutates the caller's object", () => {
    const args: Record<string, unknown> = { id: "s1", limit: "5" };
    normalizeActionArgs(args, { aliases: { id: "session" }, numerics: ["limit"] });
    expect(args).toEqual({ id: "s1", limit: "5" });
  });

  it("passes non-object arguments through unchanged", () => {
    expect(normalizeActionArgs("bare" as unknown as Record<string, unknown>, {})).toBe("bare");
  });
});

describe("schema-derived repair", () => {
  const normalize = actionArgNormalizer(() => [
    {
      name: "probe",
      inputSchema: {
        type: "object",
        properties: {
          entryRange: { type: "object" },
          labels: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "number" },
          indices: { type: "array", items: { type: "number" } },
          scope: { type: "string", enum: ["local", "lineage", "project"] },
        },
        additionalProperties: false,
      },
    },
  ]);

  it("repairs casing and snake_case variants of declared keys", () => {
    expect(
      normalize("probe", { entry_range: { first: 0, last: 1 }, TIMEOUTMS: "5" }),
    ).toEqual({ entryRange: { first: 0, last: 1 }, timeoutMs: 5 });
  });

  it("repairs singular spelling of a declared plural key", () => {
    expect(normalize("probe", { label: ["init"] })).toEqual({ labels: ["init"] });
  });

  it("coerces numeric strings from declared schema types, not a table", () => {
    expect(
      normalize("probe", { timeoutMs: "250", indices: ["1", "x"] }),
    ).toEqual({ timeoutMs: 250, indices: [1, "x"] });
  });

  it("repairs enum value casing variants", () => {
    expect(normalize("probe", { scope: "PROJECT" })).toEqual({ scope: "project" });
  });

  it("repairs enum values through synonym classes claimed by the declared enum", () => {
    expect(normalize("probe", { scope: "cwd" })).toEqual({ scope: "project" });
  });

  it("leaves enum synonyms untouched when the enum does not claim them", () => {
    expect(normalize("probe", { scope: "all" })).toEqual({ scope: "all" });
  });
});

describe("synonym lexicon", () => {
  it("repairs through classes when the schema declares a unique member", () => {
    const normalize = actionArgNormalizer(() => [
      {
        name: "probe",
        inputSchema: { type: "object", properties: { session: { type: "string" } } },
      },
    ]);
    expect(normalize("probe", { id: "s1" })).toEqual({ session: "s1" });
  });

  it("refuses ambiguous repairs and leaves the key for validation", () => {
    const normalize = actionArgNormalizer(() => [
      {
        name: "probe",
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" }, name: { type: "string" } },
        },
      },
    ]);
    expect(normalize("probe", { title: "t" })).toEqual({ title: "t" });
  });
});

describe("provider argument normalization", () => {
  it("memory.sessions repairs scope spellings and max with numeric coercion", () => {
    expect(normalizeMemoryArgs("sessions", { scope: "cwd", max: "3" })).toEqual({
      scope: "project",
      limit: 3,
    });
  });

  it("memory.expand repairs session/id spellings; window guesses pass through to validation", () => {
    expect(
      normalizeMemoryArgs("expand", { id: "75292bd6", indices: ["1", "2"], before: 8 }),
    ).toEqual({ session: "75292bd6", indices: [1, 2], before: 8 });
  });

  it("memory.recall repairs query and page size spellings", () => {
    expect(
      normalizeMemoryArgs("recall", {
        q: "auth",
        limit: "5",
        entry_range: { first: 0, last: 3 },
      }),
    ).toEqual({ query: "auth", pageSize: 5, entryRange: { first: 0, last: 3 } });
  });

  it("state repairs summary/label spellings and numeric strings", () => {
    expect(normalizeStateArgs("goal", { command: "make test" })).toEqual({
      check: "make test",
    });
    expect(
      normalizeStateArgs("verify", { label: ["init"], timeoutMs: "5000" }),
    ).toEqual({ labels: ["init"], timeoutMs: 5000 });
    expect(normalizeStateArgs("history", { name: "init", max: "3" })).toEqual({
      label: "init",
      limit: 3,
    });
  });

  it("schema repairs hypothesis id spellings", () => {
    for (const action of ["verify", "commit", "abort"]) {
      expect(normalizeSchemaArgs(action, { id: "h1" })).toEqual({ hypothesisId: "h1" });
    }
    expect(
      normalizeSchemaArgs("hypothesize", {
        description: "d",
        complexity_reduction: true,
      }),
    ).toEqual({ summary: "d", complexityReduction: true });
  });

  it("compact repairs instruction spellings", () => {
    expect(
      normalizeCompactArgs("request", { instruction: "summarize", requested_by: "me" }),
    ).toEqual({ instructions: "summarize", requestedBy: "me" });
  });

  it("mesh repairs publish text and CAS version spellings", () => {
    expect(normalizeMeshArgs("publish", { message: "hi" })).toEqual({ text: "hi" });
    expect(normalizeMeshArgs("put", { key: "k", version: "3" })).toEqual({
      key: "k",
      ifVersion: 3,
    });
    expect(normalizeMeshArgs("members", { max: "7", include_stale: true })).toEqual({
      limit: 7,
      includeStale: true,
    });
  });

  it("agents repair task, timeout, and id spellings", () => {
    expect(
      normalizeAgentsArgs("run", { prompt: "do it", timeout_ms: "5000" }),
    ).toEqual({ task: "do it", timeoutMs: 5000 });
    expect(normalizeAgentsArgs("wait", { agent_id: "a1" })).toEqual({ id: "a1" });
    expect(
      normalizeAgentsArgs("cleanup", { agentId: "a1", delete_branch: true }),
    ).toEqual({ id: "a1", deleteBranch: true });
  });
});

describe("ActionRegistry prepare before validate", () => {
  const probeProvider = (): FabricProvider => ({
    name: "probe",
    description: "Probe normalization stages",
    async list() {
      return [
        {
          name: "pick",
          description: "Pick a session",
          inputSchema: {
            type: "object",
            properties: { session: { type: "string" } },
            required: ["session"],
            additionalProperties: false,
          },
          risk: "read",
        },
      ];
    },
    async describe(name, invocation) {
      return (await this.list({}, invocation)).find((item) => item.name === name);
    },
    prepareArguments(_actionName, args) {
      return normalizeActionArgs(args, { aliases: { id: "session" } });
    },
    async invoke(_name, args) {
      return args;
    },
  });

  const registryContext = () => ({
    cwd: process.cwd(),
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    extensionContext: {} as ExtensionContext,
    update() {},
    approve: async () => {},
    audits: [],
    maxResultChars: 10_000,
  });

  it("prepares alias spellings before validation and invocation", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    const result = await registry.invoke("probe.pick", { id: "s1" }, registryContext());
    expect(result).toEqual({ session: "s1" });
  });

  it("names the offending property path for unrepairable keys", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    await expect(
      registry.invoke("probe.pick", { session: "s1", before: 8 }, registryContext()),
    ).rejects.toThrow(/probe\.pick[\s\S]*\/before/);
  });

  it("still enforces required canonical keys after repair", async () => {
    const registry = new ActionRegistry();
    registry.register(probeProvider());
    await expect(registry.invoke("probe.pick", {}, registryContext())).rejects.toThrow(/required/);
  });
});

describe("memory.sessions limit", () => {
  const cwd = "/home/user/normalize-proj";
  let agentDir: string;
  let indexDir: string;

  const makeMemoryConfig = (dir: string): FabricMemoryConfig => ({
    enabled: true,
    indexDir: dir,
    maxSessions: 500,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
  });

  const msg = (
    id: string,
    parentId: string | null,
    seconds: number,
    message: Record<string, unknown>,
  ): FixtureEntry => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(1_700_000_000_000 + seconds * 1_000).toISOString(),
    message,
  });

  const setup = () => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
    const dir = path.join(agentDir, "sessions", sessionDirNamesForCwd(cwd).canonical);
    (["a", "b", "c"] as const).forEach((id, offset) => {
      writeSessionFile(dir, `${offset + 1}_${id}.jsonl`, [
        sessionHeader(id, cwd),
        msg(`e${offset}`, null, offset, userMessage(`session ${id} notes`)),
      ]);
    });
  };

  const invocationContext = (): FabricInvocationContext => ({
    cwd,
    signal: undefined,
    parentToolCallId: "test",
    nestedToolCallId: "nested",
    extensionContext: {} as ExtensionContext,
    update() {},
  });

  it("prepareArguments repairs scope and max spellings for sessions", () => {
    setup();
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "a",
    });
    expect(
      provider.prepareArguments("sessions", { scope: "cwd", max: "2" }),
    ).toEqual({ scope: "project", limit: 2 });
  });

  it("invoke honors limit and defaults to every session in scope", async () => {
    setup();
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "a",
    });
    const all = (await provider.invoke(
      "sessions",
      { scope: "project" },
      invocationContext(),
    )) as { sessions?: unknown[] };
    expect(all.sessions).toHaveLength(3);
    const limited = (await provider.invoke(
      "sessions",
      { scope: "project", limit: 2 },
      invocationContext(),
    )) as { sessions?: unknown[] };
    expect(limited.sessions).toHaveLength(2);
  });
});
