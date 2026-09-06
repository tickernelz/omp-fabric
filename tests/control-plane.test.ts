import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MeshStore,
  type MeshIdentity,
  type MeshStoreOptions,
} from "../src/mesh/store.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";

const roots: string[] = [];
const planes: FabricControlPlane[] = [];

const identity = (id: string): MeshIdentity => ({
  id,
  name: id,
  kind: "main",
  sessionId: id,
});

const plane = (
  meshRoot: string,
  id: string,
  storeOptions: MeshStoreOptions = {},
  controlOptions: { pollMs?: number; acknowledgementTimeoutMs?: number } = {},
): FabricControlPlane => {
  const value = new FabricControlPlane(
    new MeshStore(meshRoot, 64 * 1024, 1_000, storeOptions),
    identity(id),
    {
      enabled: true,
      hostId: id,
      pollMs: 20,
      acknowledgementTimeoutMs: 1_000,
      ...controlOptions,
    },
  );
  planes.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(planes.splice(0).map((value) => value.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FabricControlPlane", () => {
  it("routes to one execution owner and returns its acknowledgement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    const bystander = plane(meshRoot, "host:bystander");
    const receive = vi.fn((command: { commandId: string }) => ({
      accepted: true,
      messageId: "local:" + command.commandId,
    }));
    const observe = vi.fn(() => ({ accepted: true }));
    sender.start(() => ({ accepted: false }));
    receiver.start(receive);
    bystander.start(observe);

    await expect(
      sender.request("host:receiver", "agent:target", "steer", {
        message: "focus",
        triggerTurn: false,
      }),
    ).resolves.toMatchObject({
      queued: true,
      routed: "mesh",
      acknowledged: true,
      messageId: expect.stringMatching(/^local:/),
    });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "agent:target",
        operation: "steer",
        message: "focus",
        triggerTurn: false,
        replyTo: "host:sender",
      }),
      expect.objectContaining({ id: "host:sender" }),
      expect.any(AbortSignal),
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it("returns an authenticated result with the caller's actor binding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    const response = { id: "message:1", text: "done" };
    const receive = vi.fn((command: { binding?: unknown }) => ({
      accepted: true,
      messageId: "message:1",
      result: response,
    }));
    sender.start(() => ({ accepted: false }));
    receiver.start(receive);

    await expect(
      sender.requestResult(
        "host:receiver",
        "actor:target",
        "ask",
        {
          message: "inspect",
          binding: { model: "provider/session-b", thinking: "high" },
        },
      ),
    ).resolves.toEqual(response);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "actor:target",
        operation: "ask",
        binding: { model: "provider/session-b", thinking: "high" },
        deadlineAt: expect.any(Number),
      }),
      expect.objectContaining({ id: "host:sender" }),
      expect.any(AbortSignal),
    );
  });
  it("ignores an acknowledgement forged by a different mesh identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    sender.start(() => ({ accepted: false }));
    receiver.start(async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { accepted: true, messageId: "real:" + command.commandId };
    });

    const request = sender.request("host:receiver", "agent:target", "steer", {
      message: "focus",
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const command = store.read({ topic: "fabric.control.command", limit: 1 })[0];
    const commandId = (command?.data as { commandId?: string } | undefined)?.commandId;
    expect(commandId).toBeTypeOf("string");
    await store.publish({
      topic: "fabric.control.ack",
      kind: "accepted",
      from: identity("host:bystander"),
      to: "host:sender",
      data: {
        version: 1,
        commandId,
        targetId: "agent:target",
        accepted: true,
        messageId: "forged",
      },
    });

    await expect(request).resolves.toMatchObject({
      acknowledged: true,
      messageId: expect.stringMatching(/^real:/),
    });
  });

  it("recovers an unexpired command published before owner startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    await store.publish({
      topic: "fabric.control.command",
      kind: "steer",
      from: identity("host:sender"),
      to: "host:receiver",
      data: {
        version: 1,
        commandId: "command:before-start",
        targetId: "agent:target",
        operation: "steer",
        replyTo: "host:sender",
        message: "recover",
        requestedAt: Date.now(),
      },
    });
    const receiver = plane(meshRoot, "host:receiver");
    const receive = vi.fn(() => ({ accepted: true, messageId: "recovered" }));
    receiver.start(receive);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(receive).toHaveBeenCalledTimes(1);
    expect(store.read({ topic: "fabric.control.ack", limit: 10 })).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          commandId: "command:before-start",
          accepted: true,
        }),
      }),
    );
  });

  it("rejects an interrupted durable claim as indeterminate after restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const commandId = "command:interrupted";
    await store.publish({
      topic: "fabric.control.command",
      kind: "steer",
      from: identity("host:sender"),
      to: "host:receiver",
      data: {
        version: 1,
        commandId,
        targetId: "agent:target",
        operation: "steer",
        replyTo: "host:sender",
        message: "unknown outcome",
        requestedAt: Date.now(),
      },
    });
    const seenKey =
      "topology/control-seen/" +
      createHash("sha256").update(`host:receiver\0${commandId}`).digest("hex");
    await store.put({
      key: seenKey,
      value: {
        format: 1,
        hostId: "host:receiver",
        commandId,
        targetId: "agent:target",
        expiresAt: Date.now() + 1_000,
      },
      identity: identity("host:receiver"),
      ifVersion: 0,
    });
    const receiver = plane(meshRoot, "host:receiver");
    const receive = vi.fn(() => ({ accepted: true }));
    receiver.start(receive);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(receive).not.toHaveBeenCalled();
    expect(store.read({ topic: "fabric.control.ack", limit: 10 })).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          commandId,
          accepted: false,
          error: "Fabric control outcome is indeterminate after owner restart",
        }),
      }),
    );
  });

  it("does not re-execute a command republished after owner restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const firstOwner = plane(meshRoot, "host:receiver");
    const firstHandler = vi.fn((command: { commandId: string }) => ({
      accepted: true,
      messageId: command.commandId,
    }));
    sender.start(() => ({ accepted: false }));
    firstOwner.start(firstHandler);
    await sender.request("host:receiver", "agent:target", "steer", { message: "once" });
    expect(firstHandler).toHaveBeenCalledTimes(1);
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const original = store.read({ topic: "fabric.control.command", limit: 10 })[0];
    expect(original).toBeDefined();
    await firstOwner.close();

    const restartedOwner = plane(meshRoot, "host:receiver");
    const restartedHandler = vi.fn(() => ({ accepted: true }));
    restartedOwner.start(restartedHandler);
    await store.publish({
      topic: "fabric.control.command",
      kind: original!.kind,
      from: original!.from,
      ...(original!.to ? { to: original!.to } : {}),
      ...(original!.data === undefined ? {} : { data: original!.data }),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(restartedHandler).not.toHaveBeenCalled();
    expect(store.read({ topic: "fabric.control.ack", limit: 10 }).length).toBeGreaterThan(1);
  });

  it("rejects a replay outside the acknowledgement lifetime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const receiver = plane(meshRoot, "host:receiver");
    const receive = vi.fn(() => ({ accepted: true }));
    receiver.start(receive);
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    await store.publish({
      topic: "fabric.control.command",
      kind: "steer",
      from: identity("host:sender"),
      to: "host:receiver",
      data: {
        version: 1,
        commandId: "command:replayed",
        targetId: "agent:target",
        operation: "steer",
        replyTo: "host:sender",
        message: "stale",
        requestedAt: Date.now() - 5_000,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(receive).not.toHaveBeenCalled();
    expect(store.read({ topic: "fabric.control.ack", limit: 10 })).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          commandId: "command:replayed",
          accepted: false,
          error: "Fabric control command expired",
        }),
      }),
    );
  });

  it("final-drains a command published immediately before close", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const receiver = plane(meshRoot, "host:receiver");
    const receive = vi.fn(() => ({ accepted: true, messageId: "drained" }));
    receiver.start(receive);
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    await store.publish({
      topic: "fabric.control.command",
      kind: "steer",
      from: identity("host:sender"),
      to: "host:receiver",
      data: {
        version: 1,
        commandId: "command:before-close",
        targetId: "agent:target",
        operation: "steer",
        replyTo: "host:sender",
        message: "finish",
        requestedAt: Date.now(),
      },
    });

    await receiver.close();

    expect(receive).toHaveBeenCalledTimes(1);
    expect(store.read({ topic: "fabric.control.ack", limit: 10 })).toContainEqual(
      expect.objectContaining({
        to: "host:sender",
        data: expect.objectContaining({
          commandId: "command:before-close",
          accepted: true,
        }),
      }),
    );
  });

  it("does not re-execute a retained command after event-log compaction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const storeOptions: MeshStoreOptions = {
      maxEventLogBytes: 80_000,
      retainedEventLogBytes: 75_000,
    };
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000, storeOptions);
    for (let index = 0; index < 8; index++) {
      await store.publish({
        topic: "prefill",
        from: identity("host:prefill"),
        text: "p".repeat(900),
      });
    }
    const sender = plane(meshRoot, "host:sender", storeOptions);
    const receiver = plane(meshRoot, "host:receiver", storeOptions);
    const receive = vi.fn((command: { commandId: string }) => ({
      accepted: true,
      messageId: command.commandId,
    }));
    sender.start(() => ({ accepted: false }));
    receiver.start(receive);

    await sender.request("host:receiver", "agent:target", "steer", { message: "once" });
    expect(receive).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 62; index++) {
      await store.publish({
        topic: "compact",
        from: identity("host:publisher"),
        text: "x".repeat(900),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("keeps control traffic responsive while an ask is running and cancels the owner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    const controller = new AbortController();
    let askStarted = false;
    let askAborted = false;
    receiver.start((command, _from, signal) => {
      if (command.operation !== "ask") {
        return { accepted: true, messageId: `accepted:${command.operation}` };
      }
      askStarted = true;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          askAborted = true;
          resolve({ accepted: false, error: "actor request cancelled" });
        }, { once: true });
      });
    });
    sender.start(() => ({ accepted: false }));

    const ask = sender.requestResult(
      "host:receiver",
      "actor:target",
      "ask",
      { message: "inspect" },
      "host:receiver",
      { timeoutMs: 2_000, signal: controller.signal },
    );
    await vi.waitFor(() => expect(askStarted).toBe(true));
    await expect(
      sender.request("host:receiver", "actor:target", "stop"),
    ).resolves.toMatchObject({ acknowledged: true });

    controller.abort();
    await expect(ask).rejects.toThrow("Remote Fabric request cancelled");
    await vi.waitFor(() => expect(askAborted).toBe(true));
  });

  it("publishes an immediately cancelled command before its cancellation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    const publish = sender.mesh.publish.bind(sender.mesh);
    vi.spyOn(sender.mesh, "publish").mockImplementation(async (input) => {
      if (input.topic === "fabric.control.command" && input.kind === "ask") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return publish(input);
    });
    let ownerAborted = false;
    receiver.start((command, _from, signal) => {
      if (command.operation !== "ask") return { accepted: true };
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          ownerAborted = true;
          resolve({ accepted: false, error: "cancelled" });
        }, { once: true });
      });
    });
    sender.start(() => ({ accepted: false }));
    const controller = new AbortController();

    const request = sender.requestResult(
      "host:receiver",
      "actor:target",
      "ask",
      { message: "inspect" },
      "host:receiver",
      { timeoutMs: 1_000, signal: controller.signal },
    );
    controller.abort();

    await expect(request).rejects.toThrow("Remote Fabric request cancelled");
    await vi.waitFor(() => expect(ownerAborted).toBe(true));
    const kinds = new MeshStore(meshRoot, 64 * 1024, 1_000)
      .tail(0, 10)
      .events.filter((event) => event.topic === "fabric.control.command")
      .map((event) => event.kind);
    expect(kinds.indexOf("ask")).toBeLessThan(kinds.indexOf("cancel"));
  });

  it("retains a completed ask outcome through its request deadline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(
      meshRoot,
      "host:receiver",
      {},
      { pollMs: 20, acknowledgementTimeoutMs: 80 },
    );
    const receive = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { accepted: true, result: { id: "message:1", text: "done" } };
    });
    receiver.start(receive);
    sender.start(() => ({ accepted: false }));

    await expect(
      sender.requestResult(
        "host:receiver",
        "actor:target",
        "ask",
        { message: "inspect" },
        "host:receiver",
        { timeoutMs: 500 },
      ),
    ).resolves.toMatchObject({ text: "done" });
    const store = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const original = store.read({ topic: "fabric.control.command", limit: 10 })
      .find((event) => event.kind === "ask");
    expect(original).toBeDefined();
    await store.publish({
      topic: "fabric.control.command",
      kind: original!.kind,
      from: original!.from,
      ...(original!.to ? { to: original!.to } : {}),
      ...(original!.data === undefined ? {} : { data: original!.data }),
    });
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("surfaces owner rejection instead of reporting an unverified queue", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-control-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const sender = plane(meshRoot, "host:sender");
    const receiver = plane(meshRoot, "host:receiver");
    sender.start(() => ({ accepted: false }));
    receiver.start(() => ({ accepted: false, error: "target already settled" }));

    await expect(
      sender.request("host:receiver", "agent:missing", "stop"),
    ).rejects.toThrow("target already settled");
  });
});
