import type { ExtensionContext, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FabricSpeculationStreamTap } from "../src/speculation/stream-tap.js";
import { LiteralCallScanner } from "../src/speculation/scanner.js";
import { FabricSpeculationWarmup } from "../src/speculation/warmup.js";
import type { FabricSpeculationCandidate } from "../src/speculation/types.js";

const context = {} as ExtensionContext;

const toolCallPartial = (name: string, id: string) => ({
  content: [{ type: "toolCall", name, id }],
});

const start = (name = "fabric_exec", id = "tc1"): MessageUpdateEvent => ({
  type: "message_update",
  message: {} as MessageUpdateEvent["message"],
  assistantMessageEvent: {
    type: "toolcall_start",
    contentIndex: 0,
    partial: toolCallPartial(name, id) as never,
  },
});

const delta = (text: string, name = "fabric_exec", id = "tc1"): MessageUpdateEvent => ({
  type: "message_update",
  message: {} as MessageUpdateEvent["message"],
  assistantMessageEvent: {
    type: "toolcall_delta",
    contentIndex: 0,
    delta: text,
    partial: toolCallPartial(name, id) as never,
  },
});

const end = (name = "fabric_exec", id = "tc1"): MessageUpdateEvent => ({
  type: "message_update",
  message: {} as MessageUpdateEvent["message"],
  assistantMessageEvent: {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { type: "toolCall", name, id, arguments: {} } as never,
    partial: toolCallPartial(name, id) as never,
  },
});

const streamFor = (code: string): MessageUpdateEvent[] => {
  const blob = JSON.stringify({ code });
  const chunks: MessageUpdateEvent[] = [start()];
  for (let index = 0; index < blob.length; index += 17) {
    chunks.push(delta(blob.slice(index, index + 17)));
  }
  chunks.push(end());
  return chunks;
};

const tapCollecting = (launched: { toolCallId: string; candidate: FabricSpeculationCandidate }[]) => {
  const tap = new FabricSpeculationStreamTap({
    enabled: () => true,
    maxBufferBytes: () => 1024 * 1024,
    isEligible: () => true,
    launch: (toolCallId, candidate) => {
      launched.push({ toolCallId, candidate });
    },
  });
  tap.setScannerFactory(() => new LiteralCallScanner());
  return tap;
};

describe("FabricSpeculationWarmup", () => {
  it("replays the fabric_exec stream buffered before the runtime activated", async () => {
    const launched: { toolCallId: string; candidate: FabricSpeculationCandidate }[] = [];
    let tap: FabricSpeculationStreamTap | undefined;
    let resolveActivation: (() => void) | undefined;
    const activate = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          resolveActivation = () => {
            tap = tapCollecting(launched);
            resolvePromise();
          };
        }),
    );
    const warmup = new FabricSpeculationWarmup({
      enabled: () => true,
      tap: () => tap,
      activate,
    });

    for (const event of streamFor('await omp.read("/tmp/spec-warm.ts");')) {
      warmup.handleMessageUpdate(event, context);
    }
    expect(activate).toHaveBeenCalledOnce();
    expect(launched).toEqual([]);
    expect(warmup.pending).toBeGreaterThan(0);

    resolveActivation!();
    await Promise.resolve();
    await Promise.resolve();

    expect(launched.map((entry) => entry.candidate)).toEqual([
      { ref: "omp.read", args: { path: "/tmp/spec-warm.ts" } },
    ]);
    expect(launched[0]?.toolCallId).toBe("tc1");
    expect(warmup.pending).toBe(0);
  });

  it("passes events straight through once the tap exists", () => {
    const launched: { toolCallId: string; candidate: FabricSpeculationCandidate }[] = [];
    const tap = tapCollecting(launched);
    const activate = vi.fn(async () => {});
    const warmup = new FabricSpeculationWarmup({
      enabled: () => true,
      tap: () => tap,
      activate,
    });
    for (const event of streamFor('await omp.ls("src");')) {
      warmup.handleMessageUpdate(event, context);
    }
    expect(activate).not.toHaveBeenCalled();
    expect(launched.map((entry) => entry.candidate)).toEqual([
      { ref: "omp.ls", args: { path: "src" } },
    ]);
  });

  it("never activates for another tool's stream", () => {
    const activate = vi.fn(async () => {});
    const warmup = new FabricSpeculationWarmup({
      enabled: () => true,
      tap: () => undefined,
      activate,
    });
    warmup.handleMessageUpdate(start("read", "tc9"), context);
    warmup.handleMessageUpdate(delta('{"path":"a.ts"}', "read", "tc9"), context);
    expect(activate).not.toHaveBeenCalled();
    expect(warmup.pending).toBe(0);
  });

  it("never activates while speculation is disabled", () => {
    const activate = vi.fn(async () => {});
    const warmup = new FabricSpeculationWarmup({
      enabled: () => false,
      tap: () => undefined,
      activate,
    });
    for (const event of streamFor('await omp.read("/tmp/x.ts");')) {
      warmup.handleMessageUpdate(event, context);
    }
    expect(activate).not.toHaveBeenCalled();
    expect(warmup.pending).toBe(0);
  });

  it("drops the buffer instead of growing past its cap", () => {
    const activate = vi.fn(async () => {});
    const warmup = new FabricSpeculationWarmup({
      enabled: () => true,
      tap: () => undefined,
      activate,
      maxBufferedChars: 8,
    });
    warmup.handleMessageUpdate(start(), context);
    warmup.handleMessageUpdate(delta('{"code":"await omp.read(\\"/tmp/a\\");"}'), context);
    expect(warmup.pending).toBe(0);
  });

  it("forgets buffered events at a message boundary", () => {
    const activate = vi.fn(async () => {});
    const warmup = new FabricSpeculationWarmup({
      enabled: () => true,
      tap: () => undefined,
      activate,
    });
    warmup.handleMessageUpdate(start(), context);
    expect(warmup.pending).toBe(1);
    warmup.reset();
    expect(warmup.pending).toBe(0);
  });
});
