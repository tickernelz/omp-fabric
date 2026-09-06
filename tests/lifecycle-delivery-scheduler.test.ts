import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LifecycleDeliveryScheduler,
  type PendingLifecycleDelivery,
} from "../src/lifecycle/delivery-scheduler.js";
import type {
  FabricLifecycleEvent,
  FabricLifecycleSubscription,
} from "../src/lifecycle/types.js";

const subscription = (
  overrides: Partial<FabricLifecycleSubscription> = {},
): FabricLifecycleSubscription => ({
  format: 1,
  id: "sub-1",
  from: "agent-1",
  events: ["run.completed"],
  to: "session:main",
  delivery: "followUp",
  triggerTurn: true,
  once: false,
  afterSequence: 0,
  createdAt: 1,
  updatedAt: 1,
  createdBy: { id: "agent-1", name: "agent", kind: "agent" },
  ...overrides,
});

const event = (id: string): FabricLifecycleEvent => ({
  version: 1,
  id,
  sequence: 1,
  event: "run.completed",
  source: {
    id: "agent-1",
    name: "agent",
    kind: "agent",
    rootId: "session:main",
    runner: "omp",
  },
  occurredAt: 1,
  publishedAt: 2,
});

const delivery = (id: string, overrides: Partial<FabricLifecycleSubscription> = {}): PendingLifecycleDelivery =>
  ({ subscription: subscription(overrides), event: event(id) });

const tick = async (ms = 10): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LifecycleDeliveryScheduler", () => {
  it("coalesces buffered deliveries for the same target into one dispatch", async () => {
    const batches: Array<[string, PendingLifecycleDelivery[]]> = [];
    const scheduler = new LifecycleDeliveryScheduler(20, async (target, batch) => {
      batches.push([target, batch]);
    });
    scheduler.schedule("main", delivery("e1"));
    scheduler.schedule("main", delivery("e2"));
    scheduler.schedule("main", delivery("e3"));
    await scheduler.flushAll();
    expect(batches).toEqual([["main", [delivery("e1"), delivery("e2"), delivery("e3")]]]);
  });

  it("keeps targets independent and dispatches after the coalescing window", async () => {
    const batches: string[] = [];
    const scheduler = new LifecycleDeliveryScheduler(20, async (target) => {
      batches.push(target);
    });
    scheduler.schedule("main", delivery("e1"));
    scheduler.schedule("peer", delivery("e2"));
    await tick(80);
    expect(batches.sort()).toEqual(["main", "peer"]);
  });

  it("dispatches steer deliveries immediately without buffering", async () => {
    const batches: Array<[string, PendingLifecycleDelivery[]]> = [];
    const scheduler = new LifecycleDeliveryScheduler(60_000, async (target, batch) => {
      batches.push([target, batch]);
    });
    scheduler.schedule("main", delivery("e1", { delivery: "steer" }));
    await tick();
    expect(batches).toEqual([["main", [delivery("e1", { delivery: "steer" })]]]);
    await scheduler.dispose();
  });

  it("serializes dispatches per target without losing batches", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new LifecycleDeliveryScheduler(0, async (target, batch) => {
      order.push(`${target}:${batch.map((entry) => entry.event.id).join(",")}`);
      await gate;
    });
    scheduler.schedule("main", delivery("e1"));
    await tick();
    scheduler.schedule("main", delivery("e2"));
    await tick();
    release?.();
    await scheduler.flushAll();
    expect(order).toEqual(["main:e1", "main:e2"]);
  });

  it("reports dispatch failures through onError instead of throwing", async () => {
    const errors: string[] = [];
    const scheduler = new LifecycleDeliveryScheduler(
      0,
      async () => {
        throw new Error("route failed");
      },
      (target, batch, error) => {
        errors.push(`${target}:${batch.length}:${(error as Error).message}`);
      },
    );
    scheduler.schedule("main", delivery("e1"));
    await scheduler.flushAll();
    expect(errors).toEqual(["main:1:route failed"]);
  });

  it("drops buffered deliveries after dispose", async () => {
    const batches: string[] = [];
    const scheduler = new LifecycleDeliveryScheduler(60_000, async (target) => {
      batches.push(target);
    });
    scheduler.schedule("main", delivery("e1"));
    await scheduler.dispose();
    scheduler.schedule("main", delivery("e2"));
    await tick();
    expect(batches).toEqual([]);
  });
});
