import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";
import { decodeCompactionInstructions, FABRIC_COMPACTION_REQUEST_PREFIX } from "../src/compaction/instructions.js";
import {
  CompactController,
  type CompactLastCommit,
  type CompactPendingIntent,
} from "../src/core/compact-controller.js";

interface CapturedCompact {
  customInstructions?: string;
  onComplete: () => void;
  onError: (error: Error) => void;
}

interface CompactCapture {
  current: CapturedCompact | undefined;
}

const fakeContext = (capture: CompactCapture, _idle = true): ExtensionContext =>
  ({
    compact(instructions?: string) {
      return new Promise<void>((resolve, reject) => {
        capture.current = {
          ...(instructions ? { customInstructions: instructions } : {}),
          onComplete: resolve,
          onError: reject,
        };
      });
    },
  }) as unknown as ExtensionContext;

const committed = (..._args: unknown[]): void => undefined;

describe("CompactController", () => {
  it("records a pending intent and reports it via status", () => {
    const controller = new CompactController();
    const intent = controller.request({
      reason: "context nearly full",
      instructions: "Keep the file map",
      requestedBy: "model",
    });
    expect(intent.requestedBy).toBe("model");
    expect(intent.reason).toBe("context nearly full");
    expect(intent.instructions).toBe("Keep the file map");
    const status = controller.status();
    expect(status.pending).toEqual(intent);
    expect(status.last).toBeUndefined();
  });

  it("defaults requestedBy to model and omits empty fields", () => {
    const controller = new CompactController();
    const intent = controller.request({});
    expect(intent.requestedBy).toBe("model");
    expect(intent.reason).toBeUndefined();
    expect(intent.instructions).toBeUndefined();
  });

  it("a new request replaces the pending one, keeping latest instructions", () => {
    const controller = new CompactController();
    controller.request({ reason: "first", instructions: "A" });
    controller.request({ reason: "second", instructions: "B" });
    const pending = controller.status().pending;
    expect(pending?.reason).toBe("second");
    expect(pending?.instructions).toBe("B");
  });

  it("cancel clears the pending intent without touching last-commit", () => {
    const controller = new CompactController();
    controller.request({ reason: "x" });
    controller.cancel();
    expect(controller.status().pending).toBeUndefined();
  });

  it("maybeCommit is a no-op when no intent is pending", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeUndefined();
  });

  it("maybeCommit is a no-op while a commit is already in flight", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "first" });
    const firstCommit = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
    const first = capture.current!;
    capture.current = undefined;
    // A second intent arrives while the first commit is still in flight.
    controller.request({ reason: "second" });
    const reentrant = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeUndefined();
    // Completing the first commit clears in-flight; the second intent is still
    // pending and can now be committed at a later boundary.
    first.onComplete();
    await Promise.all([firstCommit, reentrant]);
    expect(controller.status().last?.status).toBe("committed");
    expect(controller.status().pending?.reason).toBe("second");
    void controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
  });

  it("commits at a settled boundary: clears intent and records last-commit info", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ instructions: "Keep the test plan" });
    const commit = controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions).toBe("Keep the test plan");
    capture.current!.onComplete();
    await commit;
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "committed", requestedBy: "model" });
  });

  it("encodes typed preserve items with instructions", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ instructions: "Keep the plan", preserve: ["rare fact", "src/a.ts"] });
    expect(controller.status().pending?.preserve).toEqual(["rare fact", "src/a.ts"]);
    const commit = controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions?.startsWith(FABRIC_COMPACTION_REQUEST_PREFIX)).toBe(true);
    const decoded = decodeCompactionInstructions(capture.current?.customInstructions);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected decoded instructions");
    expect(decoded.policy.mode).toBe("typed-v1");
    expect(decoded.requestLines.join("\n")).toContain("rare fact");
    capture.current!.onError(new Error("Already compacted"));
    await commit;
  });

  it("forwards customInstructions only when provided", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "no instructions" });
    const commit = controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions).toBeUndefined();
    capture.current!.onError(new Error("Already compacted"));
    await commit;
  });

  it("records 'Compaction cancelled' as cancelled, not failed", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    const commit = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Compaction cancelled"));
    await commit;
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "cancelled", error: "Compaction cancelled" });
  });

  it("records 'Already compacted' as cancelled, not failed", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    const commit = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Already compacted"));
    await commit;
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "cancelled", error: "Already compacted" });
  });

  it("records a failure and clears intent on other errors", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    const commit = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("API quota exceeded"));
    await commit;
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "failed", error: "API quota exceeded" });
  });

  it("records a failed Promise rejection", async () => {
    const compact = vi.fn().mockRejectedValue(new Error("compact unavailable"));
    const controller = new CompactController();
    controller.request({ reason: "failed boundary" });
    await controller.maybeCommit({ compact } as unknown as ExtensionContext);
    expect(compact).toHaveBeenCalledOnce();
    expect(controller.status().pending).toBeUndefined();
    expect(controller.status().last).toMatchObject({ status: "failed", error: "compact unavailable" });
  });

  it("fires onRequest when an intent is recorded", () => {
    const requests: CompactPendingIntent[] = [];
    const controller = new CompactController({
      onRequest: (intent) => requests.push(intent),
    });
    controller.request({ reason: "a" });
    controller.request({ reason: "b" });
    expect(requests.map((r) => r.reason)).toEqual(["a", "b"]);
  });

  it("fires onCommit with committed info on success and failed info on error", async () => {
    const commits: CompactLastCommit[] = [];
    const controller = new CompactController({ onCommit: (info) => commits.push(info) });
    const capture: CompactCapture = { current: undefined };
    controller.request({ reason: "ok" });
    const first = controller.maybeCommit(fakeContext(capture));
    capture.current!.onComplete();
    await first;
    controller.request({ reason: "bad" });
    const second = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("rate limited"));
    await second;
    expect(commits.map((c) => c.status)).toEqual(["committed", "failed"]);
    expect(commits[1]?.error ?? "").toBe("rate limited");
  });

  it("fires onCommit with cancelled info for cancelled/already-compacted", async () => {
    const commits: CompactLastCommit[] = [];
    const controller = new CompactController({ onCommit: (info) => commits.push(info) });
    const capture: CompactCapture = { current: undefined };
    controller.request({ reason: "x" });
    const commit = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Compaction cancelled"));
    await commit;
    expect(commits.map((info) => info.status)).toEqual(["cancelled"]);
    expect(commits[0]?.error).toBe("Compaction cancelled");
  });

  it("resets in-flight after a failed commit so a new intent can be committed", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "first" });
    const first = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("API quota exceeded"));
    await first;
    controller.request({ reason: "second" });
    const second = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
    capture.current!.onComplete();
    await second;
    expect(controller.status().last?.status).toBe("committed");
  });

  it("keeps ExtensionRunner agent_end pending until compaction completes", async () => {
    const timeline: string[] = [];
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "event order" });
    const handler = async () => {
      timeline.push("handler:start");
      await controller.maybeCommit(fakeContext(capture));
      timeline.push("handler:end");
    };
    const runner = {
      emit: async (event: { type: string }) => {
        if (event.type === "agent_end") await handler();
      },
    } as unknown as { emit: (event: { type: string }) => Promise<void> };
    const emitted = runner.emit({ type: "agent_end" }).then(() => {
      timeline.push("public:agent_end");
    });
    await Promise.resolve();
    expect(timeline).toEqual(["handler:start"]);
    capture.current!.onComplete();
    await emitted;
    expect(timeline).toEqual([
      "handler:start",
      "handler:end",
      "public:agent_end",
    ]);
  });
});
