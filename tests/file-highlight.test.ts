import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureHighlighting,
  highlightCode,
  highlightFileLines,
  highlightSourceLines,
  initHighlighting,
} from "../src/ui/highlight.js";

const CPP = [
  "#include <memory>",
  "/**",
  " * @brief Shared queue carrying captured PCM sample buffers.",
  " * Second line of the doc comment.",
  " */",
  "using sample_queue_t = std::shared_ptr<int>;",
  "static int start_audio_control(int ctx);",
  "",
  "// filler lines to keep the excerpt away from the top of the file",
  "int a1 = 1;",
  "int a2 = 2;",
  "int a3 = 3;",
  "int a4 = 4;",
  "int a5 = 5;",
  "int a6 = 6;",
  "int a7 = 7;",
  "int a8 = 8;",
  "int a9 = 9;",
  "/**",
  " * @param config Audio stream settings.",
  " */",
  "static void stop_audio_control(int);",
].join("\n");

describe("fabric file highlight coverage", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "omp-fabric-hl-"));
    file = join(dir, "audio.cpp");
    writeFileSync(file, CPP, "utf8");
    await initHighlighting("dark-plus", true);
    // cpp is not a preloaded language; pump its lazy load before assertions.
    // The sample text must be unique per run: highlightCode's render cache
    // would otherwise serve a stale hit from a previous highlighter instance
    // and the poll would exit before cpp finishes loading on the new one.
    await vi.waitFor(
      () => expect(highlightCode(`int warm${Math.random()};`, "cpp")).not.toBeNull(),
      { timeout: 15_000 },
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null before coverage, then matches full-file tokens exactly", async () => {
    const invalidate = vi.fn();
    const slice = highlightFileLines(file, "cpp", 19, 22, invalidate);
    expect(slice).toBeNull();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });

    const covered = highlightFileLines(file, "cpp", 19, 22, invalidate);
    expect(covered).not.toBeNull();
    expect(covered).toHaveLength(3);
    // raw lines let renderers verify content alignment
    expect(covered![0]!.raw).toBe(" * @param config Audio stream settings.");

    const full = highlightCode(CPP, "cpp")!;
    for (let line = 19; line < 22; line++) {
      expect(covered![line - 19]!.ansi).toBe(full[line]!);
    }
    // The doc-comment interior must carry the same color as the `/**` opener.
    const commentOpenerColor = full[18]!.match(/\x1b\[38;2;[0-9;]+m/)?.[0];
    expect(commentOpenerColor).toBeTruthy();
    expect(covered![1]!.ansi).toContain(commentOpenerColor);
  }, 20_000);

  it("serves deep excerpts only after background coverage reaches them", async () => {
    const shallow = highlightFileLines(file, "cpp", 5, 6);
    expect(shallow).toBeNull();
    const invalidate = vi.fn();
    highlightFileLines(file, "cpp", 5, 6, invalidate);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    const covered = highlightFileLines(file, "cpp", 5, 6);
    expect(covered).not.toBeNull();
    expect(covered![0]!.raw).toBe(CPP.split("\n")[5]);
  }, 20_000);

  it("re-covers when the file changes on disk", async () => {
    const invalidate = vi.fn();
    highlightFileLines(file, "cpp", 0, 3, invalidate);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    const before = highlightFileLines(file, "cpp", 0, 3);
    expect(before).not.toBeNull();

    const changed = CPP + "\nint extra_line = 10;\n";
    writeFileSync(file, changed, "utf8");
    // Guarantee a distinct mtimeMs even on coarse filesystems.
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    const invalidateAgain = vi.fn();
    const stale = highlightFileLines(file, "cpp", 0, 3, invalidateAgain);
    expect(stale).toBeNull();
    await vi.waitFor(() => expect(invalidateAgain).toHaveBeenCalled(), { timeout: 15_000 });
    const fresh = highlightFileLines(file, "cpp", 0, 3);
    expect(fresh).not.toBeNull();
  }, 20_000);

  it("rejects ranges beyond end-of-file and oversized files", async () => {
    expect(highlightFileLines(file, "cpp", 1000, 1005)).toBeNull();

    const big = join(dir, "big.cpp");
    writeFileSync(big, "int x = 0;\n".repeat(20_000), "utf8");
    const invalidate = vi.fn();
    expect(highlightFileLines(big, "cpp", 0, 5, invalidate)).toBeNull();
    // No background work is scheduled for oversized files.
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(invalidate).not.toHaveBeenCalled();
    expect(highlightFileLines(big, "cpp", 0, 5)).toBeNull();
  });

  it("returns null when highlighting is disabled", async () => {
    configureHighlighting("dark-plus", false);
    expect(highlightFileLines(file, "cpp", 0, 1)).toBeNull();
    configureHighlighting("dark-plus", true);
    await initHighlighting("dark-plus", true);
  }, 20_000);

  it("highlightSourceLines matches whole-document tokens for an in-memory doc", async () => {
    const doc = CPP.split("\n");
    const key = `mem\u0000cpp\u0000virtual-${Math.random()}`;
    const invalidate = vi.fn();
    // Cold: coverage empty, returns null but schedules the pump.
    expect(highlightSourceLines(key, doc, "cpp", 19, 22, invalidate)).toBeNull();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });

    const covered = highlightSourceLines(key, doc, "cpp", 19, 22);
    expect(covered).not.toBeNull();
    const full = highlightCode(CPP, "cpp")!;
    for (let line = 19; line < 22; line++) {
      expect(covered![line - 19]!.ansi).toBe(full[line]!);
      expect(covered![line - 19]!.raw).toBe(doc[line]);
    }
  }, 20_000);

  it("highlightSourceLines serves repeat ranges from cache without re-pumping", async () => {
    const doc = CPP.split("\n");
    const key = `mem\u0000cpp\u0000reuse-${Math.random()}`;
    const invalidate = vi.fn();
    highlightSourceLines(key, doc, "cpp", 0, 5, invalidate);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    const first = highlightSourceLines(key, doc, "cpp", 0, 5);
    expect(first).not.toBeNull();

    // A second range within the already-covered prefix returns synchronously
    // with no further invalidate (no new background work is scheduled).
    const again = vi.fn();
    const second = highlightSourceLines(key, doc, "cpp", 2, 4, again);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(second).not.toBeNull();
    expect(again).not.toHaveBeenCalled();
    expect(second![0]!.ansi).toBe(first![2]!.ansi);
  }, 20_000);

  it("highlightSourceLines pumps incrementally without blocking the event loop", async () => {
    // A document larger than one tick's line budget forces multiple slices.
    const big: string[] = [];
    for (let index = 0; index < 400; index++) big.push(`int value_${index} = ${index};`);
    const key = `mem\u0000cpp\u0000pump-${Math.random()}`;
    const invalidate = vi.fn();
    expect(highlightSourceLines(key, big, "cpp", 0, big.length, invalidate)).toBeNull();

    // The pump yields via setImmediate; a concurrent timer must fire before
    // coverage completes, proving the event loop is not starved.
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    expect(timerFired).toBe(true);

    const covered = highlightSourceLines(key, big, "cpp", 0, big.length);
    expect(covered).not.toBeNull();
    expect(covered).toHaveLength(big.length);
  }, 20_000);
});
