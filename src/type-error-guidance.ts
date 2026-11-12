import type { FabricTypeError } from "./runtime/type-checker.js";
import {
  CORE_TOOL_NAMES,
  CORE_TOOL_PROPERTIES,
} from "./runtime/core-tool-properties.js";

const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i;
const PAYLOAD_CALL_PATTERN = /\bomp\.(?:edit|write)\s*\(/;
const UNQUOTED_PATH_HEAD =
  /\bomp\.(?:read|ls|write|edit)\(\s*(?:https?:\/\/|\/(?![/*])|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/;
const PROMISE_ALL_PATTERN = /\bPromise\.all\s*\(/;
const TEMPLATE_CALL_PATTERN = /\bomp\.(bash|write|edit)\(\s*(?:\{[^`]{0,80}?)?`/g;
const SHELL_EXPANSION_PATTERN = /^(?:[#!]|[A-Za-z_]\w*(?::|%|#|\/|\^|,|\[))/;
const TUPLE_ARITY_PATTERN = /Tuple type .* of length '[0-9]+' has no element at index '[0-9]+'/;
const MISSING_NAME_PATTERN = /^Cannot find name '([^']+)'/;
const UNKNOWN_PROPERTY_PATTERN = /'([^']+)' does not exist in type '([^']+)'/;
const OMP_CALL_PATTERN = /\bomp\.(\w+)\s*\(/g;

const FABRIC_EXEC_ARGUMENT_NOTES: Readonly<Record<string, string>> = {
  payloads:
    "Named values belong in the outer `fabric_exec` arguments, then become available inside code as payloads.key.",
  strings:
    "Named values belong in the outer `fabric_exec` arguments and become available inside code as omp.key (for example, strings.task becomes omp.task).",
  tokenBudget:
    "Budget arguments (`tokenBudget`, `agentBudget`) belong to the outer `fabric_exec` call, not inside code.",
  agentBudget:
    "Budget arguments (`tokenBudget`, `agentBudget`) belong to the outer `fabric_exec` call, not inside code.",
  display: "The `display` objective belongs to the outer `fabric_exec` call, not inside code.",
  resultFormat: "`resultFormat` belongs to the outer `fabric_exec` call, not inside code.",
};

const PROPERTY_NOTES: Readonly<Record<string, string>> = {
  settle:
    "`settle:true` settles nonzero shell exits into an `ok:false` envelope instead of rejecting; other `omp.*` calls reject failures normally.",
  timeout: "`timeout` is measured in seconds; `timeoutMs` is converted from milliseconds.",
};

// Shell options that stay unsupported (cwd is honored per call since #71).
const SHELL_OPTION_NOTES: Readonly<Record<string, string>> = {
  stdin:
    "OMP shell tools do not accept `stdin`. Write the content with `omp.write(path, content)`, then pass that path to the command or redirect the file into it.",
  env:
    "OMP 18.4.4 removed the bash tool's per-call `env`. Commands inherit the configured shell environment, so set variables inline (`FOO=1 command`) or `export` them inside the command string.",
};

const isCoreToolName = (name: string): name is (typeof CORE_TOOL_NAMES)[number] =>
  (CORE_TOOL_NAMES as readonly string[]).includes(name);

// The 2353 message names the checked type (e.g. 'OmpCommandArgument &
// OmpBashOptions'); strip alias suffixes to recover the called tool.
const toolFromTypeText = (typeText: string): string | undefined => {
  for (const match of typeText.matchAll(/\bOmp([A-Z]\w*)/g)) {
    const captured = match[1];
    if (captured === undefined) continue;
    const candidate = captured
      .replace(/(?:Compatibility)?(?:Argument|Options)$/, "")
      .toLowerCase();
    if (isCoreToolName(candidate)) return candidate;
  }
  return undefined;
};

// Fallback for messages naming only shared bags (e.g. 'OmpPathArgument'): find
// the `omp.<tool>(` call enclosing the error position. Type-checker lines are
// 1-based and preceded by the guest wrapper, so try both offsets.
const enclosingCoreTool = (code: string, error: FabricTypeError): string | undefined => {
  const lines = code.split("\n");
  for (const lineIndex of [error.line - 2, error.line - 1]) {
    if (lineIndex < 0 || lineIndex >= lines.length) continue;
    const offset =
      lines.slice(0, lineIndex).join("\n").length +
      (lineIndex > 0 ? 1 : 0) +
      Math.max(0, error.column - 1);
    OMP_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    let tool: string | undefined;
    while ((match = OMP_CALL_PATTERN.exec(code)) !== null && match.index < offset) {
      const called = match[1];
      if (called !== undefined && isCoreToolName(called)) tool = called;
    }
    if (tool !== undefined) return tool;
  }
  return undefined;
};

const unknownPropertyHint = (
  property: string,
  tool: string | undefined,
): string | undefined => {
  if (tool === undefined) return undefined;
  if (tool === "bash") {
    const shellNote = SHELL_OPTION_NOTES[property];
    if (shellNote !== undefined) return `Recovery hint: ${shellNote}`;
  }
  const envelopeNote = FABRIC_EXEC_ARGUMENT_NOTES[property];
  if (envelopeNote !== undefined) {
    return `Recovery hint: \`${property}\` is a \`fabric_exec\` argument, not a \`omp.${tool}\` property. ${envelopeNote}`;
  }
  const ownerTools = CORE_TOOL_PROPERTIES.get(property);
  if (ownerTools === undefined || ownerTools.includes(tool as never)) return undefined;
  const owners = ownerTools.map((owner) => `\`omp.${owner}\``).join(", ");
  const note = PROPERTY_NOTES[property];
  return `Recovery hint: \`${property}\` is not a \`omp.${tool}\` property \u2014 it belongs to ${owners}.${note ? ` ${note}` : ""}`;
};

const hasLiteralPayloadInterpolation = (
  code: string,
  errors: FabricTypeError[],
): boolean => {
  if (!PAYLOAD_CALL_PATTERN.test(code)) return false;
  return errors.some((error) => {
    const name = MISSING_NAME_PATTERN.exec(error.message)?.[1];
    return name !== undefined && code.includes(`\${${name}}`);
  });
};

const codeOffset = (code: string, line: number, column: number): number => {
  const lines = code.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) offset += lines[index]!.length + 1;
  return offset + Math.max(0, column - 1);
};

const codePosition = (code: string, offset: number): string => {
  const before = code.slice(0, offset).split("\n");
  return `line ${before.length}:${before[before.length - 1]!.length + 1}`;
};

const substitutionEnd = (code: string, start: number): number => {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length;
};

const brokenTemplateHint = (code: string, errors: FabricTypeError[]): string | undefined => {
  const first = errors.find((error) => error.line > 0 && SYNTAX_ERROR_PATTERN.test(error.message));
  if (!first) return undefined;
  const errorOffset = codeOffset(code, first.line, first.column);
  let opening: RegExpExecArray | undefined;
  for (const match of code.matchAll(TEMPLATE_CALL_PATTERN)) {
    if (match.index + match[0].length > errorOffset) break;
    opening = match;
  }
  if (!opening) return undefined;
  const tool = opening[1];
  let index = opening.index + opening[0].length;
  while (index <= errorOffset && index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      return `Recovery hint: the template literal passed to omp.${tool} ends at the backtick on ${codePosition(code, index)}, so the rest of the text is parsed as TypeScript. Move the text to a top-level \`payloads\` entry and reference \`payloads.key\`, or escape the backtick as \\\`.`;
    }
    if (code.startsWith("${", index)) {
      const end = substitutionEnd(code, index + 1);
      if (SHELL_EXPANSION_PATTERN.test(code.slice(index + 2, end))) {
        return `Recovery hint: \`${code.slice(index, Math.min(end + 1, index + 40))}\` on ${codePosition(code, index)} is shell parameter expansion, but inside a template literal \`\${\` starts a TypeScript expression. Escape it as \\\${, or move the script to a top-level \`payloads\` entry and reference \`payloads.key\`.`;
      }
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return undefined;
};

export const typeErrorRecoveryHint = (
  code: string,
  errors: FabricTypeError[],
): string | undefined => {
  for (const error of errors) {
    const property = UNKNOWN_PROPERTY_PATTERN.exec(error.message)?.[1];
    const typeText = UNKNOWN_PROPERTY_PATTERN.exec(error.message)?.[2];
    if (property !== undefined && typeText !== undefined) {
      const tool = toolFromTypeText(typeText) ?? enclosingCoreTool(code, error);
      const hint = unknownPropertyHint(property, tool);
      if (hint) return hint;
    }
  }
  if (
    PROMISE_ALL_PATTERN.test(code)
    && errors.some((error) => TUPLE_ARITY_PATTERN.test(error.message))
  ) {
    return "Recovery hint: match `Promise.all` destructuring one binding per promise; remove the extra binding or add the missing call.";
  }
  if (hasLiteralPayloadInterpolation(code, errors)) {
    return "Recovery hint: a `${...}` expression in an edit/write payload is being evaluated by the Fabric TypeScript program. Declare it if intentional; for literal file content, move the payload to top-level `payloads` and reference `payloads.key`.";
  }
  if (
    UNQUOTED_PATH_HEAD.test(code)
    && errors.some((error) =>
      SYNTAX_ERROR_PATTERN.test(error.message)
      || error.message.includes("Cannot find name")
      || error.message.includes("Expected 1-2 arguments")
    )
  ) {
    return "Recovery hint: quote filesystem paths and URLs as strings, e.g. `omp.read('/x')` or `omp.read({ path: '/x' })`. Unquoted paths are parsed as regex, division, or extra arguments.";
  }
  const templateHint = brokenTemplateHint(code, errors);
  if (templateHint) return templateHint;
  if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined;
  if (!errors.some((error) => SYNTAX_ERROR_PATTERN.test(error.message))) {
    return undefined;
  }
  return "Recovery hint: if embedded edit/write payload text caused the syntax error, pass it through top-level `payloads` and reference `payloads.key` instead of escaping it inside `code`.";
};
