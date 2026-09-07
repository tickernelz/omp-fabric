import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { throwIfAborted } from "../async-settlement.js";
import type { CodeSymbol, CodeSymbolKind, SymbolIndex, SymbolIndexRequest } from "./types.js";

const execFileAsync = promisify(execFile);

interface AstMatch {
  path: string;
  text: string;
  startLine: number;
  metaVariables?: Record<string, string>;
}

interface AstFindResult {
  matches: AstMatch[];
  limitReached: boolean;
}

interface AstFindOptions {
  patterns: string[];
  lang: string;
  path: string;
  glob: string;
  includeMeta: boolean;
  limit: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const commonDirectory = (files: string[]): string => {
  let prefix: string[] | undefined;
  for (const file of files) {
    const parts = file.split("/");
    parts.pop();
    if (prefix === undefined) {
      prefix = parts;
      continue;
    }
    let shared = 0;
    while (shared < prefix.length && shared < parts.length && prefix[shared] === parts[shared]) shared++;
    prefix.length = shared;
    if (shared === 0) return "";
  }
  return prefix === undefined ? "" : prefix.join("/");
};

interface SummarySegment {
  kind: string;
  startLine: number;
  text?: string;
}

interface SummaryOutcome {
  segments: SummarySegment[];
}

interface SummaryInput {
  code: string;
  path: string;
  unfoldUntilLines: number;
}

interface CodeNatives {
  astGrep: (options: AstFindOptions) => Promise<AstFindResult>;
  summarizeCode: (options: SummaryInput) => SummaryOutcome;
}

const importBundledNatives = async (): Promise<CodeNatives | undefined> => {
  try {
    const bundled = (await import("@oh-my-pi/pi-natives")) as unknown as Partial<CodeNatives>;
    return typeof bundled.astGrep === "function" ? (bundled as CodeNatives) : undefined;
  } catch {
    return undefined;
  }
};

const importPlatformNatives = (): CodeNatives => {
  const load = createRequire(import.meta.url);
  return load(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`) as CodeNatives;
};

let nativesOnce: Promise<CodeNatives> | undefined;

const codeNatives = (): Promise<CodeNatives> => {
  nativesOnce ??= importBundledNatives().then((bundled) => bundled ?? importPlatformNatives());
  return nativesOnce;
};

interface Classification {
  kind: CodeSymbolKind;
  exported: boolean;
}

type Classifier = (text: string, meta: Record<string, string> | undefined) => Classification;

interface LanguageSpec {
  id: string;
  lang: string;
  extensions: string[];
  glob: string;
  patterns: string[];
  classify: Classifier;
}

const SCRIPT_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\b/;
const ARROW_VALUE = /^(?:async\s*)?[(<]/;

const classifyScript: Classifier = (text, meta) => {
  const exported = text.startsWith("export");
  const declaration = SCRIPT_DECLARATION.exec(text);
  switch (declaration?.[1]) {
    case "function":
      return { kind: "fn", exported };
    case "class":
      return { kind: "class", exported };
    case "interface":
      return { kind: "iface", exported };
    case "type":
      return { kind: "type", exported };
    case "enum":
      return { kind: "enum", exported };
    default: {
      const value = meta?.V;
      if (value === undefined) return { kind: "fn", exported };
      const arrow = ARROW_VALUE.test(value) && value.includes("=>");
      return { kind: arrow ? "fn" : "const", exported };
    }
  }
};

const SCRIPT_VALUE_PATTERNS = [
  "function $NAME($$$A) { $$$B }",
  "export function $NAME($$$A) { $$$B }",
  "export default function $NAME($$$A) { $$$B }",
  "class $NAME { $$$B }",
  "export class $NAME { $$$B }",
  "export default class $NAME { $$$B }",
  "const $NAME = ($$$A) => $B",
  "const $NAME = $V",
  "export const $NAME = $V",
];

const TYPED_SCRIPT_PATTERNS = [
  ...SCRIPT_VALUE_PATTERNS,
  "interface $NAME { $$$B }",
  "export interface $NAME { $$$B }",
  "type $NAME = $V",
  "export type $NAME = $V",
  "enum $NAME { $$$B }",
  "export enum $NAME { $$$B }",
];

const PYTHON_DEFINITION = /^(?:async\s+)?def\b/;
const PYTHON_CLASS = /^class\b/;

const classifyPython: Classifier = (text) => {
  if (PYTHON_DEFINITION.test(text)) return { kind: "fn", exported: true };
  if (PYTHON_CLASS.test(text)) return { kind: "class", exported: true };
  return { kind: "const", exported: true };
};

const GO_METHOD = /^func\s*\(/;
const GO_FUNCTION = /^func\b/;
const GO_STRUCT = /^type\s+\w+\s+struct\b/;
const GO_INTERFACE = /^type\s+\w+\s+interface\b/;
const GO_TYPE = /^type\b/;

const classifyGo: Classifier = (text) => {
  if (GO_METHOD.test(text)) return { kind: "method", exported: true };
  if (GO_FUNCTION.test(text)) return { kind: "fn", exported: true };
  if (GO_STRUCT.test(text)) return { kind: "class", exported: true };
  if (GO_INTERFACE.test(text)) return { kind: "iface", exported: true };
  if (GO_TYPE.test(text)) return { kind: "type", exported: true };
  return { kind: "const", exported: true };
};

const RUST_KEYWORD = /^(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|const|static)\b/;

const classifyRust: Classifier = (text) => {
  const exported = text.startsWith("pub");
  switch (RUST_KEYWORD.exec(text)?.[1]) {
    case "fn":
      return { kind: "fn", exported };
    case "struct":
      return { kind: "class", exported };
    case "enum":
      return { kind: "enum", exported };
    case "trait":
      return { kind: "iface", exported };
    case "type":
      return { kind: "type", exported };
    default:
      return { kind: "const", exported };
  }
};

const JAVA_KEYWORD =
  /^(?:(?:public|private|protected|static|final|abstract|synchronized|native|strictfp)\s+)*(class|interface|enum|record)\b/;

const classifyJava: Classifier = (text) => {
  const exported = text.startsWith("public");
  switch (JAVA_KEYWORD.exec(text)?.[1]) {
    case "class":
    case "record":
      return { kind: "class", exported };
    case "interface":
      return { kind: "iface", exported };
    case "enum":
      return { kind: "enum", exported };
    default:
      return { kind: "method", exported };
  }
};

const globFor = (extensions: string[]): string =>
  extensions.length === 1 ? `**/*.${extensions[0]}` : `**/*.{${extensions.join(",")}}`;

const defineSpec = (
  id: string,
  lang: string,
  extensions: string[],
  patterns: string[],
  classify: Classifier,
): LanguageSpec => ({ id, lang, extensions, glob: globFor(extensions), patterns, classify });

const LANGUAGE_SPECS: LanguageSpec[] = [
  defineSpec("ts", "ts", ["ts", "mts", "cts"], TYPED_SCRIPT_PATTERNS, classifyScript),
  defineSpec("tsx", "tsx", ["tsx"], TYPED_SCRIPT_PATTERNS, classifyScript),
  defineSpec("js", "js", ["js", "mjs", "cjs", "jsx"], SCRIPT_VALUE_PATTERNS, classifyScript),
  defineSpec(
    "python",
    "python",
    ["py", "pyi"],
    [
      "def $NAME($$$A): $$$B",
      "class $NAME($$$A): $$$B",
      "class $NAME: $$$B",
      "$NAME = $V",
    ],
    classifyPython,
  ),
  defineSpec(
    "go",
    "go",
    ["go"],
    [
      "func $NAME($$$A) $$$R { $$$B }",
      "func ($$$RECV) $NAME($$$A) $$$R { $$$B }",
      "type $NAME struct { $$$B }",
      "type $NAME interface { $$$B }",
      "type $NAME = $V",
      "const $NAME = $V",
      "var $NAME = $V",
    ],
    classifyGo,
  ),
  defineSpec(
    "rust",
    "rust",
    ["rs"],
    [
      "fn $NAME($$$A) { $$$B }",
      "fn $NAME($$$A) -> $R { $$$B }",
      "pub fn $NAME($$$A) { $$$B }",
      "pub fn $NAME($$$A) -> $R { $$$B }",
      "struct $NAME { $$$B }",
      "pub struct $NAME { $$$B }",
      "enum $NAME { $$$B }",
      "pub enum $NAME { $$$B }",
      "trait $NAME { $$$B }",
      "pub trait $NAME { $$$B }",
      "type $NAME = $V;",
      "pub type $NAME = $V;",
      "const $NAME: $T = $V;",
      "pub const $NAME: $T = $V;",
      "static $NAME: $T = $V;",
      "pub static $NAME: $T = $V;",
    ],
    classifyRust,
  ),
  defineSpec(
    "java",
    "java",
    ["java"],
    [
      "class $NAME { $$$B }",
      "public class $NAME { $$$B }",
      "interface $NAME { $$$B }",
      "public interface $NAME { $$$B }",
      "enum $NAME { $$$B }",
      "public enum $NAME { $$$B }",
      "$RET $NAME($$$A) { $$$B }",
      "public $RET $NAME($$$A) { $$$B }",
      "private $RET $NAME($$$A) { $$$B }",
      "protected $RET $NAME($$$A) { $$$B }",
      "public static $RET $NAME($$$A) { $$$B }",
      "static $RET $NAME($$$A) { $$$B }",
    ],
    classifyJava,
  ),
];

const EXTENSION_SPECS = new Map<string, LanguageSpec>();
for (const spec of LANGUAGE_SPECS) {
  for (const extension of spec.extensions) EXTENSION_SPECS.set(extension, spec);
}

const FALLBACK_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "cxx",
  "dart",
  "elm",
  "erl",
  "ex",
  "exs",
  "groovy",
  "h",
  "hh",
  "hpp",
  "hs",
  "jl",
  "kt",
  "kts",
  "lua",
  "nim",
  "php",
  "pl",
  "pm",
  "proto",
  "rb",
  "scala",
  "sh",
  "sql",
  "svelte",
  "swift",
  "vue",
  "zig",
]);

const SKIP_DIRECTORIES = new Set(["node_modules", "dist"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const KIND_RANK: Record<CodeSymbolKind, number> = {
  method: 5,
  fn: 4,
  class: 3,
  iface: 3,
  enum: 3,
  type: 2,
  const: 1,
};

const MATCH_TIMEOUT_MS = 120_000;
const MAX_FALLBACK_BYTES = 2_000_000;

const extensionOf = (file: string): string | undefined => {
  const slash = file.lastIndexOf("/");
  const dot = file.lastIndexOf(".");
  if (dot <= slash + 1) return undefined;
  return file.slice(dot + 1).toLowerCase();
};

const indexableExtension = (file: string): string | undefined => {
  const extension = extensionOf(file);
  if (extension === undefined) return undefined;
  if (EXTENSION_SPECS.has(extension) || FALLBACK_EXTENSIONS.has(extension)) return extension;
  return undefined;
};

const GLOB_ESCAPE = /[.+^$()|[\]\\]/g;

const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i];
    if (character === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:[^/]*/)*";
        } else {
          source += ".*";
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "{") {
      braces += 1;
      source += "(?:";
      continue;
    }
    if (character === "}" && braces > 0) {
      braces -= 1;
      source += ")";
      continue;
    }
    if (character === "," && braces > 0) {
      source += "|";
      continue;
    }
    source += character?.replace(GLOB_ESCAPE, "\\$&") ?? "";
  }
  return new RegExp(`^${source}$`);
};

const GIT_LIST_TIMEOUT_MS = 20_000;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

const gitTrackedFiles = async (
  root: string,
  matcher: RegExp | undefined,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> => {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        maxBuffer: GIT_LIST_MAX_BUFFER,
        timeout: GIT_LIST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );
    stdout = result.stdout;
  } catch {
    return undefined;
  }
  const found: string[] = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    let end = stdout.indexOf("\u0000", cursor);
    if (end === -1) end = stdout.length;
    const relative = stdout.slice(cursor, end);
    cursor = end + 1;
    if (relative.length === 0) continue;
    if (relative.charCodeAt(0) === 46) continue;
    if (indexableExtension(relative) === undefined) continue;
    if (matcher !== undefined && !matcher.test(relative)) continue;
    let skipped = false;
    let segmentStart = 0;
    while (segmentStart < relative.length) {
      let segmentEnd = relative.indexOf("/", segmentStart);
      if (segmentEnd === -1) break;
      const segment = relative.slice(segmentStart, segmentEnd);
      if (segment.charCodeAt(0) === 46 || SKIP_DIRECTORIES.has(segment)) {
        skipped = true;
        break;
      }
      segmentStart = segmentEnd + 1;
    }
    if (!skipped) found.push(relative);
  }
  return found;
};

const walkFiles = async (
  root: string,
  matcher: RegExp | undefined,
  signal: AbortSignal | undefined,
  expired?: () => boolean,
): Promise<string[]> => {
  const found: string[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const directory = pending.pop() ?? "";
    throwIfAborted(signal);
    if (expired?.() === true) break;
    let entries;
    try {
      entries = await readdir(directory === "" ? root : path.join(root, directory), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.charCodeAt(0) === 46) continue;
      const relative = directory === "" ? name : `${directory}/${name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) pending.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (indexableExtension(relative) === undefined) continue;
      if (matcher !== undefined && !matcher.test(relative)) continue;
      found.push(relative);
    }
  }
  return found;
};

