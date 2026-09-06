import type { CatalogRepair, RepairClassification, RepairStage } from "./types.js";

const TYPECHECK_HEAD = /type error|type checking failed/i;
const INVALID_ARGS = /Invalid arguments for ([^:]+):\s*(.*)/s;
const UNKNOWN_ACTION = /Unknown Fabric action:\s*(\S+)/i;
const VALIDATION_FAILED = /Validation failed for tool\s+"?fabric_exec"?/i;
const EXACT_TEXT = /could not find the exact text|Could not find edits\[/i;
const RUNTIME_HEAD = /^Runtime error/i;
const ENOENT = /ENOENT|no such file|Path not found/i;
const ARITY = /Expected ([0-9]+)(?:-[0-9]+)? arguments, but got ([0-9]+)/;
const CANNOT_FIND = /Cannot find name '([^']+)'/;
const DISPLAY_OBJECT = /display: must be object/i;
const PAYLOADS_OBJECT = /payloads: must be object/i;
const CODE_REQUIRED = /code: must have required properties/i;

const SHELL_OR_PROSE_NAMES = new Set([
  "$",
  "PY",
  "a",
  "and",
  "bash",
  "data",
  "do",
  "document",
  "done",
  "e",
  "echo",
  "f",
  "fi",
  "for",
  "i",
  "if",
  "in",
  "k",
  "len",
  "m",
  "n",
  "name",
  "open",
  "out",
  "p",
  "path",
  "printf",
  "r",
  "s",
  "sh",
  "t",
  "text",
  "the",
  "then",
  "tmp",
  "while",
  "x",
]);

const firstText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return firstText((content as { content?: unknown }).content);
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
};

const extraKeysFromMessage = (message: string): string[] => {
  const keys: string[] = [];
  for (const match of message.matchAll(
    /\/([A-Za-z_][\w$]*): must not have additional properties/g,
  )) {
    const key = match[1];
    if (key) keys.push(key);
  }
  return keys;
};

export const classifyInvalidArgs = (
  ref: string,
  message: string,
  extraKeys: readonly string[] = extraKeysFromMessage(message),
): RepairClassification => {
  const key = extraKeys[0];
  return {
    stage: "invocation_args",
    fingerprint: key ? `args:${ref}:${key}` : `args:${ref}:${message.slice(0, 80)}`,
  };
};

export const classifyUnknownAction = (ref: string): RepairClassification => {
  const trimmed = ref.replace(/[,)]+$/, "").trim();
  return {
    stage: "invocation_unknown_action",
    fingerprint: `unknown:${trimmed}`,
  };
};

export const classifyTypeErrors = (
  messages: readonly string[],
  enclosingTool?: string,
): RepairClassification[] => {
  const out: RepairClassification[] = [];
  const seen = new Set<string>();
  const push = (entry: RepairClassification) => {
    if (seen.has(entry.fingerprint)) return;
    seen.add(entry.fingerprint);
    out.push(entry);
  };
  for (const message of messages) {
    const arity = ARITY.exec(message);
    if (arity) {
      const expected = Number(arity[1]);
      const got = Number(arity[2]);
      if (got > expected) {
        push({
          stage: "invocation_typecheck",
          fingerprint: enclosingTool
            ? `typecheck:arity:${expected}<-${got}:${enclosingTool}`
            : `typecheck:arity:${expected}<-${got}`,
        });
        continue;
      }
    }
    const missing = CANNOT_FIND.exec(message);
    if (missing?.[1] && SHELL_OR_PROSE_NAMES.has(missing[1])) {
      push({
        stage: "didactic",
        fingerprint: `didactic:cannot_find:${missing[1]}`,
      });
      continue;
    }
    if (missing?.[1]) {
      push({
        stage: "invocation_typecheck",
        fingerprint: `typecheck:cannot_find:${missing[1]}`,
      });
      continue;
    }
    push({
      stage: "invocation_typecheck",
      fingerprint: `typecheck:${message.slice(0, 80)}`,
    });
  }
  return out.length > 0
    ? out
    : [{ stage: "invocation_typecheck", fingerprint: "typecheck:unparsed" }];
};

export const classifyToolResult = (input: {
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}): RepairClassification | undefined => {
  if (!input.isError) return undefined;
  const text = firstText(input.content);
  const head = text.slice(0, 400);
  const tool = input.toolName ?? "?";

  if (VALIDATION_FAILED.test(head)) {
    if (DISPLAY_OBJECT.test(text)) {
      return { stage: "invocation_outer_schema", fingerprint: "outer:display:object" };
    }
    if (PAYLOADS_OBJECT.test(text)) {
      return { stage: "invocation_outer_schema", fingerprint: "outer:payloads:object" };
    }
    if (CODE_REQUIRED.test(text)) {
      return { stage: "didactic", fingerprint: "outer:code:required" };
    }
    return { stage: "invocation_outer_schema", fingerprint: "outer:unparsed" };
  }
  if (TYPECHECK_HEAD.test(head)) {
    const lines = text
      .split("\n")
      .map((line) => line.replace(/^Line \d+:\d+ — /, "").trim())
      .filter((line) => line.length > 0 && !/^Type errors?;? code was not executed:?$/i.test(line));
    return classifyTypeErrors(lines)[0];
  }
  const invalid = INVALID_ARGS.exec(text);
  if (invalid?.[1]) return classifyInvalidArgs(invalid[1].trim(), invalid[2] ?? "");
  const unknown = UNKNOWN_ACTION.exec(text);
  if (unknown?.[1]) return classifyUnknownAction(unknown[1]);
  if (EXACT_TEXT.test(text)) return { stage: "effect", fingerprint: `effect:edit_miss:${tool}` };
  if (["bash", "omp.bash"].includes(tool)) {
    return { stage: "effect", fingerprint: "effect:bash" };
  }
  if (["read", "write", "edit", "grep", "find", "ls"].includes(tool)) {
    return { stage: "effect", fingerprint: `effect:native:${tool}` };
  }
  if (ENOENT.test(text) || RUNTIME_HEAD.test(head)) {
    return { stage: "effect", fingerprint: `effect:runtime:${tool}` };
  }
  return { stage: "didactic", fingerprint: `other:${tool}` };
};

