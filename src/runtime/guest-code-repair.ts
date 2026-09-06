// Silent repairs for high-frequency unquoted path/URL arguments in pi.*
// calls. Models often write `omp.read(/tmp/foo)` or `omp.read(https://…)` which
// TypeScript parses as regex, division, extra arguments, or invalid
// characters — a wasted round trip the type gate otherwise spends on 20+
// diagnostics. Only rewrite unambiguous path heads; leave regex-primary
// tools (grep/find positional patterns) and already-quoted arguments alone.

const PATH_POSITIONAL_TOOLS = new Set(["read", "ls", "write", "edit"]);
const PATH_OBJECT_TOOLS = new Set(["read", "ls", "write", "edit", "grep", "find"]);
const PATH_KEYS = new Set([
  "path",
  "file",
  "filepath",
  "file_path",
  "filePath",
  "pathname",
  "target_file",
  "targetFile",
  "absolutePath",
  "absolute_path",
  "dir",
  "directory",
  "folder",
  "directoryPath",
  "fileAbsolutePath",
]);

const UNICODE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
  ["\u00ab", "\u00bb"],
];

interface Repair {
  start: number;
  end: number;
  text: string;
}

const isIdentChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char);

const skipWs = (code: string, index: number, end: number): number => {
  let i = index;
  while (i < end && /[ \t\r\n]/.test(code[i] ?? "")) i++;
  return i;
};

const skipQuoted = (code: string, index: number, quote: string): number => {
  let i = index + 1;
  while (i < code.length) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    i++;
  }
  return code.length;
};

const readIdent = (code: string, index: number, end: number): { name: string; end: number } | undefined => {
  const start = code[index];
  if (start === undefined || !/[A-Za-z_$]/.test(start)) return undefined;
  let i = index + 1;
  while (i < end && isIdentChar(code[i])) i++;
  return { name: code.slice(index, i), end: i };
};

const isUnquotedPathStart = (code: string, index: number): boolean => {
  const rest = code.slice(index);
  if (rest.startsWith("https://") || rest.startsWith("http://")) return true;
  if (rest.startsWith("./") || rest.startsWith("../") || rest.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(rest)) return true;
  if (rest.startsWith("/") && !rest.startsWith("//") && !rest.startsWith("/*")) return true;
  return false;
};

const consumeUnquotedPath = (code: string, index: number, end: number): number => {
  let i = index;
  while (i < end) {
    const char = code[i];
    if (char === undefined) break;
    if (char === "," || char === ")" || char === "}" || char === "]" || char === ";") break;
    if (char === "'" || char === '"' || char === "`") break;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") break;
    if (char === "&" && code[i + 1] === "&") break;
    if (char === "|" && code[i + 1] === "|") break;
    i++;
  }
  return i;
};

const quoteSlice = (code: string, start: number, end: number): Repair | undefined => {
  if (end <= start) return undefined;
  return { start, end, text: JSON.stringify(code.slice(start, end)) };
};

const unicodeQuoteRepair = (code: string, index: number, end: number): Repair | undefined => {
  for (const [open, close] of UNICODE_QUOTE_PAIRS) {
    if (!code.startsWith(open, index)) continue;
    const innerStart = index + open.length;
    const innerEnd = code.indexOf(close, innerStart);
    if (innerEnd === -1 || innerEnd >= end) return undefined;
    return {
      start: index,
      end: innerEnd + close.length,
      text: JSON.stringify(code.slice(innerStart, innerEnd)),
    };
  }
  return undefined;
};

const repairPathValue = (code: string, index: number, end: number): Repair | undefined => {
  const unicode = unicodeQuoteRepair(code, index, end);
  if (unicode) return unicode;
  if (!isUnquotedPathStart(code, index)) return undefined;
  return quoteSlice(code, index, consumeUnquotedPath(code, index, end));
};