const discoverFiles = async (
  root: string,
  matcher: RegExp | undefined,
  signal: AbortSignal | undefined,
  expired?: () => boolean,
): Promise<string[]> =>
  await gitTrackedFiles(root, matcher, signal) ?? await walkFiles(root, matcher, signal, expired);

const COMMENT_HEAD = /^(?:\/\/|\/\*|\*|#|--|<!--|;|%)/;
const IMPORT_HEAD = /^(?:import|from|require|include|use|using|package|open|load|source)\b/;
const DECLARATION_HEAD =
  /^(?:export|pub|public|private|protected|internal|static|final|abstract|override|virtual|inline|async|unsafe|extern|shared|readonly|declare|local|def|defp|defmodule|defstruct|defmacro|class|module|namespace|record|object|data|struct|enum|union|interface|trait|protocol|actor|impl|extension|fn|func|function|sub|procedure|method|const|let|var|val|type|typedef|typealias|template|operator|constructor|init|property|event|signal|macro|task)\b/;
const ASSIGNMENT_HEAD = /^[A-Za-z_$][\w$]*\s*(?::[^=]*)?=[^=]/;
const EXPORTED_HEAD = /^(?:export|pub|public)\b/;
const IDENTIFIERS = /[A-Za-z_$][\w$]*/g;

const FALLBACK_KINDS = new Map<string, CodeSymbolKind>([
  ["class", "class"],
  ["module", "class"],
  ["namespace", "class"],
  ["record", "class"],
  ["object", "class"],
  ["struct", "class"],
  ["impl", "class"],
  ["actor", "class"],
  ["defmodule", "class"],
  ["defstruct", "class"],
  ["interface", "iface"],
  ["trait", "iface"],
  ["protocol", "iface"],
  ["enum", "enum"],
  ["union", "enum"],
  ["def", "fn"],
  ["defp", "fn"],
  ["defmacro", "fn"],
  ["fn", "fn"],
  ["func", "fn"],
  ["function", "fn"],
  ["sub", "fn"],
  ["procedure", "fn"],
  ["method", "method"],
  ["constructor", "method"],
  ["init", "method"],
  ["type", "type"],
  ["typedef", "type"],
  ["typealias", "type"],
]);

const FALLBACK_SKIP = new Set([
  ...FALLBACK_KINDS.keys(),
  "export",
  "pub",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "override",
  "virtual",
  "inline",
  "async",
  "unsafe",
  "extern",
  "shared",
  "readonly",
  "declare",
  "local",
  "extension",
  "template",
  "operator",
  "property",
  "event",
  "signal",
  "macro",
  "task",
  "const",
  "let",
  "var",
  "val",
  "auto",
  "new",
  "return",
  "self",
  "this",
  "void",
  "int",
  "long",
  "short",
  "byte",
  "char",
  "bool",
  "boolean",
  "float",
  "double",
  "string",
  "str",
  "unsigned",
  "signed",
  "size_t",
  "mut",
  "end",
  "do",
  "then",
  "begin",
  "where",
  "with",
  "as",
  "in",
  "of",
  "is",
  "not",
  "and",
  "or",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "match",
  "try",
  "catch",
  "throw",
  "throws",
  "extends",
  "implements",
]);

const fallbackSymbol = (
  file: string,
  line: string,
  lineNumber: number,
): CodeSymbol | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  if (COMMENT_HEAD.test(trimmed) || IMPORT_HEAD.test(trimmed)) return undefined;
  if (!DECLARATION_HEAD.test(trimmed) && !ASSIGNMENT_HEAD.test(trimmed)) return undefined;
  IDENTIFIERS.lastIndex = 0;
  let kind: CodeSymbolKind = "const";
  let name: string | undefined;
  for (let token = IDENTIFIERS.exec(trimmed); token !== null; token = IDENTIFIERS.exec(trimmed)) {
    const word = token[0];
    if (!FALLBACK_SKIP.has(word)) {
      name = word;
      break;
    }
    const mapped = FALLBACK_KINDS.get(word);
    if (mapped !== undefined && kind === "const") kind = mapped;
  }
  if (name === undefined || !IDENTIFIER.test(name)) return undefined;
  const exported = EXPORTED_HEAD.test(trimmed) || name.charCodeAt(0) !== 95;
  return { file, line: lineNumber, kind, name, exported };
};

