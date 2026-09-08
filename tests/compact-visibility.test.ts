import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompactController,
  type CompactLastCommit,
  type CompactOutcomeStore,
} from "../src/core/compact-controller.js";
import { fileCompactOutcomeStore } from "../src/core/compact-outcome-store.js";
import { CompactProvider } from "../src/providers/compact-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

interface UsageStep {
  tokens: number;
  contextWindow: number;
  percent: number;
}

interface HostOptions {
  usage?: UsageStep[];
  sessionId?: string;
  contextWindow?: number;
  compact?: () => Promise<void>;
}

const host = (options: HostOptions = {}): ExtensionContext => {
  const steps = options.usage ? [...options.usage] : undefined;
  let index = 0;
  return {
    getContextUsage() {
      if (!steps) return undefined;
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return step;
    },
    model: {
      provider: "sub2api-claude",
      id: "claude-opus-5",
      ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-under-test",
    },
    compact: options.compact ?? (async () => undefined),
  } as unknown as ExtensionContext;
};

const memoryStore = (): CompactOutcomeStore & { rows: Map<string, CompactLastCommit> } => {
  const rows = new Map<string, CompactLastCommit>();
  return {
    rows,
    load: (sessionId) => rows.get(sessionId),
    save: (sessionId, outcome) => void rows.set(sessionId, { ...outcome, persisted: true }),
  };
};

const settings = () => ({ engine: "lcm", targetContextRatio: 0.75 });

const invocation = (extensionContext: ExtensionContext): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "outer",
  nestedToolCallId: "inner",
  extensionContext,
  update() {},
  activity() {},
});

describe("compact.status occupancy visibility", () => {
  it("reports the context window, live occupancy, engine, target ratio and model", () => {
    const controller = new CompactController({}, { settings });
    const status = controller.status(host({
      usage: [{ tokens: 96_000, contextWindow: 200_000, percent: 48 }],
      contextWindow: 200_000,
    }));
    expect(status.context).toEqual({
      known: true,
      tokens: 96_000,
      contextWindow: 200_000,
      percent: 48,
      remainingTokens: 104_000,
    });
    expect(status.engine).toBe("lcm");
    expect(status.targetContextRatio).toBe(0.75);
    expect(status.model).toBe("sub2api-claude/claude-opus-5");
    expect(status.sessionId).toBe("session-under-test");
  });

  it("represents unmeasured usage as known:false with null tokens, never zero", () => {
    const controller = new CompactController({}, { settings });
    const status = controller.status(host({ contextWindow: 200_000 }));
    expect(status.context?.known).toBe(false);
    expect(status.context?.tokens).toBeNull();
    expect(status.context?.percent).toBeNull();
    expect(status.context?.remainingTokens).toBeNull();
    expect(status.context?.tokens).not.toBe(0);
    expect(status.context?.percent).not.toBe(0);
    expect(status.context?.contextWindow).toBe(200_000);
  });

  it("derives percent from tokens when the host reports the window but no percent", () => {
    const controller = new CompactController();
    const status = controller.status(host({
      usage: [{ tokens: 50_000, contextWindow: 200_000 } as UsageStep],
    }));
    expect(status.context?.percent).toBe(25);
    expect(status.context?.known).toBe(true);
  });

  it("survives a host that throws from getContextUsage", () => {
    const controller = new CompactController();
    const broken = {
      getContextUsage() {
        throw new Error("no session");
      },
    } as unknown as ExtensionContext;
    expect(controller.status(broken).context).toEqual({
      known: false,
      tokens: null,
      contextWindow: null,
      percent: null,
      remainingTokens: null,
    });
  });

  it("keeps the pending/last shape callers already rely on", () => {
    const controller = new CompactController();
    const intent = controller.request({ reason: "nearly full" });
    expect(controller.status().pending).toEqual(intent);
    expect(controller.status().last).toBeUndefined();
  });
});

