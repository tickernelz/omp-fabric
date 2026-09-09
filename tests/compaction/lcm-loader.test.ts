import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createLcmRuntimeLoader, LCM_SQLITE_NOTICE, type LcmRuntimeConstructor } from "../../src/compaction/lcm-loader.js";

const makeContext = (notify: (text: string, level: string) => void, hasUI = true) => ({
  hasUI,
  ui: { notify },
} as unknown as ExtensionContext);

describe("LCM runtime loader", () => {
  it("keeps the extension usable when the runtime module cannot resolve", async () => {
    const notify = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const importRuntime = vi.fn(async () => {
      throw new Error('Could not resolve: "node:sqlite"');
    });
    const loader = createLcmRuntimeLoader(importRuntime as unknown as () => Promise<{ LcmRuntime: LcmRuntimeConstructor }>);

    expect(await loader.load(makeContext(notify))).toBeUndefined();
    expect(loader.unavailable).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain(LCM_SQLITE_NOTICE);
    expect(notify.mock.calls[0]?.[0]).toContain('Could not resolve: "node:sqlite"');
    expect(notify.mock.calls[0]?.[1]).toBe("warning");

    expect(await loader.load(makeContext(notify))).toBeUndefined();
    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("stays silent on a headless host and still reports unavailability", async () => {
    const notify = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = createLcmRuntimeLoader((async () => {
      throw new Error("boom");
    }) as unknown as () => Promise<{ LcmRuntime: LcmRuntimeConstructor }>);

    await loader.load(makeContext(notify, false));
    expect(notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loader.unavailable).toBe(true);
    warn.mockRestore();
  });

  it("disables LCM when the runtime provides no SQLite driver", async () => {
    const notify = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const importRuntime = vi.fn(async () => ({ LcmRuntime: class {} as unknown as LcmRuntimeConstructor }));
    const loader = createLcmRuntimeLoader(importRuntime, async () => {
      throw new Error("no SQLite driver: this runtime provides neither node:sqlite nor bun:sqlite");
    });

    expect(await loader.load(makeContext(notify))).toBeUndefined();
    expect(importRuntime).not.toHaveBeenCalled();
    expect(loader.unavailable).toBe(true);
    expect(notify.mock.calls[0]?.[0]).toContain("neither node:sqlite nor bun:sqlite");
    warn.mockRestore();
  });

  it("returns the runtime constructor when the module resolves", async () => {
    class FakeRuntime {}
    const loader = createLcmRuntimeLoader(async () => ({ LcmRuntime: FakeRuntime as unknown as LcmRuntimeConstructor }));
    expect(await loader.load(makeContext(vi.fn()))).toBe(FakeRuntime);
    expect(loader.unavailable).toBe(false);
  });
});
