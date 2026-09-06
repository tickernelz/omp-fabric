import fs from "node:fs";
import path from "node:path";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { highlightCode, highlightFileLines, languageFromPath } from "./highlight.js";
import { safeText } from "./format.js";
import type { FabricUiStateEntry } from "./types.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILE_LINES = 240;
const CACHE_LIMIT = 64;

export interface FabricStateFilePreview {
  path: string;
  absolutePath: string;
  language: string;
  content: string;
  lines: string[];
  truncated: boolean;
}

const cache = new Map<string, FabricStateFilePreview>();

const candidatePath = (entry: FabricUiStateEntry): string | undefined => {
  const value = entry.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const candidate = record.file ?? record.path;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return entry.key.startsWith("state/complexity/")
    ? entry.key.slice("state/complexity/".length)
    : undefined;
};

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};

export const loadStateFilePreview = (
  entry: FabricUiStateEntry,
  cwd: string,
): FabricStateFilePreview | undefined => {
  const candidate = candidatePath(entry);
  if (!candidate || path.isAbsolute(candidate) || !cwd) return undefined;
  try {
    const root = fs.realpathSync(cwd);
    const absolute = fs.realpathSync(path.resolve(root, candidate));
    if (!inside(root, absolute)) return undefined;
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return undefined;
    const cacheKey = `${absolute}\0${stat.mtimeMs}\0${stat.size}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }
    const bytes = Math.min(stat.size, MAX_FILE_BYTES);
    const descriptor = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(bytes);
    try {
      if (bytes > 0) fs.readSync(descriptor, buffer, 0, bytes, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (buffer.includes(0)) return undefined;
    const decoded = buffer.toString("utf8").replace(/\r\n?/g, "\n");
    const allLines = decoded.split("\n");
    const boundedLines = allLines.slice(0, MAX_FILE_LINES);
    const preview: FabricStateFilePreview = {
      path: (path.relative(root, absolute) || path.basename(absolute)).split(path.sep).join("/"),
      absolutePath: absolute,
      language: languageFromPath(absolute) ?? "text",
      content: boundedLines.join("\n"),
      lines: boundedLines,
      truncated: stat.size > bytes || allLines.length > boundedLines.length,
    };
    cache.set(cacheKey, preview);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return preview;
  } catch {
    return undefined;
  }
};

export const renderStateFilePreview = (
  preview: FabricStateFilePreview,
  theme: Theme,
  width: number,
  maxLines: number,
  invalidate?: () => void,
): string[] => {
  if (width <= 0 || maxLines <= 0) return [];
  const shown = preview.lines.slice(0, maxLines);
  // Prefer the file's tokenization coverage so long comments/strings opened
  // near the top highlight state-correctly even in short excerpts.
  const fileLines = highlightFileLines(
    preview.absolutePath,
    preview.language,
    0,
    shown.length,
    invalidate,
  );
  const fileVerified =
    fileLines !== null &&
    fileLines.every((line, index) => line.raw === (shown[index] ?? "").replace(/\t/g, "    "));
  const highlighted = fileVerified
    ? fileLines!.map((line) => line.ansi || " ")
    : highlightCode(shown.join("\n"), preview.language, invalidate) ??
      shown.map((line) => theme.fg("mdCodeBlock", safeText(line) || " "));
  const digits = String(Math.max(1, shown.length)).length;
  const output = highlighted.map((line, index) => {
    const gutter = theme.fg("dim", `${String(index + 1).padStart(digits)} │ `);
    return truncateToWidth(gutter + line, width, "");
  });
  if ((preview.truncated || preview.lines.length > shown.length) && output.length < maxLines) {
    const omitted = Math.max(0, preview.lines.length - shown.length);
    const label = omitted > 0 ? `… ${omitted}+ lines omitted` : "… file truncated";
    output.push(truncateToWidth(theme.fg("dim", label), width, ""));
  }
  return output.filter((line) => visibleWidth(line) <= width);
};
