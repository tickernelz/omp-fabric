import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { canonicalLcmPayload } from "../src/storage/lcm-ledger.js";
import type { LcmLedger } from "../src/storage/lcm-ledger.js";
import type { LcmMemoryLedger } from "../src/memory/lcm-adapter.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
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
});
