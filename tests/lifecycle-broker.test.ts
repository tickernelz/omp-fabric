import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import {
  FABRIC_PARTICIPANT_LIFECYCLE_TOPIC,
  type FabricLifecycleEvent,
  type FabricLifecycleSubscription,
} from "../src/lifecycle/types.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type {
  FabricParticipantInfo,
  FabricParticipantSource,
} from "../src/topology/types.js";

const roots: string[] = [];
const brokers: LifecycleBroker[] = [];

const targetIdentity: MeshIdentity = {
  id: "session:target",
  name: "main",
  kind: "main",
  sessionId: "target",
};

const sourceIdentity: MeshIdentity = {
  id: "session:source",
  name: "Peer source",
  kind: "main",
  sessionId: "source",
};

const participant = (
  identity: MeshIdentity,
  local: boolean,
): FabricParticipantInfo => ({
  format: 1,
  id: identity.id,
  kind: identity.kind === "main" ? "root" : identity.kind,
  rootId: identity.id,
  ownerHostId: identity.id,
  ownerIdentityId: identity.id,
  name: identity.name,
  status: "idle",
  runner: "omp",
  transport: "host",
  capabilities: ["steer", "followUp", "fabric"],
  ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  startedAt: 1,
  updatedAt: 1,
  controlProtocol: "v1",
  local,
  stale: false,
});

const participants = (localId: string): FabricParticipantSource => {
  const records = [
    participant(targetIdentity, targetIdentity.id === localId),
    participant(sourceIdentity, sourceIdentity.id === localId),
  ];
  return {
    list: () => records,
    get: (id) => records.find((record) => record.id === id),
    self: () => records[0]!,
    peers: () => [],
    async refresh() {},
    scheduleRefresh() {},
  };
};

const source = {
  id: sourceIdentity.id,
  name: sourceIdentity.name,
  kind: "root" as const,
  rootId: sourceIdentity.id,
  runner: "omp" as const,
  ownerHostId: sourceIdentity.id,
  ownerIdentityId: sourceIdentity.id,
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LifecycleBroker", () => {
  it("delivers only new matching source events and removes one-shot subscriptions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-lifecycle-"));
    roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const directory = participants(targetIdentity.id);
    const deliveries: Array<{
      subscription: FabricLifecycleSubscription;
      event: FabricLifecycleEvent;
    }> = [];
    const target = new LifecycleBroker(
      mesh,
      targetIdentity,
      directory,
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      (subscription, event) => {
        deliveries.push({ subscription, event });
      },
    );
    const publisher = new LifecycleBroker(
      mesh,
      sourceIdentity,
      participants(sourceIdentity.id),
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      () => {},
    );
    brokers.push(target, publisher);

    await mesh.publish({
      topic: FABRIC_PARTICIPANT_LIFECYCLE_TOPIC,
      kind: "omp.agent_end",
      from: sourceIdentity,
      data: {
        version: 1,
        event: "omp.agent_end",
        source,
        occurredAt: 1,
      },
    });
    const subscription = await target.subscribe({
      from: source.id,
      events: ["omp.agent_end"],
      to: targetIdentity.id,
      delivery: "followUp",
      triggerTurn: false,
      once: true,
    });
    target.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deliveries).toEqual([]);

    await publisher.publish({ source, event: "omp.turn_end", data: { turnIndex: 1 } });
    await publisher.publish({
      source: { ...source, ownerHostId: "host:forged" },
      event: "omp.agent_end",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deliveries).toEqual([]);

    await publisher.publish({
      source,
      event: "omp.agent_end",
      occurredAt: 42,
      data: { privateTranscript: undefined, idle: true },
    });
    await waitFor(() => deliveries.length === 1);

    expect(deliveries[0]).toMatchObject({
      subscription: {
        id: subscription.id,
        from: source.id,
        to: targetIdentity.id,
        triggerTurn: false,
      },
      event: {
        event: "omp.agent_end",
        source: { id: source.id, kind: "root" },
        occurredAt: 42,
        data: { idle: true },
      },
    });
    await waitFor(() => target.list().length === 0);
  });

  it("delivers attributed component state transitions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-lifecycle-"));
    roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const deliveries: FabricLifecycleEvent[] = [];
    const target = new LifecycleBroker(
      mesh,
      targetIdentity,
      participants(targetIdentity.id),
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      (_subscription, event) => { deliveries.push(event); },
    );
    const publisher = new LifecycleBroker(
      mesh,
      sourceIdentity,
      participants(sourceIdentity.id),
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      () => {},
    );
    brokers.push(target, publisher);
    await target.subscribe({
      from: source.id,
      events: ["component.state"],
      to: targetIdentity.id,
      delivery: "followUp",
      triggerTurn: false,
    });
    target.start();
    await publisher.publish({
      source,
      event: "component.state",
      data: { id: "indexer", state: "active", revision: 2 },
    });
    await waitFor(() => deliveries.length === 1);
    expect(deliveries[0]).toMatchObject({
      event: "component.state",
      data: { id: "indexer", state: "active", revision: 2 },
    });
  });

  it("persists cursors across broker restarts without redelivering old events", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-lifecycle-"));
    roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const directory = participants(targetIdentity.id);
    const delivered: string[] = [];
    const publisher = new LifecycleBroker(
      mesh,
      sourceIdentity,
      participants(sourceIdentity.id),
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      () => {},
    );
    const first = new LifecycleBroker(
      mesh,
      targetIdentity,
      directory,
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      (_subscription, event) => {
        delivered.push(event.id);
      },
    );
    brokers.push(publisher, first);
    const subscription = await first.subscribe({
      from: source.id,
      events: ["omp.agent_end"],
      to: targetIdentity.id,
      delivery: "followUp",
      triggerTurn: true,
    });
    first.start();
    await publisher.publish({ source, event: "omp.agent_end" });
    await waitFor(() => delivered.length === 1);
    await first.close();

    const replacement = new LifecycleBroker(
      mesh,
      targetIdentity,
      directory,
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      (_record, event) => {
        delivered.push(event.id);
      },
    );
    brokers.push(replacement);
    replacement.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(delivered).toHaveLength(1);

    await publisher.publish({ source, event: "omp.agent_end" });
    await waitFor(() => delivered.length === 2);
    await expect(replacement.unsubscribe(subscription.id)).resolves.toEqual({ removed: true });
  });
});