const repairObjectPathKeys = (code: string, openIndex: number, end: number): Repair[] => {
  const repairs: Repair[] = [];
  let depth = 1;
  let i = openIndex;
  while (i < end && depth > 0) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const quotedEnd = skipQuoted(code, i, char);
      if (depth === 1) {
        const name = code.slice(i + 1, quotedEnd - 1);
        if (PATH_KEYS.has(name)) {
          let j = skipWs(code, quotedEnd, end);
          if (code[j] === ":") {
            j = skipWs(code, j + 1, end);
            const repair = repairPathValue(code, j, end);
            if (repair) {
              repairs.push(repair);
              i = repair.end;
              continue;
            }
          }
        }
      }
      i = quotedEnd;
      continue;
    }
    if (char === "`") {
      i = skipTemplateLiteral(code, i, end);
      continue;
    }
    if (char === "{") {
      depth++;
      i++;
      continue;
    }
    if (char === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1) {
      const ident = readIdent(code, i, end);
      if (ident && PATH_KEYS.has(ident.name)) {
        let j = skipWs(code, ident.end, end);
        if (code[j] === ":") {
          j = skipWs(code, j + 1, end);
          const repair = repairPathValue(code, j, end);
          if (repair) {
            repairs.push(repair);
            i = repair.end;
            continue;
          }
        }
        i = ident.end;
        continue;
      }
    }
    i++;
  }
  return repairs;
};

const skipTemplateLiteral = (code: string, index: number, end: number): number => {
  let i = index + 1;
  while (i < end) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && code[i + 1] === "{") {
      i = skipBalanced(code, i + 2, end, "{", "}");
      continue;
    }
    i++;
  }
  return end;
};

const skipBalanced = (
  code: string,
  index: number,
  end: number,
  open: string,
  close: string,
): number => {
  let depth = 1;
  let i = index;
  while (i < end && depth > 0) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const stop = code.indexOf("*/", i + 2);
      i = stop === -1 || stop >= end ? end : stop + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = skipQuoted(code, i, char);
      continue;
    }
    if (char === "`") {
      i = skipTemplateLiteral(code, i, end);
      continue;
    }
    if (char === open) depth++;
    else if (char === close) depth--;
    i++;
  }
  return i;
};

const repairCallArgs = (code: string, argStart: number, end: number, tool: string): Repair[] => {
  const i = skipWs(code, argStart, end);
  if (i >= end) return [];
  if (code[i] === "{") {
    return PATH_OBJECT_TOOLS.has(tool) ? repairObjectPathKeys(code, i + 1, end) : [];
  }
  if (!PATH_POSITIONAL_TOOLS.has(tool)) return [];
  const repair = repairPathValue(code, i, end);
  return repair ? [repair] : [];
};

const collectRepairs = (code: string, start: number, end: number): Repair[] => {
  const repairs: Repair[] = [];
  let i = start;
  while (i < end) {
    const char = code[i];
    if (char === "/" && code[i + 1] === "/") {
      while (i < end && code[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      i = Math.min(end, skipQuoted(code, i, char));
      continue;
    }
    if (char === "`") {
      i = collectTemplateRepairs(code, i, end, repairs);
      continue;
    }
    if (
      char === "o"
      && code.startsWith("omp.", i)
      && !isIdentChar(code[i - 1])
    ) {
      const tool = readIdent(code, i + 4, end);
      if (tool && PATH_OBJECT_TOOLS.has(tool.name)) {
        const paren = skipWs(code, tool.end, end);
        if (code[paren] === "(") {
          repairs.push(...repairCallArgs(code, paren + 1, end, tool.name));
          i = paren + 1;
          continue;
        }
      }
    }
    i++;
  }
  return repairs;
};

const collectTemplateRepairs = (
  code: string,
  index: number,
  end: number,
  repairs: Repair[],
): number => {
  let i = index + 1;
  while (i < end) {
    const char = code[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && code[i + 1] === "{") {
      const exprStart = i + 2;
      const exprEnd = skipBalanced(code, exprStart, end, "{", "}");
      repairs.push(...collectRepairs(code, exprStart, exprEnd - 1));
      i = exprEnd;
      continue;
    }
    i++;
  }
  return end;
};

export const repairFabricGuestCode = (code: string): string => {
  const repairs = collectRepairs(code, 0, code.length);
  if (repairs.length === 0) return code;
  let result = code;
  for (let index = repairs.length - 1; index >= 0; index--) {
    const repair = repairs[index];
    if (!repair) continue;
    result = result.slice(0, repair.start) + repair.text + result.slice(repair.end);
  }
  return result;
};
