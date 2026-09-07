import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFabricUpdate,
  scheduleFabricUpdateCheck,
  updateCheckCachePath,
  UPDATE_CHECK_TTL_MS,
  UPDATE_STATUS_KEY,
  type FabricUpdateFetch,
  type FabricUpdateNotice,
} from "../src/update/check.js";

const roots: string[] = [];

const makeAgentDir = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-update-"));
  roots.push(root);
  return root;
};

const registryFetch = (version: string): { impl: FabricUpdateFetch; calls: string[] } => {
  const calls: string[] = [];
  const impl: FabricUpdateFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ name: "omp-fabric", version }) };
  };
  return { impl, calls };
};

const readCacheFile = (agentDir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(updateCheckCachePath(agentDir), "utf8")) as Record<string, unknown>;

const fakeContext = (overrides?: {
  hasUI?: boolean;
  setStatus?: (key: string, text: string | undefined) => void;
}): ExtensionContext =>
  ({
    hasUI: overrides?.hasUI ?? true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { setStatus: overrides?.setStatus ?? (() => {}) },
  }) as unknown as ExtensionContext;

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
  delete process.env.OMP_FABRIC_PARENT_RUN;
  delete process.env.OMP_FABRIC_ACTOR_ID;
});

describe("fabric update check", () => {
  it("announces a published version that is ahead of the installed one", async () => {
    const agentDir = makeAgentDir();
    const registry = registryFetch("1.1.0");
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(notice).toEqual<FabricUpdateNotice>({
      installed: "1.0.5",
      latest: "1.1.0",
      message: "omp-fabric 1.0.5 → 1.1.0 · omp plugin install omp-fabric",
    });
    expect(registry.calls).toEqual(["https://registry.npmjs.org/omp-fabric/latest"]);
  });

  it("stays quiet when the installed version equals the published one", async () => {
    const agentDir = makeAgentDir();
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registryFetch("1.0.5").impl,
    });
    expect(notice).toBeUndefined();
  });

  it("stays quiet when the installed version is ahead of the published one", async () => {
    const agentDir = makeAgentDir();
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.1.0",
      fetchImpl: registryFetch("1.0.5").impl,
    });
    expect(notice).toBeUndefined();
  });

  it("orders versions numerically rather than lexically", async () => {
    const ahead = await checkFabricUpdate({
      agentDir: makeAgentDir(),
      installedVersion: "1.0.10",
      fetchImpl: registryFetch("1.0.9").impl,
    });
    expect(ahead).toBeUndefined();

    const behind = await checkFabricUpdate({
      agentDir: makeAgentDir(),
      installedVersion: "1.0.9",
      fetchImpl: registryFetch("1.0.10").impl,
    });
    expect(behind?.latest).toBe("1.0.10");
  });

  it("treats a prerelease build as behind its own release", async () => {
    const notice = await checkFabricUpdate({
      agentDir: makeAgentDir(),
      installedVersion: "1.1.0-rc.1",
      fetchImpl: registryFetch("1.1.0").impl,
    });
    expect(notice?.latest).toBe("1.1.0");
  });

  it("does no second registry request inside the cache window", async () => {
    const agentDir = makeAgentDir();
    const registry = registryFetch("1.1.0");
    const start = 1_000_000;
    const first = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
      now: start,
    });
    expect(first?.latest).toBe("1.1.0");
    expect(readCacheFile(agentDir)).toMatchObject({
      checkedAt: start,
      latest: "1.1.0",
      notified: "1.1.0",
    });

    await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
      now: start + UPDATE_CHECK_TTL_MS - 1,
    });
    expect(registry.calls).toHaveLength(1);

    await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
      now: start + UPDATE_CHECK_TTL_MS,
    });
    expect(registry.calls).toHaveLength(2);
  });

  it("announces each new version once and stays quiet afterwards", async () => {
    const agentDir = makeAgentDir();
    const start = 2_000_000;
    const first = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registryFetch("1.1.0").impl,
      now: start,
    });
    expect(first?.latest).toBe("1.1.0");

    const repeat = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registryFetch("1.1.0").impl,
      now: start + UPDATE_CHECK_TTL_MS,
    });
    expect(repeat).toBeUndefined();

    const newer = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registryFetch("1.2.0").impl,
      now: start + UPDATE_CHECK_TTL_MS * 2,
    });
    expect(newer?.latest).toBe("1.2.0");
    expect(readCacheFile(agentDir)).toMatchObject({ latest: "1.2.0", notified: "1.2.0" });
  });

  it("re-announces a cached unseen version without touching the network", async () => {
    const agentDir = makeAgentDir();
    const now = 3_000_000;
    fs.mkdirSync(path.dirname(updateCheckCachePath(agentDir)), { recursive: true });
    fs.writeFileSync(
      updateCheckCachePath(agentDir),
      JSON.stringify({ format: 1, checkedAt: now, latest: "9.9.9" }),
    );
    const registry = registryFetch("1.0.5");
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
      now,
    });
    expect(notice?.latest).toBe("9.9.9");
    expect(registry.calls).toHaveLength(0);
  });

  it("stays silent when the registry rejects, errors, or answers badly", async () => {
    const installedVersion = "1.0.5";
    const offline: FabricUpdateFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    };
    const rateLimited: FabricUpdateFetch = async () => ({
      ok: false,
      json: async () => ({ version: "9.9.9" }),
    });
    const malformed: FabricUpdateFetch = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    const shapeless: FabricUpdateFetch = async () => ({ ok: true, json: async () => ({}) });

    for (const fetchImpl of [offline, rateLimited, malformed, shapeless]) {
      const agentDir = makeAgentDir();
      await expect(
        checkFabricUpdate({ agentDir, installedVersion, fetchImpl }),
      ).resolves.toBeUndefined();
      expect(fs.existsSync(updateCheckCachePath(agentDir))).toBe(false);
    }
  });

  it("aborts a hanging registry request and stays silent", async () => {
    const agentDir = makeAgentDir();
    let aborted = false;
    const hanging: FabricUpdateFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    expect(notice).toBeUndefined();
    expect(aborted).toBe(true);
  });

  it("stays silent when the cache directory cannot be written", async () => {
    const agentDir = makeAgentDir();
    fs.writeFileSync(path.join(agentDir, "fabric"), "not a directory");
    const notice = await checkFabricUpdate({
      agentDir,
      installedVersion: "1.0.5",
      fetchImpl: registryFetch("1.1.0").impl,
    });
    expect(notice?.latest).toBe("1.1.0");
    expect(fs.statSync(path.join(agentDir, "fabric")).isFile()).toBe(true);
  });
});

