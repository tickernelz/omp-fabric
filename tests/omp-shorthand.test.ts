import { describe, expect, it, vi } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { classifyOmpBashError } from "../src/core/omp-bash-error.js";

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

describe("omp bare-string shorthand", () => {
  it("type-checks bare-string calls for string-primary omp tools", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.bash("echo hi"); const b = await omp.read("x"); const c = await omp.ls("y"); const d = await omp.grep("z"); const e = await omp.find("w"); return { a: a.output, b, c, d, e };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("defers non-string scalars and bare strings to object-only tools to runtime", () => {
    // Functional-errors-only: wrong arg type and bare strings to object-only
    // tools are no longer type-check errors — they surface at runtime instead.
    const bad = typeCheckFabricCode('await omp.bash(123); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(bad.errors).toEqual([]);

    const editBad = typeCheckFabricCode('await omp.edit("/x"); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(editBad.errors).toEqual([]);
  });

  it("coerces bare-string calls at runtime and passes object form through", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "omp.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "omp.read") return String(args.path);
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await omp.bash("echo hi"); const b = await omp.bash({ command: "ls", timeout: 5 }); const c = await omp.read("/x"); return { a: a.output, b: b.output, c };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("omp.bash");
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[0]).toBe("omp.bash");
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[2]?.[0]).toBe("omp.read");
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(result.value).toEqual({ a: "echo hi", b: "ls", c: "/x" });
  });


  it("rejects a nonzero exit by default and settles only with settle:true", async () => {
    const checked = typeCheckFabricCode(
      `const result = await omp.bash({ command: "exit 7", settle: true });
       return result.ok ? result.output : result.exitCode;`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(checked.errors).toEqual([]);

    const hostCall = vi.fn(async (_ref: string, args: Record<string, unknown>) => {
      if (args.command === "exit 7") {
        throw classifyOmpBashError(new Error("before\n\n\nCommand exited with code 7"));
      }
      throw new Error("Command timed out after 1000ms");
    });
    const result = await new QuickJsRuntime().execute(
      `let defaultRejected;
       try { await omp.bash({ command: "exit 7" }); }
       catch (error) { defaultRejected = error instanceof Error ? error.message : String(error); }
       const settled = await omp.bash({ command: "exit 7", settle: true });
       let timeoutError;
       try { await omp.bash({ command: "sleep 2", timeout: 1, settle: true }); }
       catch (error) { timeoutError = error instanceof Error ? error.message : String(error); }
       return { defaultRejected, settled, timeoutError };`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      defaultRejected: "before\n\n\nCommand exited with code 7",
      settled: {
        ok: false,
        output: "before\n",
        details: null,
        exitCode: 7,
        error: "before\n\n\nCommand exited with code 7",
      },
      timeoutError: "Command timed out after 1000ms",
    });
    // settle is a guest-only directive; it never reaches the host.
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "exit 7" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ command: "sleep 2", timeout: 1 });
    expect(hostCall.mock.calls.map((call) => call[0])).toEqual(["omp.bash", "omp.bash", "omp.bash"]);
  });
});

