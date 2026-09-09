import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LcmLedger } from "../src/storage/lcm-ledger.js";
import { openLedger, releaseTemp, tempRoot } from "./fixtures/lcm-temp.js";
import { LcmMemoryAdapter, type LcmMemoryLedger, type LcmSummaryNode } from "../src/memory/lcm-adapter.js";

const capability = (ledger: LcmLedger): LcmMemoryLedger => ({
  projectKey: ledger.project.key,
  readRaw: (sessionId?: string) => ledger.readRaw(ledger.project.key, sessionId),
  readRawPage: (sessionId?: string, offset?: number, limit?: number) => ledger.readRawPage(ledger.project.key, sessionId, offset, limit),
  readRawEntry: (sessionId: string, entryId: string, revision: number) => ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision),
  searchRaw: (options) => ledger.searchRaw(ledger.project.key, options),
});

const message = (entryId: string, text: string) => JSON.stringify({
  type: "message",
  id: entryId,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

const append = (ledger: LcmLedger, sessionId: string, entryId: string, text: string, createdAt: number) =>
  ledger.appendRaw({
    projectKey: ledger.project.key,
    sessionId,
    entryId,
    role: "user",
    content: text,
    payloadJson: message(entryId, text),
    createdAt,
  });

const ledgerAt = (prefix: string): LcmLedger => {
  const dir = tempRoot(prefix);
  return openLedger({ dbPath: path.join(dir, "a.sqlite"), project: { liveCwd: dir } });
};

afterEach(releaseTemp);

describe("LCM memory retrieval", () => {
  it("does not expose a mutable database capability", () => {
    const ledger = ledgerAt("lcm-memory-");
    const adapter = new LcmMemoryAdapter({ ledger: capability(ledger), summaries: { listNodes: () => [], getNode: () => undefined } });
    const exposed = (adapter as unknown as { options: { ledger: Record<string, unknown> } }).options.ledger;
    expect("db" in exposed).toBe(false);
    expect("readOnly" in exposed).toBe(false);
  });

  it("merges bounded raw and ready summary hits deterministically", () => {
    const ledger = ledgerAt("lcm-memory-");
    const raw = append(ledger, "s", "e", "alpha exact", 1);
    const node: LcmSummaryNode = {
      nodeId: "n",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      sourceHash: "summary-hash",
      state: "ready",
      text: "alpha summary",
      children: [],
      sources: [{ entryId: raw.entryId, revision: raw.revision, contentHash: raw.contentHash }],
      createdAt: 1,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      branchForSession: () => ({ activeSourceKeys: ["s:e:" + raw.revision], ready: true }),
      summaries: { listNodes: () => [node], getNode: (id) => (id === "n" ? node : undefined) },
    });
    const result = adapter.recall({ query: "alpha", pageSize: 1 });
    expect(result.total).toBe(2);
    expect(result.hits[0]?.kind).toBe("lcm.raw");
    expect(result.next?.args.offset).toBe(1);
    const expanded = adapter.expand(result.hits[0]!.follow.args);
    expect((expanded.entries as Array<{ text: string }>)[0]?.text).toContain("alpha exact");
  });

  it("reports incomplete coverage and stale pointers", () => {
    const ledger = ledgerAt("lcm-memory-");
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      branchForSession: () => ({ activeSourceKeys: [], ready: true }),
      summaries: {
        listNodes: () => [{ nodeId: "n", projectKey: ledger.project.key, sessionId: "s", branch: null, sourceHash: "h", state: "failed", text: "alpha", children: [], sources: [], createdAt: 1 }],
        getNode: () => undefined,
      },
    });
    const result = adapter.recall({ query: "no-match" });
    expect(result.hits).toHaveLength(0);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain("summary_failed");
    expect(adapter.expand({ session: "lcm.raw:s:e:1" })).toMatchObject({ error: { code: "stale_pointer" } });
  });

  it("recalls a term that exists only in the newest entry of a long session", () => {
    const ledger = ledgerAt("lcm-newest-");
    const total = 1200;
    ledger.transaction(() => {
      for (let index = 0; index < total; index += 1) {
        const newest = index === total - 1;
        append(ledger, "s", "e" + index, newest ? "zephyrmarker closing note" : "filler line " + index, 1000 + index);
      }
    });
    const adapter = new LcmMemoryAdapter({ ledger: capability(ledger), currentSessionId: "s", summaries: { listNodes: () => [], getNode: () => undefined } });
    const found = adapter.recall({ query: "zephyrmarker", branches: "all" });
    expect(found.total).toBe(1);
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]?.snippet).toContain("zephyrmarker");
    expect(found.hits[0]?.follow.args.session).toBe("lcm.raw:s:e" + (total - 1) + ":1");
    const browsed = adapter.recall({ branches: "all", pageSize: 3 });
    expect(browsed.total).toBe(total);
    expect(browsed.hits.map((hit) => hit.source.entryId)).toEqual(["e1199", "e1198", "e1197"]);
    expect(browsed.coverage.complete).toBe(true);
  });

  it("pages past the scan bound without dropping newer entries", () => {
    const ledger = ledgerAt("lcm-bound-");
    ledger.transaction(() => {
      for (let index = 0; index < 40; index += 1) append(ledger, "s", "e" + index, "bounded body " + index, 1000 + index);
    });
    const adapter = new LcmMemoryAdapter({ ledger: capability(ledger), currentSessionId: "s", maxRawEntries: 10, summaries: { listNodes: () => [], getNode: () => undefined } });
    const first = adapter.recall({ branches: "all", pageSize: 4 });
    expect(first.hits.map((hit) => hit.source.entryId)).toEqual(["e39", "e38", "e37", "e36"]);
    const second = adapter.recall({ ...first.next!.args, branches: "all", pageSize: 4 });
    expect(second.hits.map((hit) => hit.source.entryId)).toEqual(["e35", "e34", "e33", "e32"]);
  });

  it("applies regex and phrase query modes to summary text", () => {
    const ledger = ledgerAt("lcm-mode-");
    const nodes: LcmSummaryNode[] = [
      { nodeId: "n1", projectKey: ledger.project.key, sessionId: "s", branch: null, sourceHash: "h1", state: "ready", text: "ticket 4821 resolved", children: [], sources: [], createdAt: 2 },
      { nodeId: "n2", projectKey: ledger.project.key, sessionId: "s", branch: null, sourceHash: "h2", state: "ready", text: "ticket unresolved backlog", children: [], sources: [], createdAt: 1 },
    ];
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => nodes, getNode: (id) => nodes.find((node) => node.nodeId === id) },
    });
    const byRegex = adapter.recall({ query: "ticket [0-9]{4} ", queryMode: "regex", branches: "all" });
    expect(byRegex.hits.map((hit) => hit.source.nodeId)).toEqual(["n1"]);
    const byPhrase = adapter.recall({ query: "unresolved backlog", queryMode: "phrase", branches: "all" });
    expect(byPhrase.hits.map((hit) => hit.source.nodeId)).toEqual(["n2"]);
    const byLiteral = adapter.recall({ query: "ticket", branches: "all" });
    expect(byLiteral.hits.map((hit) => hit.source.nodeId)).toEqual(["n1", "n2"]);
    const broken = adapter.recall({ query: "ticket (", queryMode: "regex", branches: "all" });
    expect(broken.hits).toHaveLength(0);
    expect(broken.coverage.reasons).toContain("invalid_regex");
  });

  it("expands a summary into the constituent raw entries it was built from", () => {
    const ledger = ledgerAt("lcm-expand-");
    const first = append(ledger, "s", "e1", "first constituent body", 10);
    const second = append(ledger, "s", "e2", "second constituent body", 20);
    const leaf: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "two constituents summarized",
      children: [],
      sources: [
        { entryId: second.entryId, revision: second.revision, contentHash: second.contentHash },
        { entryId: first.entryId, revision: first.revision, contentHash: first.contentHash },
      ],
      createdAt: 30,
    };
    const condensed: LcmSummaryNode = {
      nodeId: "condensed",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "condensed",
      sourceHash: "condensed-hash",
      state: "ready",
      text: "one level up",
      children: ["leaf"],
      sources: [],
      createdAt: 40,
    };
    const nodes = [leaf, condensed];
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      branchForSession: () => ({ activeSourceKeys: ["s:e1:1", "s:e2:1"], ready: true }),
      summaries: { listNodes: () => nodes, getNode: (id) => nodes.find((node) => node.nodeId === id) },
    });

    const expanded = adapter.expand({ session: "lcm.summary:leaf" });
    const entries = expanded.entries as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.text)).toEqual(["first constituent body", "second constituent body"]);
    expect(entries.map((entry) => entry.address)).toEqual(["lcm.raw:s:e1:1", "lcm.raw:s:e2:1"]);
    expect((entries[0]?.follow as { args: { session: string } }).args.session).toBe("lcm.raw:s:e1:1");
    expect(adapter.expand((entries[0]?.follow as { args: Record<string, unknown> }).args)).toMatchObject({
      entries: [{ text: "first constituent body" }],
    });
    expect(expanded.node).toMatchObject({ nodeId: "leaf", kind: "leaf", text: "two constituents summarized", sourceHash: "leaf-hash", children: [], sources: leaf.sources });
    expect(expanded.next).toBeNull();

    const descended = adapter.expand({ session: "lcm.summary:condensed" });
    const children = descended.entries as Array<Record<string, unknown>>;
    expect(children).toHaveLength(1);
    expect(children[0]?.address).toBe("lcm.summary:leaf");
    expect(children[0]?.text).toBe("two constituents summarized");
    expect(children[0]?.type).toBe("summary");
    expect(descended.node).toMatchObject({ kind: "condensed" });
  });

  it("pages constituent entries and refuses a stale summary pointer", () => {
    const ledger = ledgerAt("lcm-expand-page-");
    const sources: LcmSummaryNode["sources"] = [];
    ledger.transaction(() => {
      for (let index = 0; index < 3; index += 1) {
        const entry = append(ledger, "s", "e" + index, "constituent " + index, 10 + index);
        sources.push({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash });
      }
    });
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      sourceHash: "leaf-hash",
      state: "ready",
      text: "three constituents",
      children: [],
      sources,
      createdAt: 50,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    const first = adapter.expand({ session: "lcm.summary:leaf", branches: "all", maxEntries: 2 });
    expect((first.entries as Array<{ address: string }>).map((entry) => entry.address)).toEqual(["lcm.raw:s:e0:1", "lcm.raw:s:e1:1"]);
    expect(first.total).toBe(3);
    const next = (first.next as { args: Record<string, unknown> }).args;
    expect(next.entryOffset).toBe(2);
    const second = adapter.expand(next);
    expect((second.entries as Array<{ address: string; index: number }>).map((entry) => entry.address)).toEqual(["lcm.raw:s:e2:1"]);
    expect((second.entries as Array<{ index: number }>)[0]?.index).toBe(2);
    expect(second.next).toBeNull();

    expect(adapter.expand({ session: "lcm.summary:leaf", branches: "all", expectedSourceHash: "changed" })).toMatchObject({
      entries: [],
      error: { code: "stale_pointer" },
    });
  });

  it("keeps branch scoping and reports unavailable constituents", () => {
    const ledger = ledgerAt("lcm-expand-branch-");
    const kept = append(ledger, "s", "e1", "kept body", 10);
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      sourceHash: "leaf-hash",
      state: "ready",
      text: "one present one missing",
      children: [],
      sources: [
        { entryId: kept.entryId, revision: kept.revision, contentHash: kept.contentHash },
        { entryId: "ghost", revision: 1, contentHash: "gone" },
      ],
      createdAt: 20,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      branchForSession: () => ({ activeSourceKeys: ["s:e1:1"], ready: true }),
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    expect(adapter.expand({ session: "lcm.summary:leaf" })).toMatchObject({ error: { code: "stale_pointer" } });
    const acrossBranches = adapter.expand({ session: "lcm.summary:leaf", branches: "all" });
    expect((acrossBranches.entries as Array<{ address: string }>).map((entry) => entry.address)).toEqual(["lcm.raw:s:e1:1"]);
    expect(acrossBranches.error).toMatchObject({ code: "incomplete_coverage" });
  });
});
