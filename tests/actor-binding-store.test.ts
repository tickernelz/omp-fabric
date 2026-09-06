import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorBindingStore } from "../src/actors/binding-store.js";

const roots: string[] = [];

const setup = (): { first: ActorBindingStore; second: ActorBindingStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-bindings-"));
  roots.push(root);
  return {
    first: new ActorBindingStore("session:shared", root),
    second: new ActorBindingStore("session:shared", root),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorBindingStore", () => {
  it("merges unrelated writes from stale stores under one session lock", async () => {
    const { first, second } = setup();

    await first.setModel("actor:a", "provider/model-a");
    await second.setThinking("actor:b", "high");

    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(first.get("actor:b")).toMatchObject({ thinking: "high" });
    expect(second.get("actor:a")).toMatchObject({ model: "provider/model-a" });
  });

  it("deletes a binding from the latest file instead of a stale snapshot", async () => {
    const { first, second } = setup();
    await first.setModel("actor:a", "provider/model-a");
    await first.setModel("actor:b", "provider/model-b");

    await second.delete("actor:a");

    expect(first.get("actor:a")).toBeUndefined();
    expect(first.get("actor:b")).toMatchObject({ model: "provider/model-b" });
  });
});