describe("fabric update scheduling", () => {
  it("publishes the notice as a Fabric status line", async () => {
    const setStatus = vi.fn();
    const registry = registryFetch("1.1.0");
    await scheduleFabricUpdateCheck(fakeContext({ setStatus }), {
      enabled: true,
      agentDir: makeAgentDir(),
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(setStatus).toHaveBeenCalledWith(
      UPDATE_STATUS_KEY,
      "omp-fabric 1.0.5 → 1.1.0 · omp plugin install omp-fabric",
    );
  });

  it("does nothing when the session has no UI", async () => {
    const setStatus = vi.fn();
    const registry = registryFetch("1.1.0");
    await scheduleFabricUpdateCheck(fakeContext({ hasUI: false, setStatus }), {
      enabled: true,
      agentDir: makeAgentDir(),
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(registry.calls).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does nothing inside a spawned child agent", async () => {
    process.env.OMP_FABRIC_PARENT_RUN = "run-42";
    const setStatus = vi.fn();
    const registry = registryFetch("1.1.0");
    await scheduleFabricUpdateCheck(fakeContext({ setStatus }), {
      enabled: true,
      agentDir: makeAgentDir(),
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(registry.calls).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does nothing inside an actor runtime", async () => {
    process.env.OMP_FABRIC_ACTOR_ID = "actor-7";
    const setStatus = vi.fn();
    const registry = registryFetch("1.1.0");
    await scheduleFabricUpdateCheck(fakeContext({ setStatus }), {
      enabled: true,
      agentDir: makeAgentDir(),
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(registry.calls).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does nothing when the check is disabled", async () => {
    const setStatus = vi.fn();
    const registry = registryFetch("1.1.0");
    await scheduleFabricUpdateCheck(fakeContext({ setStatus }), {
      enabled: false,
      agentDir: makeAgentDir(),
      installedVersion: "1.0.5",
      fetchImpl: registry.impl,
    });
    expect(registry.calls).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