describe("omp argument alias flattening", () => {
  it("type-checks common alias keys and the flat edit shape", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.bash({ cmd: "echo hi" });' +
        'const b = await omp.find({ query: "*.ts" });' +
        'const c = await omp.read({ file: "/x" });' +
        'const d = await omp.write({ file: "/y", content: "z" });' +
        'const e = await omp.edit({ file: "/x", oldText: "a", newText: "b", all: true });' +
        'const f = await omp.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });


  it("type-checks observed long-tail aliases", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.read({ file_path: "/x" });' +
        'const b = await omp.grep({ q: "TODO" });' +
        'const c = await omp.write({ target_file: "/y", fileContent: "z" });' +
        'const d = await omp.edit({ absolutePath: "/x", from: "a", to: "b" });' +
        'const e = await omp.edit({ path: "/x", edits: [{ old_string: "a", new_content: "b" }] });' +
        'const f = await omp.ls({ directoryPath: "/s" });' +
        'const g = await omp.find({ include: "*.ts" });' +
        'const h = await omp.bash({ commandLine: "pwd" });' +
        'return { a, b, c: c.output, d: d.output, e: e.output, f, g, h: h.output };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("normalizes aliases inside batched edits", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "edited", details: null }));
    const result = await new QuickJsRuntime().execute(
      'return omp.edit({ path: "/x", edits: [{ old: "a", replacement: "b", all: true }] });',
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(hostCall).toHaveBeenCalledWith("omp.edit", {
      path: "/x",
      edits: [{ oldText: "a", newText: "b", all: true }],
    }, expect.any(AbortSignal));
  });

  it("normalizes alias keys and the flat edit shape at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "omp.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "omp.find") return "found";
      if (ref === "omp.read") return "read";
      if (ref === "omp.write") return { ok: true, output: "wrote", details: null };
      if (ref === "omp.edit") return { ok: true, output: "edited", details: null };
      if (ref === "omp.ls") return "listed";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await omp.bash({ cmd: "echo hi" });' +
        'const b = await omp.find({ query: "*.ts" });' +
        'const c = await omp.read({ file: "/x" });' +
        'const d = await omp.write({ file: "/y", content: "z" });' +
        'const e = await omp.edit({ file: "/x", oldText: "a", newText: "b" });' +
        'const f = await omp.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/s" });
    expect(result.value).toEqual({ a: "echo hi", b: "found", c: "read", d: "wrote", e: "edited", f: "listed" });
  });

  it("normalizes observed long-tail aliases before host validation", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
await omp.read({ file_path: "/x" });
await omp.grep({ q: "TODO" });
await omp.write({ target_file: "/y", fileContent: "z" });
await omp.edit({ absolutePath: "/x", from: "a", to: "b" });
await omp.edit({ path: "/x", edits: [{ old_string: "c", new_content: "d" }] });
await omp.ls({ directoryPath: "/s" });
await omp.find({ include: "*.ts" });
await omp.bash({ commandLine: "pwd" });
return "done";
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return ref === "omp.bash" || ref === "omp.edit" || ref === "omp.write"
          ? { ok: true, output: "ok", details: null }
          : "ok";
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.args)).toEqual([
      { path: "/x" },
      { pattern: "TODO" },
      { path: "/y", content: "z" },
      { path: "/x", edits: [{ oldText: "a", newText: "b" }] },
      { path: "/x", edits: [{ oldText: "c", newText: "d" }] },
      { path: "/s" },
      { pattern: "*.ts" },
      { command: "pwd" },
    ]);
  });

  it("omits only known optional nulls and lets canonical fields win", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await new QuickJsRuntime().execute(
      `
await omp.read({ path: "/canonical", file_path: "/alias", offset: null, limit: null });
await omp.bash({ command: "pwd", timeoutMs: null });
await omp.grep({ pattern: "TODO", path: null, glob: null, ignoreCase: null, literal: null, context: null, limit: null });
await omp.find({ pattern: "*.ts", path: null, limit: null });
await omp.ls({ path: null, limit: null });
await omp.read({ path: null, offset: null });
return "done";
`,
      async (ref, args) => {
        calls.push(args);
        return ref === "omp.bash" ? { ok: true, output: "ok", details: null } : "ok";
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      { path: "/canonical" },
      { command: "pwd" },
      { pattern: "TODO" },
      { pattern: "*.ts" },
      {},
      { path: null },
    ]);
  });

});

describe("agents.status debug fields", () => {
  it("type-checks text/value/error/logFile on the status union without narrowing", () => {
    const result = typeCheckFabricCode(
      'const s = await agents.status({ id: "x" });' +
        'return { error: s.error, text: s.text, value: s.value, log: s.logFile };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
});

describe("omp positional args", () => {
  it("type-checks multi-arg positional calls", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.grep("TODO", "src");' +
        'const b = await omp.find("*.ts", "src", 10);' +
        'const c = await omp.write("/x", "content");' +
        'const d = await omp.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("maps positional args to canonical object form at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "omp.grep") return "g";
      if (ref === "omp.find") return "f";
      if (ref === "omp.write") return { ok: true, output: "w", details: null };
      if (ref === "omp.edit") return { ok: true, output: "e", details: null };
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await omp.grep("TODO", "src");' +
        'const b = await omp.find("*.ts", "src", 10);' +
        'const c = await omp.write("/x", "content");' +
        'const d = await omp.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ pattern: "TODO", path: "src" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts", path: "src", limit: 10 });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x", content: "content" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", edits: [{ oldText: "old", newText: "new" }] });
    expect(result.value).toEqual({ a: "g", b: "f", c: "w", d: "e" });
  });

  it("type-check-rejects 2-arg calls with a non-object second arg so it is not silently dropped", () => {
    const result = typeCheckFabricCode('await omp.read("/x", 10); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /properties in common|argument/i.test(e.message))).toBe(true);
  });

  it("type-checks two-arg (primary, options) calls for string-primary tools", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.read("index.ts", { limit: 120 });' +
        'const b = await omp.bash("ls dist", { timeout: 30 });' +
        'const c = await omp.bash("pwd", { timeoutMs: 5000, settle: true });' +
        'const d = await omp.ls("src", { limit: 20 });' +
        'const e = await omp.grep("TODO", { path: "src", ignoreCase: true, ctx: 2 });' +
        'const f = await omp.find("*.ts", { path: "src", limit: 5 });' +
        'return { a, b: b.ok, c: c.ok, d, e, f };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("merges two-arg (primary, options) calls into canonical object form at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "omp.bash") return { ok: true, output: "b", details: null };
      if (ref === "omp.read") return "r";
      if (ref === "omp.ls") return "l";
      if (ref === "omp.grep") return "g";
      if (ref === "omp.find") return "f";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await omp.read("index.ts", { limit: 120 });' +
        'const b = await omp.bash("ls", { timeoutMs: 2000 });' +
        'const c = await omp.ls("src", { max: 10 });' +
        'const d = await omp.grep("TODO", { path: "src", ctx: 2 });' +
        'const e = await omp.find("*.ts", { path: "src", limit: "5" });' +
        'const f = await omp.read("positional.ts", { path: "object.ts", limit: 1 });' +
        'return [a, b.output, c, d, e, f];',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ path: "index.ts", limit: 120 });
    // timeoutMs unit conversion applies to the merged object.
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "ls", timeout: 2 });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "src", limit: 10 });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ pattern: "TODO", path: "src", context: 2 });
    // Numeric strings still coerce to numbers after the merge.
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ pattern: "*.ts", path: "src", limit: 5 });
    // The positional string wins the primary field on conflict.
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "positional.ts", limit: 1 });
    expect(result.value).toEqual(["r", "b", "l", "g", "f", "r"]);
  });

  it("settles a two-arg bash call when the merged options carry settle:true", async () => {
    const hostCall = vi.fn(async (_ref: string, _args: Record<string, unknown>): Promise<never> => {
      throw classifyOmpBashError(new Error("oops\n\n\nCommand exited with code 7"));
    });
    const result = await new QuickJsRuntime().execute(
      'return await omp.bash("exit 7", { settle: true });',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "exit 7" });
    expect(result.value).toEqual({
      ok: false,
      output: "oops\n",
      details: null,
      exitCode: 7,
      error: "oops\n\n\nCommand exited with code 7",
    });
  });
});

