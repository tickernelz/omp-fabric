import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExtensionContext,
  type ExtensionRunner,
} from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FabricExecutionTraceRecorder } from "../src/audit/trace.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "../src/core/action-registry.js";
import { OmpToolsProvider, TRUNCATION_MARKER } from "../src/providers/omp-tools-provider.js";

const baseContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "fabric_test-nested",
  extensionContext: {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext,
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
};

const makeRunner = (overrides: Record<string, unknown> = {}): ExtensionRunner =>
  ({
    createContext: () => ({ cwd: process.cwd() }),
    getActiveTools: () => [],
    emit: vi.fn(async () => {}),
    emitToolCall: vi.fn(async () => undefined),
    emitToolResult: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as ExtensionRunner;

const registerWithRunner = (runner: ExtensionRunner) => {
  const catalog = new CapturedToolCatalog();
  catalog.replace(
    [],
    runner,
    DEFAULT_FABRIC_CONFIG.capture,
    "/extensions/omp-fabric/index.ts",
  );
  const registry = new ActionRegistry();
  registry.register(new OmpToolsProvider(process.cwd(), catalog, undefined));
  return registry;
};

describe("OmpToolsProvider lifecycle", () => {
  it("fires the full tool-execution lifecycle for an omp core tool", async () => {
    const events: string[] = [];
    const runner = makeRunner({
      emit: vi.fn(async (event: { type: string }) => {
        events.push(event.type);
      }),
    });
    const registry = registerWithRunner(runner);

    await registry.invoke("omp.ls", { path: process.cwd() }, baseContext);

    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(runner.emitToolCall).toHaveBeenCalledOnce();
    expect(runner.emitToolResult).toHaveBeenCalledOnce();
    const toolResult = (runner.emitToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { toolName: string; toolCallId: string; isError: boolean };
    expect(toolResult).toMatchObject({ toolName: "ls", isError: false });
    // ActionRegistry rewrites nestedToolCallId to fabric_<uuid>.
    expect(toolResult.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)).toBe(true);
  });

  it("stops waiting for a hanging lifecycle handler when the invocation is aborted", async () => {
    const controller = new AbortController();
    const runner = makeRunner({
      emitToolResult: vi.fn(async () => new Promise(() => undefined)),
    });
    const registry = registerWithRunner(runner);
    const invocation = registry.invoke(
      "omp.ls",
      { path: process.cwd() },
      { ...baseContext, signal: controller.signal },
    );

    await vi.waitFor(() => expect(runner.emitToolResult).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel nested lifecycle"));

    await expect(invocation).rejects.toThrow("cancel nested lifecycle");
  });

  it("synchronizes tool_call argument mutations across audit surfaces", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
        event.input.command = `export EXAMPLE=true\n${String(event.input.command)}`;
      }),
    });
    const registry = registerWithRunner(runner);
    const audits: FabricCallAudit[] = [];
    const events: unknown[] = [];
    const trace = new FabricExecutionTraceRecorder();

    const result = await registry.invoke(
      "omp.bash",
      { command: `printf "executed:$EXAMPLE\n"` },
      {
        ...baseContext,
        audits,
        trace,
        observeInvocation: (event) => events.push(event),
      },
    ) as { output: string };

    const executedCommand = `export EXAMPLE=true\nprintf "executed:$EXAMPLE\n"`;
    expect(result.output).toBe("executed:true\n");
    expect(audits[0]?.args).toEqual({ command: executedCommand });
    expect(audits[0]?.preview).toMatchObject({ bashCommand: executedCommand });
    expect(events).toContainEqual(expect.objectContaining({
      type: "call_args",
      args: { command: executedCommand },
    }));
    expect(trace.seal("succeeded", []).operations[0]?.args).toEqual({
      command: executedCommand,
    });
  });

  it("real bash nonzero-exit message matches the guest settle regex", async () => {
    const runner = makeRunner();
    const registry = registerWithRunner(runner);
    const error = await registry
      .invoke("omp.bash", { command: "exit 7" }, baseContext)
      .then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Mirrors the settle catch in src/runtime/quickjs-runtime.ts.
    const match = /(?:^|\n\n)Command exited with code (\d+)$/.exec(message);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(7);
  });

  it("applies a tool_result content patch to a core tool result", async () => {
    const runner = makeRunner({
      emitToolResult: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "[Image: a sample image, fully described.]" }],
      })),
    });
    const registry = registerWithRunner(runner);

    // A tool_result patch must flow through normalizeResult as the returned text.
    // Use a text file here because image decoding is covered by the media tests below.
    const result = await registry.invoke(
      "omp.read",
      { path: "package.json" },
      baseContext,
    );

    expect(result).toBe("[Image: a sample image, fully described.]");
  });


  it("honors a tool_call block by throwing without executing", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async () => ({ block: true, reason: "denied by gate" })),
    });
    const registry = registerWithRunner(runner);

    await expect(
      registry.invoke("omp.ls", { path: process.cwd() }, baseContext),
    ).rejects.toThrow("denied by gate");
  });

  it("forwards bounded partial previews without an extension runner", async () => {
    const provider = new OmpToolsProvider(process.cwd(), undefined, undefined);
    const previews: Array<{ result?: unknown }> = [];
    const updates: string[] = [];

    await provider.invoke(
      "bash",
      { command: "printf first; sleep 0.15; printf second" },
      {
        ...baseContext,
        update(message) { updates.push(message); },
        attachPreview(preview) { previews.push(preview as { result?: unknown }); },
      },
    );

    expect(updates.some((message) => message.includes("first"))).toBe(true);
    expect(previews.some((preview) => JSON.stringify(preview.result).includes("first"))).toBe(true);
  });

  it("falls back to a direct execute (no events) when no runner is bound", async () => {
    const registry = new ActionRegistry();
    registry.register(new OmpToolsProvider(process.cwd(), undefined, undefined));
    const result = await registry.invoke("omp.ls", { path: process.cwd() }, baseContext);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  it("preserves shell cwd through host argument preparation", async () => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-provider-cwd-")),
    );
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    try {
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(root, undefined, undefined));
      const result = await registry.invoke(
        "omp.bash",
        {
          command: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e "process.stdout.write(process.cwd())"`,
          cwd: "nested",
        },
        {
          ...baseContext,
          cwd: root,
          extensionContext: { ...baseContext.extensionContext, cwd: root } as ExtensionContext,
          audits: [],
        },
      ) as { output: string };
      expect(fs.realpathSync.native(result.output.trim())).toBe(
        fs.realpathSync.native(nested),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  it("expands explicit skill-dir markers only for SKILL.md reads", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-skill-dir-"));
    const skillDir = path.join(cwd, "installed", "duplicate-name");
    const skillPath = path.join(skillDir, "SKILL.md");
    const referencePath = path.join(skillDir, "reference.md");
    const source = "Read `<skill-dir>/reference.md`.\n";
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, source);
      fs.writeFileSync(referencePath, source);
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      const context = {
        ...baseContext,
        cwd,
        extensionContext: { cwd } as ExtensionContext,
      };

      const skillResult = await registry.invoke("omp.read", { path: skillPath }, context) as string;
      expect(skillResult).toContain(`Read \`${skillDir}/reference.md\`.`);
      expect(skillResult).not.toContain("[installed/duplicate-name/SKILL.md#");
      await expect(
        registry.invoke("omp.read", { path: referencePath }, context),
      ).resolves.toBe(source);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns every line of a long file to a guest read", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-guest-read-lines-"));
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    try {
      fs.writeFileSync(path.join(cwd, "long.txt"), `${lines.join("\n")}\n`);
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      const result = await registry.invoke(
        "omp.read",
        { path: "long.txt" },
        { ...baseContext, cwd, extensionContext: { cwd } as ExtensionContext },
      ) as string;

      expect(result.split("\n").filter((line) => line.length > 0)).toHaveLength(400);
      expect(result).toContain("line 400");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns full-width lines to a guest read", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-guest-read-width-"));
    const line = "w".repeat(2005);
    try {
      fs.writeFileSync(
        path.join(cwd, "wide.txt"),
        `${Array.from({ length: 10 }, () => line).join("\n")}\n`,
      );
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      const result = await registry.invoke(
        "omp.read",
        { path: "wide.txt" },
        { ...baseContext, cwd, extensionContext: { cwd } as ExtensionContext },
      ) as string;

      const returned = result.split("\n").filter((entry) => entry.length > 0);
      expect(returned).toHaveLength(10);
      expect(returned[0]).toHaveLength(2005);
      expect(returned[9]).toHaveLength(2005);
      expect(result).not.toContain("\u2026");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns truncated Bash output once while preserving recovery metadata", async () => {
    const registry = new ActionRegistry();
    registry.register(new OmpToolsProvider(process.cwd(), undefined, undefined));
    const result = await registry.invoke(
      "omp.bash",
      {
        command:
          `node -e 'for (let i = 0; i < 5000; i++) console.log(i, "x".repeat(100))'`,
      },
      { ...baseContext, maxResultChars: 2_000_000 },
    );
    const bashResult = result as {
      ok: boolean;
      output: string;
      details: {
        fullOutputPath?: string;
        truncation?: Record<string, unknown>;
      };
    };
    try {
      expect(bashResult).toMatchObject({
        ok: true,
        output: expect.any(String),
        details: {
          fullOutputPath: expect.any(String),
          truncation: { truncated: true },
        },
      });
      expect("content" in (bashResult.details.truncation ?? {})).toBe(false);
    } finally {
      if (bashResult.details.fullOutputPath) fs.rmSync(bashResult.details.fullOutputPath, { force: true });
    }
  });

  it("applies all repeated edit anchors through one native mutation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-edit-all-"));
    const filePath = path.join(cwd, "example.txt");
    try {
      fs.writeFileSync(filePath, "header\nneedle one\nneedle two\n");
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      const result = await registry.invoke(
        "omp.edit",
        {
          path: "example.txt",
          edits: [
            { oldText: "header", newText: "title" },
            { oldText: "needle", newText: "updated", all: true },
          ],
        },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits: [],
        },
      ) as { ok: boolean; output: string };

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("title\nupdated one\nupdated two\n");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves the file unchanged when any replace-all anchor is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-edit-all-atomic-"));
    const filePath = path.join(cwd, "example.txt");
    const before = "needle one\nneedle two\n";
    try {
      fs.writeFileSync(filePath, before);
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      await expect(registry.invoke(
        "omp.edit",
        {
          path: "example.txt",
          edits: [
            { oldText: "needle", newText: "updated" },
            { oldText: "missing", newText: "never" },
          ],
          all: true,
        },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits: [],
        },
      )).rejects.toThrow("edits[1] oldText was not found");
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures pre-write content out of band without changing the sandbox result", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-write-preview-"));
    const before = `const value = 1;
`;
    const after = `export const value = "é${"x".repeat(20_000)}";
`;
    try {
      fs.writeFileSync(path.join(cwd, "example.ts"), before);
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(cwd, undefined, undefined));
      const audits: FabricCallAudit[] = [];
      const result = await registry.invoke(
        "omp.write",
        { path: "example.ts", content: after },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits,
        },
      ) as { ok: boolean; output: string; details: unknown };

      expect(result).toMatchObject({ ok: true, details: null });
      expect(result.output).toContain("Successfully wrote");
      expect(result.output).toContain(`${Buffer.byteLength(after, "utf8")} bytes`);
      expect(fs.readFileSync(path.join(cwd, "example.ts"), "utf8")).toBe(after);
      expect(String(audits[0]?.args?.content ?? "").length).toBeLessThan(after.length);
      expect(audits[0]?.preview).toMatchObject({
        writeBeforeCaptured: true,
        writeContent: after,
        writeByteLength: Buffer.byteLength(after, "utf8"),
        writeLineCount: 1,
        codePreviewBeforeWrite: { kind: "content", content: before },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });


  it("attaches the pre-patch image and clean note when a tool_result patch replaces image blocks", async () => {
    // pi-vision-handoff keeps the read note and swaps the image for a
    // description. The provider captures the image BEFORE the patch (so the
    // single-call kitty preview still shows it) and the clean note AFTER.
    let rawContent: unknown;
    const runner = makeRunner({
      emitToolResult: vi.fn(async (event: { content: unknown }) => {
        rawContent = event.content;
        return {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "text" as const, text: "[Image: a described image.]" },
          ],
        };
      }),
    });
    const registry = registerWithRunner(runner);
    const audits: FabricCallAudit[] = [];

    await registry.invoke(
      "omp.read",
      { path: "tests/fixtures/images/sample.jpg" },
      { ...baseContext, audits },
    );

    expect((rawContent as Array<{ type: string }>).some((block) => block.type === "image")).toBe(true);
    expect(audits).toHaveLength(1);
    const media = audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
    expect(audits[0]?.mediaNote).toBe("Read image file [image/png]");
  }, 15_000);
});

