import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveBashCwdArgument,
  resolveOmpBashCwd,
  withBashCwdSchema,
} from "../src/providers/omp-bash-cwd.js";

const roots: string[] = [];

const makeTree = (): { root: string; nested: string } => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-cwd-")));
  roots.push(root);
  const nested = path.join(root, "services", "link");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested };
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveOmpBashCwd", () => {
  it("resolves a relative path against the session cwd", () => {
    const { root, nested } = makeTree();
    expect(resolveOmpBashCwd(root, "services/link")).toBe(nested);
  });

  it("accepts an absolute path outside the session cwd", () => {
    const { root, nested: elsewhere } = makeTree();
    expect(resolveOmpBashCwd(root, elsewhere)).toBe(elsewhere);
  });

  it("normalizes parent traversal without rejecting it", () => {
    const { root, nested } = makeTree();
    expect(resolveOmpBashCwd(nested, "../..")).toBe(root);
  });

  it("preserves a symlinked directory instead of canonicalizing it", () => {
    const { root, nested } = makeTree();
    const link = path.join(root, "worktree-link");
    fs.symlinkSync(nested, link, "dir");
    expect(resolveOmpBashCwd(root, "worktree-link")).toBe(link);
  });

  it("names the resolved path when the directory is missing", () => {
    const { root } = makeTree();
    expect(() => resolveOmpBashCwd(root, "nope")).toThrowError(
      `Invalid omp.bash cwd "nope" (${path.join(root, "nope")})`,
    );
  });

  it("rejects files and invalid values", () => {
    const { root } = makeTree();
    const file = path.join(root, "README.md");
    fs.writeFileSync(file, "test\n");
    expect(() => resolveOmpBashCwd(root, file)).toThrowError(/path is not a directory/);
    expect(() => resolveOmpBashCwd(root, "   ")).toThrowError(/must be a non-empty string/);
    expect(() => resolveOmpBashCwd(root, 5)).toThrowError(/must be a non-empty string/);
  });
});

describe("resolveBashCwdArgument", () => {
  it("preserves arguments when cwd is absent", () => {
    const { root } = makeTree();
    const args = { command: "pwd" };
    expect(resolveBashCwdArgument(root, args)).toBe(args);
  });

  it("rewrites cwd without changing other arguments", () => {
    const { root, nested } = makeTree();
    expect(resolveBashCwdArgument(root, { command: "pwd", timeout: 5, cwd: "services/link" }))
      .toEqual({ command: "pwd", timeout: 5, cwd: nested });
  });
});
describe("withBashCwdSchema", () => {
  const schema = withBashCwdSchema(Type.Object({ command: Type.String() })) as {
    toJsonSchema(): { properties?: Record<string, unknown> };
    safeParse(value: unknown): { success: boolean };
  };

  it("declares and validates cwd", () => {
    expect(Object.keys(schema.toJsonSchema().properties ?? {})).toContain("cwd");
    expect(schema.safeParse({ command: "pwd" }).success).toBe(true);
    expect(schema.safeParse({ command: "pwd", cwd: "/tmp" }).success).toBe(true);
    expect(schema.safeParse({ command: "pwd", cwd: 5 }).success).toBe(false);
  });

  it("is idempotent", () => {
    expect(withBashCwdSchema(schema)).toBe(schema);
  });
});