describe("omp expanded argument aliases", () => {
  it("type-checks expanded alias keys", () => {
    const result = typeCheckFabricCode(
      'const a = await omp.bash({ shell: "ls", timeoutMs: 5 });' +
        'const b = await omp.grep({ regex: "TODO", ic: true, ctx: 2, skip: 1, globPattern: "*.ts" });' +
        'const c = await omp.find({ search: "*.ts", max: 3 });' +
        'const d = await omp.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await omp.write({ path: "/y", text: "z" });' +
        'const f = await omp.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await omp.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("converts bash timeoutMs to timeout seconds", async () => {
    const hostCall = vi.fn(async (_ref: string, _args: Record<string, unknown>) => ({
      ok: true,
      output: "",
      details: null,
    }));
    const result = await new QuickJsRuntime().execute(
      'return await omp.bash({ command: "sleep 1", timeoutMs: 1000 });',
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "sleep 1", timeout: 1 });
  });

  it("normalizes expanded alias keys at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "omp.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "omp.grep") return "g";
      if (ref === "omp.find") return "f";
      if (ref === "omp.read") return "r";
      if (ref === "omp.write") return { ok: true, output: "w", details: null };
      if (ref === "omp.edit") return { ok: true, output: "e", details: null };
      if (ref === "omp.ls") return "l";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await omp.bash({ shell: "ls", timeoutMs: 5000 });' +
        'const b = await omp.grep({ regex: "TODO", ic: true, ctx: 2, skip: 1, globPattern: "*.ts" });' +
        'const c = await omp.find({ search: "*.ts", max: 3 });' +
        'const d = await omp.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await omp.write({ path: "/y", text: "z" });' +
        'const f = await omp.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await omp.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "TODO", ignoreCase: true, context: 2, skip: 1, glob: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ pattern: "*.ts", limit: 3 });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/x", offset: 0, limit: 10 });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[6]?.[1]).toEqual({ path: "/s", limit: 2 });
    expect(result.value).toEqual({ a: "ls", b: "g", c: "f", d: "r", e: "w", f: "e", g: "l" });
  });
});

describe("tools discovery proxy", () => {
  it("routes discovery, normalizes search shorthand, and rejects core-tool names with an omp hint", async () => {
    const checked = typeCheckFabricCode(
      'return tools.search("fovea");',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(checked.errors).toEqual([]);

    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "fabric.$providers") return [{ name: "omp", description: "OMP's built-in coding tools" }];
      if (ref === "fabric.$list") return [];
      if (ref === "fabric.$search") return [{ ref: `extensions.${String(args.query)}_focus` }];
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const p = await tools.providers();' +
        'const l = await tools.list({});' +
        'const s = await tools.search("fovea");' +
        'let err = ""; try { tools.read({ path: "/x" }); } catch (e) { err = String(e); }' +
        'return { providers: p.length, list: l.length, search: s[0].ref, err };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("fabric.$providers");
    expect(hostCall.mock.calls[1]?.[0]).toBe("fabric.$list");
    expect(hostCall.mock.calls[2]?.slice(0, 2)).toEqual(["fabric.$search", { query: "fovea" }]);
    const value = result.value as { providers: number; list: number; search: string; err: string };
    expect(value.providers).toBe(1);
    expect(value.list).toBe(0);
    expect(value.search).toBe("extensions.fovea_focus");
    expect(value.err).toContain("tools.read is not available");
    expect(value.err).toContain("omp.read");
  });
});