describe("extension hijack contract for nested core tools", () => {
  // Generalized pi-vision-handoff pattern: any extension that expresses a
  // core-tool hijack as tool_call/tool_result handlers sees its behavior
  // inside fabric_exec omp.* calls, because the provider replays OMP's
  // lifecycle event pipeline for nested executions.
  it("co-exists native grep lines with an extension-appended block via tool_result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-grep-append-"));
    fs.writeFileSync(path.join(dir, "users.ts"), "export function GetUserHandler() {}\n");
    try {
      const runner = makeRunner({
        emitToolResult: vi.fn(
          async (event: { toolName: string; content: Array<{ type: string; text?: string }> }) =>
            event.toolName === "grep"
              ? {
                  content: [
                    ...event.content,
                    { type: "text", text: 'fovea graph "GetUserHandler" \u00b7 anchor context' },
                  ],
                }
              : undefined,
        ),
      });
      const registry = registerWithRunner(runner);

      const result = await registry.invoke(
        "omp.grep",
        { pattern: "GetUserHandler", path: dir },
        baseContext,
      );

      // Both surfaces co-exist: exact-match lines from core grep, plus the
      // extension's appended context block.
      expect(String(result)).toContain("GetUserHandler");
      expect(String(result)).toContain("fovea graph");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reroutes nested grep arguments mutated by a tool_call handler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-grep-mutate-"));
    fs.writeFileSync(path.join(dir, "users.ts"), "export function GetUserHandler() {}\n");
    try {
      const runner = makeRunner({
        emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
          event.input.pattern = "zzz-no-such-symbol";
        }),
      });
      const registry = registerWithRunner(runner);

      const result = await registry.invoke(
        "omp.grep",
        { pattern: "GetUserHandler", path: dir },
        baseContext,
      );

      expect(String(result)).not.toContain("users.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a nested core tool through the tool_call preflight", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async () => ({ block: true, reason: "grep requires an audit note" })),
    });
    const registry = registerWithRunner(runner);

    await expect(
      registry.invoke("omp.grep", { pattern: "anything" }, baseContext),
    ).rejects.toThrow("grep requires an audit note");
  });
});

