import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-global-actor-"));
  roots.push(dir);
  return dir;
};

describe("global actor templates carry cwd", () => {
  it("stores, reloads and returns cwd in the request shape", () => {
    const home = scratch();
    const target = scratch();
    const registry = new GlobalActorRegistry(home, 64_000);
    const created = registry.create({
      name: "watcher",
      instructions: "watch the sibling checkout",
      cwd: target,
    } as never);
    expect((created as { cwd?: string }).cwd).toBe(target);

    const reloaded = new GlobalActorRegistry(home, 64_000);
    const listed = reloaded.list().find((a) => a.name === "watcher");
    expect(listed).toBeDefined();
    expect((listed as { cwd?: string }).cwd).toBe(target);
    expect(reloaded.toRequest(listed as never).cwd).toBe(target);
  });
});
