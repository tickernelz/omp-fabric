import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { canonicalLcmPayload } from "../src/storage/lcm-ledger.js";
import type { LcmLedger } from "../src/storage/lcm-ledger.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import { openLedger, releaseTemp, tempRoot } from "./fixtures/lcm-temp.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = {} as FabricInvocationContext;
const capability = (ledger: LcmLedger) => ({
  projectKey: ledger.project.key,
  readRaw: (sessionId?: string) => ledger.readRaw(ledger.project.key, sessionId),
  readRawPage: (sessionId?: string, offset?: number, limit?: number) => ledger.readRawPage(ledger.project.key, sessionId, offset, limit),
  readRawEntry: (sessionId: string, entryId: string, revision: number) => ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision),
});
afterEach(releaseTemp);

describe("MemoryProvider LCM seam", () => {
  it("routes recall and exact expansion through the shared ledger", async () => {
    const root = tempRoot("lcm-provider-");
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    const payload = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "provider seam exact fact" }] },
    };
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
        branchForSession: () => ({ activeSourceKeys: [`session-1:entry-1:${raw.revision}`], ready: true }),
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
});
