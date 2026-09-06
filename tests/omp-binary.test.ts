import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOmpBinary } from "../src/agents/omp-binary.js";

describe("resolveOmpBinary", () => {
  it("prefers an explicit configured binary", () => {
    expect(resolveOmpBinary("/custom/omp", {
      env: { OMP_FABRIC_OMP_BINARY: "/env/omp", LOCALTERM: "1" },
      homeDirectory: "/home/test",
      isExecutable: () => true,
    })).toBe("/custom/omp");
  });

  it("prefers OMP_FABRIC_OMP_BINARY over LocalTerm discovery", () => {
    expect(resolveOmpBinary(undefined, {
      env: { OMP_FABRIC_OMP_BINARY: "/env/omp", LOCALTERM: "1" },
      homeDirectory: "/home/test",
      isExecutable: () => true,
    })).toBe("/env/omp");
  });

  it("uses the LocalTerm shim by absolute path inside LocalTerm", () => {
    const isExecutable = vi.fn(() => true);
    const binary = resolveOmpBinary(undefined, {
      env: { LOCALTERM: "1" },
      homeDirectory: "/home/test",
      isExecutable,
    });

    const expected = path.join("/home/test", ".localterm", "shims", "omp");
    expect(binary).toBe(expected);
    expect(isExecutable).toHaveBeenCalledWith(expected);
  });

  it("falls back to PATH lookup when the LocalTerm shim is unavailable", () => {
    expect(resolveOmpBinary(undefined, {
      env: { LOCALTERM: "1" },
      homeDirectory: "/home/test",
      isExecutable: () => false,
    })).toBe("omp");
  });

  it("uses PATH lookup outside LocalTerm", () => {
    const isExecutable = vi.fn(() => true);
    expect(resolveOmpBinary(undefined, { env: {}, isExecutable })).toBe("omp");
    expect(isExecutable).not.toHaveBeenCalled();
  });
});
