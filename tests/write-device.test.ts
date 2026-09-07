import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPreviewWriteToolDefinition } from "../src/providers/write-preview.js";

type WriteResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type WriteExecute = (
  toolCallId: string,
  params: { path: string; content: string },
  signal?: AbortSignal,
) => Promise<WriteResult>;

const roots: string[] = [];

const makeCwd = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-write-device-")));
  roots.push(root);
  return root;
};

const writeTool = (cwd: string): WriteExecute =>
  createPreviewWriteToolDefinition(cwd).execute as unknown as WriteExecute;

const textOf = (result: WriteResult): string =>
  result.content.find((block) => block.type === "text")?.text ?? "";

const entriesUnder = (root: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("omp.write device paths", () => {
  it("refuses an unknown xd:// device instead of writing a literal xd: directory", async () => {
    const cwd = makeCwd();
    await expect(
      writeTool(cwd)("call-1", { path: "xd://nonexistent_device_probe", content: "{}" }),
    ).rejects.toThrow(/Refusing to write 'xd:\/\/nonexistent_device_probe'/);
    expect(entriesUnder(cwd)).toEqual([]);
  });

  it("creates no filesystem entry named like a scheme for any xd:// form", async () => {
    const cwd = makeCwd();
    const write = writeTool(cwd);
    for (const target of ["xd://recall", "xd:/recall", "xd://", "XD://Recall"]) {
      await expect(write("call-2", { path: target, content: "{}" })).rejects.toThrow();
    }
    expect(entriesUnder(cwd).filter((entry) => path.basename(entry).startsWith("xd:"))).toEqual([]);
    expect(entriesUnder(cwd)).toEqual([]);
  });

  it("names the offending path and points at the device transport", async () => {
    const cwd = makeCwd();
    const captured = await writeTool(cwd)("call-3", { path: "xd://ast_grep", content: "{}" }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(captured).toBeInstanceOf(Error);
    const error = captured as Error & { path?: string };
    expect(error.name).toBe("OmpWriteUriTargetError");
    expect(error.path).toBe("xd://ast_grep");
    expect(error.message).toContain("'xd://ast_grep'");
    expect(error.message).toContain("top-level `write` tool");
  });

  it("refuses any other URI scheme that would become a stray directory", async () => {
    const cwd = makeCwd();
    await expect(
      writeTool(cwd)("call-4", { path: "https://example.com/report.txt", content: "hi" }),
    ).rejects.toThrow(/Refusing to write 'https:\/\/example\.com\/report\.txt'/);
    expect(entriesUnder(cwd)).toEqual([]);
  });

  it("still writes a literal scheme-shaped filename behind the './' escape hatch", async () => {
    const cwd = makeCwd();
    const result = await writeTool(cwd)("call-5", { path: "./xd://recall", content: "literal" });
    expect(textOf(result)).toBe("Successfully wrote 7 bytes to ./xd://recall");
    expect(fs.readFileSync(path.join(cwd, "xd:", "recall"), "utf8")).toBe("literal");
  });

  it("does not mistake a Windows drive letter for a URI scheme", async () => {
    const cwd = makeCwd();
    const result = await writeTool(cwd)("call-6", { path: "C:/notes.txt", content: "drive" });
    expect(textOf(result)).toBe("Successfully wrote 5 bytes to C:/notes.txt");
    expect(entriesUnder(cwd).some((entry) => entry.includes("notes.txt"))).toBe(true);
  });
});

describe("omp.write filesystem paths", () => {
  it("writes a relative path and reports the caller's path unchanged", async () => {
    const cwd = makeCwd();
    const result = await writeTool(cwd)("call-7", { path: "nested/dir/note.txt", content: "alpha\n" });
    expect(textOf(result)).toBe("Successfully wrote 6 bytes to nested/dir/note.txt");
    expect(fs.readFileSync(path.join(cwd, "nested", "dir", "note.txt"), "utf8")).toBe("alpha\n");
    expect(result.details).toEqual({ codePreviewBeforeWrite: undefined });
  });

  it("writes an absolute path outside the session cwd", async () => {
    const cwd = makeCwd();
    const target = path.join(makeCwd(), "outside.txt");
    const result = await writeTool(cwd)("call-8", { path: target, content: "beta" });
    expect(textOf(result)).toBe(`Successfully wrote 4 bytes to ${target}`);
    expect(fs.readFileSync(target, "utf8")).toBe("beta");
  });

  it("captures the previous content when overwriting", async () => {
    const cwd = makeCwd();
    fs.writeFileSync(path.join(cwd, "example.txt"), "before\n");
    const result = await writeTool(cwd)("call-9", { path: "example.txt", content: "after\n" });
    expect(textOf(result)).toBe("Successfully wrote 6 bytes to example.txt");
    expect(result.details).toEqual({
      codePreviewBeforeWrite: { kind: "content", content: "before\n" },
    });
    expect(fs.readFileSync(path.join(cwd, "example.txt"), "utf8")).toBe("after\n");
  });
});
