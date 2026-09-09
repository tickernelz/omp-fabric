import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { canonicalLcmPayload } from "../src/storage/lcm-ledger.js";
import type { LcmLedger } from "../src/storage/lcm-ledger.js";
import type { LcmMemoryLedger, LcmSummaryNode } from "../src/memory/lcm-adapter.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { openLedger, releaseTemp, tempRoot } from "./fixtures/lcm-temp.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = {} as FabricInvocationContext;
const capability = (ledger: LcmLedger): LcmMemoryLedger => ({
  projectKey: ledger.project.key,
  readRaw: (sessionId?: string) => ledger.readRaw(ledger.project.key, sessionId),
  readRawPage: (sessionId?: string, offset?: number, limit?: number) => ledger.readRawPage(ledger.project.key, sessionId, offset, limit),
  readRawEntry: (sessionId: string, entryId: string, revision: number) => ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision),
  searchRaw: (options) => ledger.searchRaw(ledger.project.key, options),
});

const payloadOf = (entryId: string, text: string) => ({
  type: "message",
  id: entryId,
  parentId: null,
  timestamp: "2026-09-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

afterEach(releaseTemp);

describe("MemoryProvider LCM seam", () => {
  it("routes recall and exact expansion through the shared ledger", async () => {
    const root = tempRoot("lcm-provider-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    const payload = payloadOf("entry-1", "provider seam exact fact");
    const raw = ledger.appendRaw({
      projectKey: ledger.project.key,
      sessionId: "session-1",
      entryId: "entry-1",
      role: "user",
      content: "provider seam exact fact",
      payloadJson: canonicalLcmPayload(payload),
      parentEntryId: null,
      branch: "leaf-1",
    });
    const provider = new MemoryProvider({
      agentDir: root,
      cwd: root,
      config: DEFAULT_FABRIC_CONFIG.memory,
      sessionId: "session-1",
      lcm: {
        ledger: capability(ledger),
        currentSessionId: "session-1",
        summaries: { listNodes: () => [], getNode: () => undefined },
        branchForSession: () => ({ activeSourceKeys: ["session-1:entry-1:" + raw.revision], ready: true }),
      },
    });
    const recalled = await provider.invoke("recall", { query: "exact fact" }, context) as {
      hits: Array<{ kind: string; follow: { args: Record<string, unknown> } }>;
    };
    expect(recalled.hits).toHaveLength(1);
    expect(recalled.hits[0]?.kind).toBe("lcm.raw");
    const expanded = await provider.invoke("expand", recalled.hits[0]!.follow.args, context) as {
      entries: Array<{ structuredContent: unknown }>;
    };
    expect(expanded.entries[0]?.structuredContent).toEqual(payload);
  });

  it("applies queryMode regex on the LCM route", async () => {
    const root = tempRoot("lcm-provider-mode-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    for (const [entryId, text] of [["entry-1", "alpha 12345 beta"], ["entry-2", "alpha beta gamma"]] as const) {
      ledger.appendRaw({
        projectKey: ledger.project.key,
        sessionId: "session-1",
        entryId,
        role: "user",
        content: text,
        payloadJson: canonicalLcmPayload(payloadOf(entryId, text)),
      });
    }
    const provider = new MemoryProvider({
      agentDir: root,
      cwd: root,
      config: DEFAULT_FABRIC_CONFIG.memory,
      sessionId: "session-1",
      lcm: {
        ledger: capability(ledger),
        currentSessionId: "session-1",
        summaries: { listNodes: () => [], getNode: () => undefined },
      },
    });
    const pattern = "alpha [0-9]{5}";
    const byRegex = await provider.invoke("recall", { query: pattern, queryMode: "regex", branches: "all" }, context) as {
      hits: Array<{ source: { entryId?: string } }>;
    };
    expect(byRegex.hits.map((hit) => hit.source.entryId)).toEqual(["entry-1"]);
    const asLiteral = await provider.invoke("recall", { query: pattern, branches: "all" }, context) as {
      hits: Array<{ source: { entryId?: string } }>;
    };
    expect(asLiteral.hits.map((hit) => hit.source.entryId).sort()).toEqual(["entry-1", "entry-2"]);
  });

  it("rejects an invalid queryMode with the same error on both routes", async () => {
    const root = tempRoot("lcm-provider-reject-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    const base = { agentDir: root, cwd: root, config: DEFAULT_FABRIC_CONFIG.memory, sessionId: "session-1" };
    const plain = new MemoryProvider(base);
    const lcm = new MemoryProvider({
      ...base,
      lcm: {
        ledger: capability(ledger),
        currentSessionId: "session-1",
        summaries: { listNodes: () => [], getNode: () => undefined },
      },
    });
    const failure = async (provider: MemoryProvider, args: Record<string, unknown>): Promise<string> => {
      try {
        await provider.invoke("recall", args, context);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("recall accepted an invalid argument");
    };
    const mode = { query: "anything", queryMode: "fuzzy" };
    expect(await failure(lcm, mode)).toBe(await failure(plain, mode));
    expect(await failure(lcm, mode)).toBe('memory.recall queryMode must be "literal", "phrase", or "regex"');
    const match = { query: "anything", queryMode: "regex", queryMatch: "all" };
    expect(await failure(lcm, match)).toBe(await failure(plain, match));
    expect(await failure(lcm, match)).toBe("memory.recall queryMatch is only valid with literal queryMode");
  });

  it("lets guest memory.walk reassemble an oversized summary constituent", async () => {
    const root = tempRoot("lcm-provider-walk-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    let long = "";
    while (long.length < 45000) long += "long-" + long.length + "\u{1f600}|";
    long = long.slice(0, 45000);
    const tail = "short tail body";
    const appended = [long, tail].map((text, position) => ledger.appendRaw({
      projectKey: ledger.project.key,
      sessionId: "session-1",
      entryId: "entry-" + position,
      role: "user",
      content: text,
      payloadJson: canonicalLcmPayload(payloadOf("entry-" + position, text)),
      createdAt: 10 + position,
    }));
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "session-1",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      lineageFingerprint: "lineage-1",
      state: "ready",
      text: "one oversized constituent",
      children: [],
      sources: appended.map((entry) => ({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash })),
      createdAt: 30,
    };
    const provider = new MemoryProvider({
      agentDir: root,
      cwd: root,
      config: DEFAULT_FABRIC_CONFIG.memory,
      sessionId: "session-1",
      lcm: {
        ledger: capability(ledger),
        currentSessionId: "session-1",
        summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
      },
    });

    const refs: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
const seen = [];
const walk = await memory.walk({ session: "lcm.summary:leaf", branches: "all" }, async (entry) => {
  seen.push({ index: entry.index, address: entry.address, text: entry.text, textRange: entry.textRange });
  return true;
});
return { seen, walk };
`,
      async (ref, args) => {
        refs.push(ref);
        expect(ref).toBe("memory.expand");
        return await provider.invoke("expand", args, context);
      },
      { timeoutMs: 30_000, memoryLimitBytes: 64 * 1024 * 1024 },
    );

    expect(result.error).toBeUndefined();
    expect(result.terminationReason).toBe("completed");
    const value = result.value as {
      walk: { visited: number; stopped: boolean };
      seen: Array<{ index: number; address: string; text: string; textRange: Record<string, unknown> }>;
    };
    expect(value.walk).toEqual({ visited: 2, stopped: false });
    expect(value.seen.map((entry) => entry.index)).toEqual([0, 1]);
    expect(value.seen[0]?.address).toBe("lcm.raw:session-1:entry-0:" + appended[0]!.revision);
    expect(value.seen[0]?.text).toBe(long);
    expect(value.seen[0]?.textRange).toEqual({ start: 0, end: 45000, total: 45000, complete: true });
    expect(value.seen[1]?.text).toBe(tail);
    expect(refs.length).toBeGreaterThan(2);
  });

  it("spends the advertised expand budget and refuses an out-of-range summary offset", async () => {
    const root = tempRoot("lcm-provider-budget-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    let body = "";
    while (body.length < 60000) body += "chunk-" + body.length + "\u{1f600}|";
    body = body.slice(0, 60000);
    const raw = ledger.appendRaw({
      projectKey: ledger.project.key,
      sessionId: "session-1",
      entryId: "entry-0",
      role: "user",
      content: body,
      payloadJson: canonicalLcmPayload(payloadOf("entry-0", body)),
      createdAt: 10,
    });
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "session-1",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "one oversized constituent",
      children: [],
      sources: [{ entryId: raw.entryId, revision: raw.revision, contentHash: raw.contentHash }],
      createdAt: 20,
    };
    const provider = new MemoryProvider({
      agentDir: root,
      cwd: root,
      config: DEFAULT_FABRIC_CONFIG.memory,
      sessionId: "session-1",
      lcm: {
        ledger: capability(ledger),
        currentSessionId: "session-1",
        summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
      },
    });

    const descriptors = await provider.list({}, context);
    const expand = descriptors.find((action) => action.name === "expand");
    const advertised = ((expand?.inputSchema as {
      properties: { maxChars: { default: number } };
    }).properties).maxChars.default;
    expect(advertised).toBe(20_000);

    const page = await provider.invoke("expand", { session: "lcm.summary:leaf", branches: "all" }, context) as {
      entries: Array<{ text: string; textRange: { end: number; total: number } }>;
      entryCount: number;
    };
    expect(page.entries[0]?.textRange).toMatchObject({ end: advertised, total: 60000 });
    expect(page.entries[0]?.text).toBe(body.slice(0, advertised));
    expect(page.entryCount).toBe(1);

    const refused = await provider.invoke("expand", { session: "lcm.summary:leaf", branches: "all", entryOffset: 4 }, context) as {
      entries: unknown[];
      error: { code: string; entryCount: number };
    };
    expect(refused.entries).toEqual([]);
    expect(refused.error).toMatchObject({ code: "index_out_of_bounds", entryCount: 1 });

    const outOfRange = await provider.invoke("expand", { session: "lcm.summary:leaf", branches: "all", indices: [3] }, context) as {
      error: { code: string };
    };
    expect(outOfRange.error).toMatchObject({ code: "index_out_of_bounds" });
  });

  it("keeps one LCM adapter so a paged summary walk descends once", async () => {
    const root = tempRoot("lcm-provider-descent-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    const sources: LcmSummaryNode["sources"] = [];
    let body = "";
    while (body.length < 3000) body += "constituent-" + body.length + "|";
    body = body.slice(0, 3000);
    for (let index = 0; index < 24; index += 1) {
      const entry = ledger.appendRaw({
        projectKey: ledger.project.key,
        sessionId: "session-1",
        entryId: "entry-" + index,
        role: "user",
        content: body,
        payloadJson: canonicalLcmPayload(payloadOf("entry-" + index, body)),
        createdAt: 100 + index,
      });
      sources.push({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash });
    }
    const node: LcmSummaryNode = {
      nodeId: "wide",
      projectKey: ledger.project.key,
      sessionId: "session-1",
      branch: null,
      kind: "leaf",
      sourceHash: "wide-hash",
      state: "ready",
      text: "twenty-four constituents",
      children: [],
      sources,
      createdAt: 500,
    };
    let reads = 0;
    const provider = new MemoryProvider({
      agentDir: root,
      cwd: root,
      config: DEFAULT_FABRIC_CONFIG.memory,
      sessionId: "session-1",
      lcm: {
        ledger: {
          ...capability(ledger),
          readRawEntry: (sessionId, entryId, revision) => {
            reads += 1;
            return ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision);
          },
        },
        currentSessionId: "session-1",
        summaries: { listNodes: () => [node], getNode: (id) => (id === "wide" ? node : undefined) },
      },
    });

    let pages = 0;
    let chars = 0;
    let args: Record<string, unknown> = { session: "lcm.summary:wide", branches: "all" };
    for (;;) {
      const page = await provider.invoke("expand", args, context) as {
        entries: Array<{ text: string }>;
        next: { args: Record<string, unknown> } | null;
      };
      pages += 1;
      for (const entry of page.entries) chars += entry.text.length;
      if (!page.next) break;
      args = page.next.args;
    }
    expect(pages).toBe(4);
    expect(chars).toBe(24 * 3000);
    expect(reads).toBe(24);
  });
});
