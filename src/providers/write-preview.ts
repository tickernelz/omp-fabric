// Adapted from pi-code-previews with Fabric result isolation; see THIRD_PARTY_NOTICES.md.
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolSession } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
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

const uriLikeScheme = (candidate: string): string | undefined => {
  const trimmed = candidate.trim();
  if (win32.isAbsolute(trimmed)) return undefined;
  return URI_LIKE_WRITE_TARGET_RE.exec(trimmed)?.[1]?.toLowerCase();
};

const isUriLikeWriteTarget = (filePath: string): boolean => {
  const expanded = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  return uriLikeScheme(expanded.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")) !== undefined;
};

const resolvePreviewPath = (filePath: string, cwd: string): string => {
  let expanded = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  expanded = expanded.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
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
  session?: ToolSession,
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
      if (isUriLikeWriteTarget(path)) {
        if (session === undefined) {
          throw new Error(
            `Refusing to write '${path}': URI-like targets need a host session to resolve. Prefix the path with './' to create a literal file by that name.`,
          );
        }
        return await new WriteTool(session).execute(
          _toolCallId,
          params as never,
          signal as never,
          (() => {}) as never,
          { signal } as never,
        );
      }
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