describe("compact request outcome observability", () => {
  it("records tokens before/after and settles as committed when context shrank", async () => {
    const store = memoryStore();
    const controller = new CompactController({}, { settings, outcomes: store });
    const context = host({
      usage: [
        { tokens: 180_000, contextWindow: 200_000, percent: 90 },
        { tokens: 42_000, contextWindow: 200_000, percent: 21 },
      ],
    });
    controller.request({ reason: "nearly full" });
    await controller.maybeCommit(context);
    expect(controller.status(context).last).toMatchObject({
      status: "committed",
      tokensBefore: 180_000,
      estimatedTokensAfter: 42_000,
    });
  });

  it("settles as skipped when the compaction freed nothing, instead of silently dropping it", async () => {
    const store = memoryStore();
    const controller = new CompactController({}, { settings, outcomes: store });
    const context = host({
      usage: [{ tokens: 12_000, contextWindow: 200_000, percent: 6 }],
    });
    controller.request({ reason: "too little to compact" });
    await controller.maybeCommit(context);
    const last = controller.status(context).last;
    expect(last?.status).toBe("skipped");
    expect(last?.tokensBefore).toBe(12_000);
    expect(last?.estimatedTokensAfter).toBe(12_000);
    expect(last?.error).toMatch(/freed no context tokens/);
  });

  it("makes a settled outcome readable by a later controller over the same session", async () => {
    const store = memoryStore();
    const context = host({ usage: [{ tokens: 12_000, contextWindow: 200_000, percent: 6 }] });
    const first = new CompactController({}, { settings, outcomes: store });
    first.request({ reason: "ask" });
    await first.maybeCommit(context);

    const later = new CompactController({}, { settings, outcomes: store });
    const last = later.status(context).last;
    expect(last?.status).toBe("skipped");
    expect(last?.persisted).toBe(true);
    expect(later.status(context).pending).toBeUndefined();
  });

  it("does not read another session's outcome", async () => {
    const store = memoryStore();
    const first = new CompactController({}, { outcomes: store });
    first.request({ reason: "ask" });
    await first.maybeCommit(host({
      usage: [{ tokens: 9_000, contextWindow: 200_000, percent: 4 }],
      sessionId: "session-a",
    }));
    const later = new CompactController({}, { outcomes: store });
    expect(later.status(host({ sessionId: "session-b" })).last).toBeUndefined();
  });

  it("records tokensBefore on a failed commit so the guest sees the attempt", async () => {
    const store = memoryStore();
    const controller = new CompactController({}, { outcomes: store });
    const context = host({
      usage: [{ tokens: 150_000, contextWindow: 200_000, percent: 75 }],
      compact: async () => {
        throw new Error("API quota exceeded");
      },
    });
    controller.request({ reason: "ask" });
    await controller.maybeCommit(context);
    expect(controller.status(context).last).toMatchObject({
      status: "failed",
      error: "API quota exceeded",
      tokensBefore: 150_000,
    });
  });
});

describe("fileCompactOutcomeStore", () => {
  const roots: string[] = [];
  const root = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "compact-outcome-"));
    roots.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a settled outcome across controller instances", async () => {
    const dir = root();
    const store = fileCompactOutcomeStore(() => dir);
    const context = host({
      usage: [
        { tokens: 180_000, contextWindow: 200_000, percent: 90 },
        { tokens: 40_000, contextWindow: 200_000, percent: 20 },
      ],
      sessionId: "abc-123",
    });
    const first = new CompactController({}, { outcomes: store });
    first.request({ reason: "ask" });
    await first.maybeCommit(context);

    const later = new CompactController({}, { outcomes: store });
    expect(later.status(context).last).toMatchObject({
      status: "committed",
      tokensBefore: 180_000,
      estimatedTokensAfter: 40_000,
      persisted: true,
    });
  });

  it("returns undefined for an unknown session and rejects unusable session ids", () => {
    const store = fileCompactOutcomeStore(root);
    expect(store.load("never-written")).toBeUndefined();
    expect(store.load("../../escape")).toBeUndefined();
  });
});

describe("CompactProvider status surface", () => {
  it("returns occupancy, engine and the settled outcome through compact.status", async () => {
    const store = memoryStore();
    const controller = new CompactController({}, { settings, outcomes: store });
    const provider = new CompactProvider(controller);
    const context = host({
      usage: [
        { tokens: 170_000, contextWindow: 200_000, percent: 85 },
        { tokens: 170_000, contextWindow: 200_000, percent: 85 },
        { tokens: 30_000, contextWindow: 200_000, percent: 15 },
      ],
    });
    const before = (await provider.invoke("status", {}, invocation(context))) as {
      context?: { known: boolean; percent: number | null };
      engine?: string;
      targetContextRatio?: number;
    };
    expect(before.context?.known).toBe(true);
    expect(before.context?.percent).toBe(85);
    expect(before.engine).toBe("lcm");
    expect(before.targetContextRatio).toBe(0.75);

    await provider.invoke("request", { reason: "over target" }, invocation(context));
    await controller.maybeCommit(context);
    const after = (await provider.invoke("status", {}, invocation(context))) as {
      last?: { status: string; tokensBefore?: number; estimatedTokensAfter?: number };
    };
    expect(after.last?.status).toBe("committed");
    expect(after.last?.tokensBefore).toBe(170_000);
    expect(after.last?.estimatedTokensAfter).toBe(30_000);
  });

  it("reports unknown occupancy without a settings source rather than fabricating numbers", async () => {
    const provider = new CompactProvider(new CompactController());
    const result = (await provider.invoke("status", {}, invocation({} as ExtensionContext))) as {
      context?: { known: boolean; tokens: number | null };
      engine?: string;
    };
    expect(result.context).toEqual({
      known: false,
      tokens: null,
      contextWindow: null,
      percent: null,
      remainingTokens: null,
    });
    expect(result.engine).toBeUndefined();
  });
});