describe("OmpToolsProvider result fidelity", () => {
  const withFixtures = async (
    build: (dir: string) => void,
    run: (registry: ActionRegistry, dir: string) => Promise<void>,
    maxResultChars = 5_000_000,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-fidelity-"));
    try {
      build(dir);
      const registry = new ActionRegistry();
      registry.register(new OmpToolsProvider(dir, undefined, undefined));
      const previous = baseContext.maxResultChars;
      baseContext.maxResultChars = maxResultChars;
      try {
        await run(registry, dir);
      } finally {
        baseContext.maxResultChars = previous;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const parseMarker = (text: string): Record<string, unknown> | undefined => {
    const start = text.indexOf(TRUNCATION_MARKER);
    if (start === -1) return undefined;
    const end = text.indexOf("\n", start);
    return JSON.parse(text.slice(start + TRUNCATION_MARKER.length, end === -1 ? undefined : end));
  };

  it("pages a read past the host 3000-line cap until the file is exhausted", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(
          path.join(dir, "big.txt"),
          `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
        );
      },
      async (registry, dir) => {
        const file = path.join(dir, "big.txt");
        const result = String(await registry.invoke("omp.read", { path: file }, baseContext));

        expect(result).toBe(fs.readFileSync(file, "utf8"));
        expect(result).not.toContain(TRUNCATION_MARKER);
      },
    );
  });

  it("delivers exactly the requested offset and limit window", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(
          path.join(dir, "big.txt"),
          `${Array.from({ length: 5000 }, (_, index) => `L${String(index + 1).padStart(5, "0")}`).join("\n")}\n`,
        );
      },
      async (registry, dir) => {
        const result = String(
          await registry.invoke("omp.read", { path: path.join(dir, "big.txt"), offset: 4900, limit: 50 }, baseContext),
        );
        const lines = result.split("\n").filter((line) => line.length > 0);

        expect(lines).toHaveLength(50);
        expect(lines[0]).toBe("L04900");
        expect(lines.at(-1)).toBe("L04949");
      },
    );
  });

  it("honours an explicit read limit above the host cap", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(
          path.join(dir, "big.txt"),
          `${Array.from({ length: 9000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
        );
      },
      async (registry, dir) => {
        const result = String(
          await registry.invoke("omp.read", { path: path.join(dir, "big.txt"), limit: 5000 }, baseContext),
        );
        const lines = result.split("\n").filter((line) => line.length > 0);

        expect(lines).toHaveLength(5000);
        expect(lines.at(-1)).toBe("line 5000");
      },
    );
  });

  it("leaves a complete read byte-faithful and unmarked", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(
          path.join(dir, "small.txt"),
          `${Array.from({ length: 2999 }, (_, index) => `k${index + 1}`).join("\n")}\n`,
        );
      },
      async (registry, dir) => {
        const file = path.join(dir, "small.txt");
        const result = String(await registry.invoke("omp.read", { path: file }, baseContext));

        expect(result).toBe(fs.readFileSync(file, "utf8"));
        expect(result).not.toContain(TRUNCATION_MARKER);
      },
    );
  });

  it("marks a read cut short by the guest result bound and offers a working continuation", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(
          path.join(dir, "big.txt"),
          `${Array.from({ length: 9000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
        );
      },
      async (registry, dir) => {
        const first = String(await registry.invoke("omp.read", { path: path.join(dir, "big.txt") }, baseContext));
        const marker = parseMarker(first);

        expect(marker).toMatchObject({ tool: "read", partial: true, reasons: ["resultBudget"] });
        expect(typeof marker?.continue).toBe("string");

        const rest = String(await registry.invoke("omp.read", { path: marker?.continue }, {
          ...baseContext,
          maxResultChars: 5_000_000,
        }));

        expect(rest).toContain("line 9000");
        expect(rest).not.toContain(TRUNCATION_MARKER);
      },
      40_000,
    );
  });

  it("keeps repeated reads of an unchanged file byte-identical", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "stable.txt"), "alpha\nbeta\ngamma\n");
      },
      async (registry, dir) => {
        const file = path.join(dir, "stable.txt");
        const expected = fs.readFileSync(file, "utf8");

        for (let attempt = 0; attempt < 5; attempt++) {
          const result = String(await registry.invoke("omp.read", { path: file }, baseContext));
          expect(result).toBe(expected);
        }
      },
    );
  });

  it("marks a read that lost bytes to an oversized single line", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "one.txt"), "x".repeat(3_000_000));
      },
      async (registry, dir) => {
        const result = String(await registry.invoke("omp.read", { path: path.join(dir, "one.txt") }, baseContext));
        const marker = parseMarker(result);

        expect(marker).toMatchObject({ tool: "read", reasons: ["byteBudget"], totalBytes: 3_000_000, continue: null });
        expect(Number(marker?.deliveredBytes)).toBeLessThan(3_000_000);
      },
    );
  });

  it("rejects a binary read instead of returning its notice as content", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
      },
      async (registry, dir) => {
        const file = path.join(dir, "blob.bin");
        await expect(registry.invoke("omp.read", { path: file }, baseContext)).rejects.toThrow(
          `omp.read returned no text content: [Cannot read binary file 'blob.bin' (7B); not valid UTF-8 text. Use ':raw' to read bytes verbatim.] Read the bytes with omp.read("${file}:raw").`,
        );

        const raw = String(await registry.invoke("omp.read", { path: `${file}:raw` }, baseContext));
        expect(raw.length).toBeGreaterThan(0);

        const document = path.join(dir, "broken.pdf");
        fs.writeFileSync(document, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00]));
        await expect(registry.invoke("omp.read", { path: document }, baseContext)).rejects.toThrow(
          /^omp\.read returned no text content: \[Cannot read \.pdf file: /,
        );

        const image = path.join(dir, "px.png");
        fs.writeFileSync(
          image,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
          ),
        );
        expect(String(await registry.invoke("omp.read", { path: image }, baseContext))).toContain("Read image file");
      },
    );
  });

  it("marks a grep whose per-file match cap and column cap dropped data", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "many.txt"), Array.from({ length: 5000 }, () => "MATCHME").join("\n"));
        fs.writeFileSync(path.join(dir, "wide.txt"), `${"a".repeat(900)}NEEDLE\n`);
      },
      async (registry, dir) => {
        const many = String(
          await registry.invoke("omp.grep", { pattern: "MATCHME", path: path.join(dir, "many.txt") }, baseContext),
        );
        expect(parseMarker(many)).toMatchObject({
          tool: "grep",
          partial: true,
          reasons: ["matchLimit"],
          perFileMatchLimit: 200,
        });

        const wide = String(
          await registry.invoke("omp.grep", { pattern: "NEEDLE", path: path.join(dir, "wide.txt") }, baseContext),
        );
        expect(wide).not.toContain("NEEDLE");
        expect(parseMarker(wide)).toMatchObject({ tool: "grep", reasons: ["columnLimit"], maxColumn: 512 });
      },
    );
  });

  it("leaves a complete grep and find unmarked", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "one.txt"), "MATCHME\n");
      },
      async (registry, dir) => {
        const grep = String(await registry.invoke("omp.grep", { pattern: "MATCHME", path: dir }, baseContext));
        const find = String(await registry.invoke("omp.find", { pattern: "*.txt", path: dir }, baseContext));

        expect(grep).not.toContain(TRUNCATION_MARKER);
        expect(find).not.toContain(TRUNCATION_MARKER);
      },
    );
  });

  it("marks a find clamped by the host result cap", async () => {
    await withFixtures(
      (dir) => {
        for (let index = 0; index < 260; index++) fs.writeFileSync(path.join(dir, `f${index}.txt`), "x");
      },
      async (registry, dir) => {
        const result = String(
          await registry.invoke("omp.find", { pattern: "*.txt", path: dir, limit: 3000 }, baseContext),
        );

        expect(parseMarker(result)).toMatchObject({ tool: "find", partial: true, reasons: ["resultLimit"], resultLimit: 200 });
      },
    );
  });

  it("forwards grep skip to the underlying tool", async () => {
    await withFixtures(
      (dir) => {
        fs.writeFileSync(path.join(dir, "a.txt"), "MATCHME\n");
      },
      async (registry, dir) => {
        const result = String(
          await registry.invoke("omp.grep", { pattern: "MATCHME", path: dir, skip: 5 }, baseContext),
        );

        expect(result).toContain("skip=5 is past the end");
      },
    );
  });

  it("serves the full bash output when only the host column cap cut it", async () => {
    await withFixtures(
      () => {},
      async (registry) => {
        const result = (await registry.invoke(
          "omp.bash",
          { command: "head -c 200000 /dev/zero | tr '\\0' 'Q'; echo" },
          baseContext,
        )) as { output: string; details: Record<string, unknown> };

        expect(result.output.trimEnd()).toHaveLength(200_000);
        expect(result.details).toMatchObject({ columnTruncated: { maxColumn: 768, restored: true } });
      },
    );
  });

  it("clears the stale host column limit once the full bash output is restored", async () => {
    await withFixtures(
      () => {},
      async (registry) => {
        const result = (await registry.invoke(
          "omp.bash",
          { command: "head -c 200000 /dev/zero | tr '\\0' 'Q'; echo" },
          baseContext,
        )) as { output: string; details: Record<string, unknown> };

        expect(result.details).toMatchObject({ columnTruncated: { restored: true } });
        expect(result.output).not.toContain(TRUNCATION_MARKER);
        const meta = result.details.meta as { limits?: Record<string, unknown> } | undefined;
        expect(meta?.limits?.columnTruncated).toBeUndefined();
      },
    );
  });

  it("marks bash output the host budget elided and leaves complete output unmarked", async () => {
    await withFixtures(
      () => {},
      async (registry) => {
        const big = (await registry.invoke(
          "omp.bash",
          { command: "seq 1 40000 | sed 's/^/row-/'" },
          baseContext,
        )) as { output: string; details: Record<string, unknown> };
        const marker = parseMarker(big.output);

        expect(marker).toMatchObject({ tool: "bash", partial: true });
        expect((marker?.reasons as string[])[0]).toBe("outputLimit");
        expect(big.output.trimEnd().endsWith("}")).toBe(true);
        expect(typeof big.details.fullOutputPath).toBe("string");
        expect(fs.readFileSync(String(big.details.fullOutputPath), "utf8")).toContain("row-40000\n");

        const small = (await registry.invoke("omp.bash", { command: "echo done" }, baseContext)) as {
          output: string;
        };
        expect(small.output).not.toContain(TRUNCATION_MARKER);
      },
    );
  });

  it("keeps bash alive when the artifact root disappeared mid-session", async () => {
    const artifactRoots = () =>
      new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("omp-fabric-bash-")));
    const before = artifactRoots();
    const registry = new ActionRegistry();
    registry.register(new OmpToolsProvider(os.tmpdir(), undefined, undefined));
    const owned = [...artifactRoots()].filter((entry) => !before.has(entry));

    expect(owned).toHaveLength(1);
    for (const entry of owned) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });

    const result = (await registry.invoke("omp.bash", { command: "echo survived" }, baseContext)) as {
      output: string;
    };

    expect(result.output.trim()).toBe("survived");
    expect(fs.existsSync(path.join(os.tmpdir(), owned[0] as string))).toBe(true);
    for (const entry of owned) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
  });
});

