// Adapted from pi-code-previews with Fabric result isolation; see THIRD_PARTY_NOTICES.md.
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { MAX_WRITE_DIFF_BYTES, writeContentForPreview } from "./write-diff-limits.js";

const mutationQueues = new Map<string, Promise<void>>();

const withFileMutationQueue = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationQueues.set(path, current);
  await previous;
  try { return await operation(); } finally { release(); if (mutationQueues.get(path) === current) mutationQueues.delete(path); }
};

type ExistingFilePreview =
  | { kind: "content"; content: string }
  | {
      kind: "skipped";
      reason: string;
      byteLength?: number;
      maxBytes: number;
      sizeExceeded?: boolean;
    };

const URI_LIKE_WRITE_TARGET_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}/i;

class OmpWriteUriTargetError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "OmpWriteUriTargetError";
    this.path = path;
  }
}

const assertFilesystemWriteTarget = (candidate: string, reported: string): void => {
  const trimmed = candidate.trim();
  if (win32.isAbsolute(trimmed)) return;
  const scheme = URI_LIKE_WRITE_TARGET_RE.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === undefined) return;
  const guidance = scheme === "xd"
    ? "Tool devices are dispatched by the top-level `write` tool, which carries the xd:// transport; omp.write writes files."
    : "omp.write resolves filesystem paths only.";
  throw new OmpWriteUriTargetError(
    `Refusing to write '${reported}': '${scheme}://' is a URI scheme, not a directory. ${guidance} Prefix the path with './' to create a literal file by that name.`,
    reported,
  );
};

const resolvePreviewPath = (filePath: string, cwd: string): string => {
  let expanded = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  expanded = expanded.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  assertFilesystemWriteTarget(expanded, filePath);
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = homedir() + expanded.slice(1);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

const skipped = (
  reason: string,
  byteLength: number | undefined,
  sizeExceeded = false,
): ExistingFilePreview => ({
  kind: "skipped",
  reason,
  ...(byteLength !== undefined ? { byteLength } : {}),
  maxBytes: MAX_WRITE_DIFF_BYTES,
  ...(sizeExceeded ? { sizeExceeded: true } : {}),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const readExistingFileForPreview = async (
  filePath: string,
  cwd: string,
  nextContent: string,
): Promise<ExistingFilePreview | undefined> => {
  const absolutePath = resolvePreviewPath(filePath, cwd);
  const nextBytes = Buffer.byteLength(nextContent, "utf8");
  if (writeContentForPreview(nextContent) === undefined) {
    return skipped("new content too large", nextBytes, true);
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    return isMissing(error) ? undefined : skipped("previous content unavailable", undefined);
  }
  if (!fileStat.isFile()) return skipped("previous path is not a regular file", fileStat.size);
  if (fileStat.size > MAX_WRITE_DIFF_BYTES) {
    return skipped("previous file too large", fileStat.size, true);
  }
  try {
    const content = await readFile(absolutePath, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return bytes > MAX_WRITE_DIFF_BYTES
      ? skipped("previous file too large", bytes, true)
      : { kind: "content", content };
  } catch {
    return skipped("previous content unavailable", fileStat.size);
  }
};

export const createPreviewWriteToolDefinition = (
  cwd: string,
): ToolDefinition => {
  const original = {
    name: "write", label: "Write", description: "Write a file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
  } as unknown as ToolDefinition;
  return {
    ...original,
    async execute(
      _toolCallId: string,
      params: { path: string; content: string },
      signal: AbortSignal | undefined,
    ) {
      const { path, content } = params;
      const absolutePath = resolvePreviewPath(path, cwd);
      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();
        const before = await readExistingFileForPreview(path, cwd, content);
        throwIfAborted();
        await mkdir(dirname(absolutePath), { recursive: true });
        throwIfAborted();
        await writeFile(absolutePath, content, "utf8");
        throwIfAborted();
        return {
          content: [
              {
                type: "text" as const,
                text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
              },
            ],
          details: { codePreviewBeforeWrite: before },
        };
      });
    },
  } as unknown as ToolDefinition;
};
