import { describe, expect, it } from "vitest";
import {
  awaitPeerSettle,
  buildPeerCards,
  peerLabelPrefix,
  type FabricPeerCard,
} from "../src/topology/peer-settle.js";
import type { FabricPeerInfo } from "../src/topology/types.js";

const peer = (
  id: string,
  options: Partial<FabricPeerInfo> = {},
): FabricPeerInfo => ({
  id,
  name: `Peer ${id.slice(0, 8)}`,
  kind: "peer",
  status: "idle",
  runner: "omp",
  transport: "host",
  cwd: "/repo/project",
  sessionId: id,
  startedAt: 1,
  updatedAt: 1,
  pendingMessages: false,
  local: false,
  ...options,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("peerLabelPrefix", () => {
  it("derives initials from the basename words", () => {
    expect(peerLabelPrefix("/repo/pi-queue-steer")).toBe("PQS");
    expect(peerLabelPrefix("/repo/fabric")).toBe("FAB");
    expect(peerLabelPrefix("/repo/my.repo")).toBe("MR");
    expect(peerLabelPrefix(undefined)).toBe("P");
    expect(peerLabelPrefix("/repo/---")).toBe("P");
  });
});

describe("buildPeerCards", () => {
  it("sorts by creation time and falls back to the mesh name", () => {
    const cards = buildPeerCards([
      peer("session:bbb", { startedAt: 2, label: "FAB-2", model: "gpt-5.4" }),
      peer("session:aaa", { startedAt: 1, name: "Peer session" }),
    ]);
    expect(cards.map((card) => card.label)).toEqual(["Peer session", "FAB-2"]);
    expect(cards[0]).toMatchObject({ id: "session:aaa", status: "idle", pendingMessages: false });
    expect(cards[1]).toMatchObject({ label: "FAB-2", model: "gpt-5.4" });
  });

  it("keeps label-provided fields optional", () => {
    const cards: FabricPeerCard[] = buildPeerCards([peer("session:aaa", { label: "F-1" })]);
    expect(cards[0]?.model).toBeUndefined();
    expect(cards[0]?.label).toBe("F-1");
  });
});

describe("awaitPeerSettle", () => {
  it("resolves immediately when nothing matches an empty mesh", async () => {
    await expect(awaitPeerSettle({ poll: () => [], settledForMs: 10, pollMs: 5 })).resolves.toEqual({ ok: true });
  });

  it("rejects an unmatched selector", async () => {
    const result = await awaitPeerSettle({
      poll: () => [peer("session:aaa", { label: "PQS-1" })],
      selector: "PQS-9",
      settledForMs: 10,
      pollMs: 5,
    });
    expect(result).toEqual({ ok: false, error: 'No Fabric peer matches "PQS-9" on this project mesh' });
  });

  it("matches selectors by label case-insensitively and by id", async () => {
    const idle = [peer("session:aaa", { label: "PqS-1" })];
    await expect(
      awaitPeerSettle({ poll: () => idle, selector: "pqs-1", settledForMs: 10, pollMs: 5 }),
    ).resolves.toEqual({ ok: true });
    await expect(
      awaitPeerSettle({ poll: () => idle, selector: "session:aaa", settledForMs: 10, pollMs: 5 }),
    ).resolves.toEqual({ ok: true });
  });

  it("waits for a running peer to settle plus the quiet window", async () => {
    const target = peer("session:aaa", { label: "PQS-1", status: "running" });
    const updates: string[][] = [];
    const started = Date.now();
    const promise = awaitPeerSettle({
      poll: () => [target],
      settledForMs: 40,
      pollMs: 5,
      onUpdate: (progress) => updates.push(progress.waiting.map((peer) => peer.label)),
    });
    await sleep(25);
    target.status = "idle";
    await expect(promise).resolves.toEqual({ ok: true });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(updates.some((waiting) => waiting.includes("PQS-1"))).toBe(true);
    expect(updates.at(-1)).toEqual([]);
  });

  it("holds an idle-at-arm peer for one quiet window", async () => {
    const started = Date.now();
    await expect(
      awaitPeerSettle({
        poll: () => [peer("session:aaa")],
        settledForMs: 40,
        pollMs: 5,
      }),
    ).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("restarts the watch when a quiet peer starts after arming", async () => {
    const target = peer("session:aaa", { label: "PQS-1" });
    const started = Date.now();
    const promise = awaitPeerSettle({
      poll: () => [target],
      settledForMs: 40,
      pollMs: 5,
    });
    // Start before the initial quiet window closes: the settle must not fire early.
    await sleep(20);
    target.status = "running";
    await sleep(30);
    target.status = "idle";
    await expect(promise).resolves.toEqual({ ok: true });
    // 20ms quiet-idle, then ~30ms running, then 40ms settle watch.
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("treats a vanished peer as settled", async () => {
    const target = peer("session:aaa", { status: "running" });
    let live: FabricPeerInfo[] = [target];
    const started = Date.now();
    const promise = awaitPeerSettle({ poll: () => live, settledForMs: 2_000, pollMs: 5 });
    await sleep(20);
    live = [];
    await expect(promise).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves cancelled on abort and stops polling", async () => {
    const target = peer("session:aaa", { status: "running" });
    const controller = new AbortController();
    let polls = 0;
    const promise = awaitPeerSettle({
      poll: () => {
        polls += 1;
        return [target];
      },
      settledForMs: 5_000,
      pollMs: 5,
      signal: controller.signal,
    });
    await sleep(20);
    controller.abort();
    await expect(promise).resolves.toEqual({ ok: false, error: "cancelled" });
    const settledPolls = polls;
    await sleep(25);
    expect(polls).toBe(settledPolls);
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitPeerSettle({
        poll: () => [peer("session:aaa", { status: "running" })],
        settledForMs: 10,
        pollMs: 5,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ ok: false, error: "cancelled" });
  });
});