const countLines = (code: string): number => {
  let lines = 1;
  for (let at = code.indexOf("\n"); at >= 0; at = code.indexOf("\n", at + 1)) lines += 1;
  return lines;
};

const record = (into: Map<string, CodeSymbol>, symbol: CodeSymbol): void => {
  const key = `${symbol.file}\u0000${symbol.line}\u0000${symbol.name}`;
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, symbol);
    return;
  }
  if (symbol.exported) existing.exported = true;
  if (KIND_RANK[symbol.kind] > KIND_RANK[existing.kind]) existing.kind = symbol.kind;
};

const toPosix = (value: string): string => (path.sep === "/" ? value : value.split(path.sep).join("/"));

const compareSymbols = (left: CodeSymbol, right: CodeSymbol): number => {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
};

export async function buildSymbolIndex(request: SymbolIndexRequest): Promise<SymbolIndex> {
  const startedAt = Date.now();
  const budgetMs = request.maxMs !== undefined && request.maxMs > 0 ? request.maxMs : undefined;
  const remainingMs = (): number | undefined =>
    budgetMs === undefined ? undefined : Math.max(0, budgetMs - (Date.now() - startedAt));
  const outOfTime = (): boolean => {
    const left = remainingMs();
    return left !== undefined && left <= 0;
  };
  const signal = request.signal;
  throwIfAborted(signal);
  const root = path.resolve(request.root);
  const matcher = request.glob === undefined ? undefined : globToRegExp(request.glob);
  const discovered = await discoverFiles(root, matcher, signal, outOfTime);
  discovered.sort();

  let truncated = outOfTime();
  let files = discovered;
  if (files.length > request.maxFiles) {
    files = discovered.slice(0, request.maxFiles);
    truncated = true;
  }

  const languages: Record<string, number> = {};
  const assigned = new Map<string, string>();
  const activeSpecs = new Set<string>();
  const fallbackFiles: string[] = [];
  for (const file of files) {
    const extension = indexableExtension(file);
    if (extension === undefined) continue;
    const spec = EXTENSION_SPECS.get(extension);
    const label = spec?.id ?? extension;
    languages[label] = (languages[label] ?? 0) + 1;
    if (spec === undefined) {
      fallbackFiles.push(file);
      continue;
    }
    assigned.set(file, spec.id);
    activeSpecs.add(spec.id);
  }

  const natives = await codeNatives();
  const collected = new Map<string, CodeSymbol>();
  const matchLimit = Math.max(4096, request.maxSymbols * 2);

  for (const spec of LANGUAGE_SPECS) {
    if (!activeSpecs.has(spec.id)) continue;
    throwIfAborted(signal);
    if (outOfTime()) {
      truncated = true;
      break;
    }
    const scoped: string[] = [];
    for (const [file, id] of assigned) if (id === spec.id) scoped.push(file);
    const prefix = commonDirectory(scoped);
    let result: AstFindResult;
    try {
      result = await natives.astGrep({
        patterns: spec.patterns,
        lang: spec.lang,
        path: prefix === "" ? root : path.join(root, prefix),
        glob: spec.glob,
        includeMeta: true,
        limit: matchLimit,
        timeoutMs: Math.min(MATCH_TIMEOUT_MS, remainingMs() ?? MATCH_TIMEOUT_MS),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throwIfAborted(signal);
      if (budgetMs === undefined) throw error;
      truncated = true;
      break;
    }
    if (result.limitReached) truncated = true;
    for (const match of result.matches) {
      const relative = toPosix(match.path);
      const file = prefix === "" ? relative : `${prefix}/${relative}`;
      if (assigned.get(file) !== spec.id) continue;
      const name = match.metaVariables?.NAME;
      if (name === undefined || !IDENTIFIER.test(name)) continue;
      const classification = spec.classify(match.text, match.metaVariables);
      record(collected, {
        file,
        line: match.startLine,
        kind: classification.kind,
        name,
        exported: classification.exported,
      });
    }
  }

  for (const file of fallbackFiles) {
    throwIfAborted(signal);
    if (outOfTime()) {
      truncated = true;
      break;
    }
    let code: string;
    try {
      code = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    if (code.length === 0 || code.length > MAX_FALLBACK_BYTES) continue;
    let summary: SummaryOutcome;
    try {
      summary = natives.summarizeCode({
        code,
        path: file,
        unfoldUntilLines: Math.max(64, countLines(code) >> 2),
      });
    } catch {
      continue;
    }
    for (const segment of summary.segments) {
      if (segment.kind !== "kept" || segment.text === undefined) continue;
      const lines = segment.text.split("\n");
      for (let offset = 0; offset < lines.length; offset += 1) {
        const symbol = fallbackSymbol(file, lines[offset] ?? "", segment.startLine + offset);
        if (symbol !== undefined) record(collected, symbol);
      }
    }
  }

  const symbols = [...collected.values()];
  symbols.sort(compareSymbols);
  if (symbols.length > request.maxSymbols) {
    symbols.length = request.maxSymbols;
    truncated = true;
  }

  return {
    root,
    symbols,
    files,
    languages,
    fallbackFiles,
    truncated,
    elapsedMs: Date.now() - startedAt,
  };
}
