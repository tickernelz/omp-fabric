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

const longBody = (label: string, length: number): string => {
  let text = "";
  while (text.length < length) text += label + "-" + text.length + "|";
  return text.slice(0, length);
};

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

  it("resumes an oversized constituent at textOffset before advancing to the next entry", () => {
    const ledger = ledgerAt("lcm-expand-long-");
    const long = longBody("long", 50000);
    const tail = "short tail body";
    const first = append(ledger, "s", "e1", long, 10);
    const second = append(ledger, "s", "e2", tail, 20);
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "one oversized constituent",
      children: [],
      sources: [
        { entryId: first.entryId, revision: first.revision, contentHash: first.contentHash },
        { entryId: second.entryId, revision: second.revision, contentHash: second.contentHash },
      ],
      createdAt: 30,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });

    type Chunk = { index: number; text: string; textRange: { start: number; end: number; total: number; complete: boolean } };
    type Page = { entries: Chunk[]; next: { args: Record<string, unknown> } | null; total: number };
    const pages: Page[] = [];
    const assembled = new Map<number, string>();
    let args: Record<string, unknown> = { session: "lcm.summary:leaf", branches: "all" };
    for (let guard = 0; guard < 8; guard += 1) {
      const page = adapter.expand(args) as unknown as Page;
      pages.push(page);
      for (const chunk of page.entries) {
        expect(chunk.textRange.start).toBe((assembled.get(chunk.index) ?? "").length);
        assembled.set(chunk.index, (assembled.get(chunk.index) ?? "") + chunk.text);
      }
      if (!page.next) break;
      args = page.next.args;
    }

    expect(pages).toHaveLength(3);
    expect(pages[0]?.entries.map((chunk) => chunk.index)).toEqual([0]);
    expect(pages[0]?.entries[0]?.textRange).toEqual({ start: 0, end: 20000, total: 50000, complete: false });
    expect(pages[0]?.next?.args).toMatchObject({ entryOffset: 0, textOffset: 20000 });
    expect(pages[1]?.entries.map((chunk) => chunk.index)).toEqual([0]);
    expect(pages[1]?.entries[0]?.textRange).toEqual({ start: 20000, end: 40000, total: 50000, complete: false });
    expect(pages[1]?.next?.args).toMatchObject({ entryOffset: 0, textOffset: 40000 });
    expect(pages[2]?.entries.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(pages[2]?.entries[0]?.textRange).toEqual({ start: 40000, end: 50000, total: 50000, complete: true });
    expect(pages[2]?.entries[1]?.textRange).toEqual({ start: 0, end: tail.length, total: tail.length, complete: true });
    expect(pages[2]?.next).toBeNull();
    expect(assembled.get(0)).toBe(long);
    expect(assembled.get(1)).toBe(tail);
  });

  it("refuses a summary pointer whose active lineage changed", () => {
    const ledger = ledgerAt("lcm-expand-lineage-");
    const entry = append(ledger, "s", "e1", "lineage bound body", 10);
    const bound: LcmSummaryNode = {
      nodeId: "bound",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      sourceHash: "leaf-hash",
      lineageFingerprint: "lineage-1",
      state: "ready",
      text: "lineage bound summary",
      children: [],
      sources: [{ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash }],
      createdAt: 20,
    };
    const unbound: LcmSummaryNode = {
      nodeId: "unbound",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      sourceHash: "leaf-hash",
      state: "ready",
      text: "lineage unbound summary",
      children: [],
      sources: bound.sources,
      createdAt: 20,
    };
    const nodes = [bound, unbound];
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => nodes, getNode: (id) => nodes.find((node) => node.nodeId === id) },
    });

    const accepted = adapter.expand({ session: "lcm.summary:bound", branches: "all", expectedLineageFingerprint: "lineage-1" });
    expect(accepted.error).toBeUndefined();
    expect(accepted.lineageFingerprint).toBe("lineage-1");
    expect((accepted.entries as Array<{ text: string }>)[0]?.text).toBe("lineage bound body");

    expect(adapter.expand({ session: "lcm.summary:bound", branches: "all", expectedLineageFingerprint: "lineage-2" })).toMatchObject({
      entries: [],
      next: null,
      error: { code: "stale_pointer", expectedLineageFingerprint: "lineage-2", actualLineageFingerprint: "lineage-1" },
    });
    expect(adapter.expand({ session: "lcm.summary:unbound", branches: "all", expectedLineageFingerprint: "lineage-1" })).toMatchObject({
      entries: [],
      next: null,
      error: { code: "stale_pointer", expectedLineageFingerprint: "lineage-1", actualLineageFingerprint: null },
    });
    expect(adapter.expand({ session: "lcm.summary:unbound", branches: "all" }).error).toBeUndefined();
  });

  it("spends the raw route's page budget so a many-constituent walk pays fewer pages", () => {
    const ledger = ledgerAt("lcm-expand-budget-");
    const sources: LcmSummaryNode["sources"] = [];
    ledger.transaction(() => {
      for (let index = 0; index < 40; index += 1) {
        const entry = append(ledger, "s", "e" + index, longBody("body" + index, 2000), 100 + index);
        sources.push({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash });
      }
    });
    const node: LcmSummaryNode = {
      nodeId: "wide",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "wide-hash",
      state: "ready",
      text: "forty constituents",
      children: [],
      sources,
      createdAt: 500,
    };
    let reads = 0;
    const counted: LcmMemoryLedger = {
      ...capability(ledger),
      readRawEntry: (sessionId, entryId, revision) => {
        reads += 1;
        return ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision);
      },
    };
    const walk = (extra: Record<string, unknown>, adapter = new LcmMemoryAdapter({
      ledger: counted,
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "wide" ? node : undefined) },
    })) => {
      reads = 0;
      let pages = 0;
      let chars = 0;
      let args: Record<string, unknown> = { session: "lcm.summary:wide", branches: "all", ...extra };
      for (;;) {
        const page = adapter.expand(args) as { entries: Array<{ text: string }>; next: { args: Record<string, unknown> } | null };
        pages += 1;
        for (const entry of page.entries) chars += entry.text.length;
        if (!page.next) return { pages, chars, reads, adapter };
        args = page.next.args;
      }
    };

    const narrow = walk({ maxChars: 4000 });
    expect({ pages: narrow.pages, chars: narrow.chars, reads: narrow.reads })
      .toEqual({ pages: 20, chars: 80000, reads: 40 });
    const standard = walk({});
    expect({ pages: standard.pages, chars: standard.chars, reads: standard.reads })
      .toEqual({ pages: 4, chars: 80000, reads: 40 });
    const again = walk({}, standard.adapter);
    expect({ pages: again.pages, chars: again.chars, reads: again.reads })
      .toEqual({ pages: 4, chars: 80000, reads: 0 });
  });

  it("re-descends when the branch binding or the node itself changes", () => {
    const ledger = ledgerAt("lcm-expand-memo-");
    const first = append(ledger, "s", "e1", "first body", 10);
    const second = append(ledger, "s", "e2", "second body", 20);
    const third = append(ledger, "s", "e3", "third body", 30);
    const reference = (entry: { entryId: string; revision: number; contentHash: string }) =>
      ({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash });
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "hash-a",
      state: "ready",
      text: "two constituents",
      children: [],
      sources: [reference(first), reference(second)],
      createdAt: 40,
    };
    let activeSourceKeys = ["s:e1:1", "s:e2:1"];
    let reads = 0;
    const adapter = new LcmMemoryAdapter({
      ledger: {
        ...capability(ledger),
        readRawEntry: (sessionId, entryId, revision) => {
          reads += 1;
          return ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision);
        },
      },
      currentSessionId: "s",
      branchForSession: () => ({ activeSourceKeys, ready: true }),
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    const descend = (branches: "active" | "all") => {
      reads = 0;
      const page = adapter.expand({ session: "lcm.summary:leaf", branches });
      return {
        texts: (page.entries as Array<{ text: string }>).map((entry) => entry.text),
        reads,
        error: page.error as { code?: string } | undefined,
      };
    };

    expect(descend("active")).toMatchObject({ texts: ["first body", "second body"], reads: 2 });
    expect(descend("active")).toMatchObject({ texts: ["first body", "second body"], reads: 0 });

    activeSourceKeys = ["s:e1:1"];
    expect(descend("active")).toMatchObject({ texts: [], error: { code: "stale_pointer" } });
    activeSourceKeys = ["s:e1:1", "s:e2:1"];

    node.sources = [reference(first), reference(third)];
    activeSourceKeys = ["s:e1:1", "s:e3:1"];
    expect(descend("active")).toMatchObject({ texts: ["first body", "third body"], reads: 2 });

    node.sources = [reference(first), reference(second)];
    node.sourceHash = "hash-b";
    activeSourceKeys = ["s:e1:1", "s:e2:1"];
    expect(descend("active")).toMatchObject({ texts: ["first body", "second body"], reads: 2 });
    expect(adapter.expand({ session: "lcm.summary:leaf" }).sourceHash).toBe("hash-b");
  });

  it("honors summary selectors and refuses addresses it cannot resolve", () => {
    const ledger = ledgerAt("lcm-expand-select-");
    const sources: LcmSummaryNode["sources"] = [];
    ledger.transaction(() => {
      for (let index = 0; index < 5; index += 1) {
        const entry = append(ledger, "s", "e" + index, "constituent " + index, 10 + index);
        sources.push({ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash });
      }
    });
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "five constituents",
      children: [],
      sources,
      createdAt: 50,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    const base = { session: "lcm.summary:leaf", branches: "all" };
    const texts = (args: Record<string, unknown>) =>
      (adapter.expand({ ...base, ...args }).entries as Array<{ text: string }>).map((entry) => entry.text);

    expect(texts({ indices: [1, 3] })).toEqual(["constituent 1", "constituent 3"]);
    expect(texts({ entryRange: { first: 2, last: 3 } })).toEqual(["constituent 2", "constituent 3"]);
    expect(texts({ entryIds: ["e4"] })).toEqual(["constituent 4"]);
    expect(texts({ operationAddresses: ["lcm.raw:s:e0:1"] })).toEqual(["constituent 0"]);
    expect(texts({ indices: [2], before: 1, after: 1 })).toEqual(["constituent 1", "constituent 2", "constituent 3"]);
    expect(adapter.expand({ ...base, indices: [1] })).toMatchObject({ entryCount: 5, total: 5 });

    expect(adapter.expand({ ...base, indices: [5] })).toMatchObject({
      entries: [],
      error: { code: "index_out_of_bounds", entryCount: 5, message: "Entry index 5 is outside 0..4." },
    });
    expect(adapter.expand({ ...base, entryRange: { first: 0, last: 5 } })).toMatchObject({
      entries: [],
      error: { code: "index_out_of_bounds", entryCount: 5 },
    });
    expect(adapter.expand({ ...base, entryIds: ["missing"] })).toMatchObject({
      entries: [],
      error: { code: "address_not_found", addressType: "entry_id", address: "missing", matches: 0 },
    });
    expect(() => adapter.expand({ ...base, before: 1 })).toThrow("memory.expand before/after requires one selected anchor");
    expect(() => adapter.expand({ ...base, indices: [0, 1], after: 1 })).toThrow("memory.expand before/after requires exactly one resolved anchor");
  });

  it("refuses an out-of-range continuation instead of clamping it to a page", () => {
    const ledger = ledgerAt("lcm-expand-bounds-");
    const entry = append(ledger, "s", "e0", "only constituent", 10);
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "one constituent",
      children: [],
      sources: [{ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash }],
      createdAt: 20,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    const base = { session: "lcm.summary:leaf", branches: "all" };

    expect(adapter.expand({ ...base, entryOffset: 1 })).toMatchObject({ entries: [], next: null });
    expect(adapter.expand({ ...base, entryOffset: 2 })).toMatchObject({
      entries: [],
      next: null,
      error: { code: "index_out_of_bounds", entryCount: 1, message: "Entry offset 2 is outside 0..1." },
    });
    expect(adapter.expand({ ...base, textOffset: "only constituent".length + 1 })).toMatchObject({
      entries: [],
      next: null,
      error: { code: "text_offset_out_of_bounds", textLength: "only constituent".length },
    });
  });

  it("never splits an astral code point across summary page chunks", () => {
    const ledger = ledgerAt("lcm-expand-astral-");
    const body = "a" + "\u{1f600}".repeat(200);
    const entry = append(ledger, "s", "e0", body, 10);
    const node: LcmSummaryNode = {
      nodeId: "leaf",
      projectKey: ledger.project.key,
      sessionId: "s",
      branch: null,
      kind: "leaf",
      sourceHash: "leaf-hash",
      state: "ready",
      text: "astral constituent",
      children: [],
      sources: [{ entryId: entry.entryId, revision: entry.revision, contentHash: entry.contentHash }],
      createdAt: 20,
    };
    const adapter = new LcmMemoryAdapter({
      ledger: capability(ledger),
      currentSessionId: "s",
      summaries: { listNodes: () => [node], getNode: (id) => (id === "leaf" ? node : undefined) },
    });
    expect(body.length).toBe(401);

    let assembled = "";
    let args: Record<string, unknown> = { session: "lcm.summary:leaf", branches: "all", maxChars: 256 };
    const widths: number[] = [];
    for (let guard = 0; guard < 8; guard += 1) {
      const page = adapter.expand(args) as { entries: Array<{ text: string }>; next: { args: Record<string, unknown> } | null };
      for (const chunk of page.entries) {
        widths.push(chunk.text.length);
        expect(chunk.text).toBe([...chunk.text].join(""));
        assembled += chunk.text;
      }
      if (!page.next) break;
      args = page.next.args;
    }
    expect(widths[0]).toBe(255);
    expect(assembled).toBe(body);
  });
});
