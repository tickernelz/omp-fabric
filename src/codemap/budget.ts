import { estimateTokens } from "../core/token-math.js";
import type { BudgetedMap, CodeSymbol, CodeSymbolKind, MapBudgetRequest } from "./types.js";

const KIND_LETTERS: Record<CodeSymbolKind, string> = {
  fn: "f",
  class: "c",
  iface: "i",
  type: "t",
  const: "v",
  enum: "e",
  method: "m",
};
const LEGEND = "# f=fn c=class i=iface t=type v=const e=enum m=method";
const MIN_FILE_ENTRY = 8;

const FOCUS_WEIGHT = 1;
const CASCADE_WEIGHT = 0.6;
const NAME_EXACT_SCORE = 6;
const NAME_WORD_SCORE = 3;
const PATH_WORD_SCORE = 4;
const SUBSTRING_SCORE = 1;
const MIN_SUBSTRING_LENGTH = 3;
const EXPORT_PASSES = [true, false] as const;

interface FileGroup {
  file: string;
  symbols: CodeSymbol[];
  score: number;
}

interface FileLexicon {
  pathWords: Set<string>;
  pathLower: string;
  names: Set<string>;
  nameWords: Set<string>;
  namesBlob: string;
}

const isUpper = (code: number): boolean => code >= 65 && code <= 90;
const isLower = (code: number): boolean => code >= 97 && code <= 122;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isWordChar = (code: number): boolean => isUpper(code) || isLower(code) || isDigit(code);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const collectWords = (value: string, sink: Set<string>): void => {
  let start = -1;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (!isWordChar(code)) {
      if (start >= 0) sink.add(value.slice(start, index).toLowerCase());
      start = -1;
      continue;
    }
    if (start < 0) {
      start = index;
      continue;
    }
    const previous = value.charCodeAt(index - 1);
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
    if (isUpper(code) && (!isUpper(previous) || isLower(next))) {
      sink.add(value.slice(start, index).toLowerCase());
      start = index;
    }
  }
  if (start >= 0) sink.add(value.slice(start).toLowerCase());
};

const focusTerms = (focus: string | undefined): string[] => {
  if (focus === undefined || focus.length === 0) return [];
  const words = new Set<string>();
  collectWords(focus, words);
  return [...words];
};

const lexiconFor = (group: FileGroup): FileLexicon => {
  const pathWords = new Set<string>();
  collectWords(group.file, pathWords);
  const names = new Set<string>();
  const nameWords = new Set<string>();
  const distinct: string[] = [];
  for (const symbol of group.symbols) {
    const lowered = symbol.name.toLowerCase();
    if (names.has(lowered)) continue;
    names.add(lowered);
    distinct.push(lowered);
    collectWords(symbol.name, nameWords);
  }
  return {
    pathWords,
    pathLower: group.file.toLowerCase(),
    names,
    nameWords,
    namesBlob: distinct.join("\n"),
  };
};

const termScore = (term: string, lexicon: FileLexicon): number => {
  const wideEnough = term.length >= MIN_SUBSTRING_LENGTH;
  let score = 0;
  if (lexicon.names.has(term)) score += NAME_EXACT_SCORE;
  else if (lexicon.nameWords.has(term)) score += NAME_WORD_SCORE;
  else if (wideEnough && lexicon.namesBlob.includes(term)) score += SUBSTRING_SCORE;
  if (lexicon.pathWords.has(term)) score += PATH_WORD_SCORE;
  else if (wideEnough && lexicon.pathLower.includes(term)) score += SUBSTRING_SCORE;
  return score;
};

const groupByFile = (symbols: readonly CodeSymbol[]): FileGroup[] => {
  const byFile = new Map<string, FileGroup>();
  for (const symbol of symbols) {
    let group = byFile.get(symbol.file);
    if (group === undefined) {
      group = { file: symbol.file, symbols: [], score: 0 };
      byFile.set(symbol.file, group);
    }
    group.symbols.push(symbol);
  }
  for (const group of byFile.values()) {
    group.symbols.sort((left, right) =>
      left.line - right.line
      || compareText(left.name, right.name)
      || compareText(left.kind, right.kind));
  }
  return [...byFile.values()];
};

const applyFocus = (groups: FileGroup[], focus: string | undefined): void => {
  const terms = focusTerms(focus);
  if (terms.length === 0) return;
  let peak = 0;
  for (const group of groups) {
    const lexicon = lexiconFor(group);
    let raw = 0;
    for (const term of terms) raw += termScore(term, lexicon);
    group.score = raw;
    if (raw > peak) peak = raw;
  }
  for (const group of groups) group.score = peak > 0 ? (group.score / peak) * FOCUS_WEIGHT : 0;
};

const applyCascade = (groups: FileGroup[], request: MapBudgetRequest): void => {
  const edges = request.cascade?.edges;
  if (edges === undefined || edges.length === 0) return;
  const best = new Map<string, number>();
  let peak = 0;
  for (const edge of edges) {
    if (edge.score > peak) peak = edge.score;
    const previous = best.get(edge.file);
    if (previous === undefined || edge.score > previous) best.set(edge.file, edge.score);
  }
  if (peak <= 0) return;
  for (const group of groups) {
    const edgeScore = best.get(group.file);
    if (edgeScore !== undefined && edgeScore > 0) {
      group.score += (edgeScore / peak) * CASCADE_WEIGHT;
    }
  }
};

const rankGroups = (groups: FileGroup[], request: MapBudgetRequest): void => {
  applyFocus(groups, request.focus);
  applyCascade(groups, request);
  groups.sort((left, right) =>
    right.score - left.score
    || right.symbols.length - left.symbols.length
    || compareText(left.file, right.file));
};

interface SpendPlan {
  lines: string[];
  filesShown: number;
  symbolsShown: number;
  omittedFiles: number;
  omittedSymbols: number;
}

const spend = (groups: readonly FileGroup[], charBudget: number, reserved: number): SpendPlan => {
  const lines: string[] = [];
  let used = reserved;
  let filesShown = 0;
  let symbolsShown = 0;
  let omittedFiles = 0;
  let omittedSymbols = 0;

  for (const group of groups) {
    const headerCost = group.file.length + 1;
    if (used + headerCost >= charBudget) {
      omittedFiles++;
      omittedSymbols += group.symbols.length;
      continue;
    }
    const rendered: (string | undefined)[] = new Array(group.symbols.length);
    const picked: number[] = [];
    let cost = headerCost;
    for (const exported of EXPORT_PASSES) {
      for (let index = 0; index < group.symbols.length; index++) {
        const symbol = group.symbols[index]!;
        if (symbol.exported !== exported) continue;
        let line = rendered[index];
        if (line === undefined) {
          line = `${symbol.line} ${KIND_LETTERS[symbol.kind]} ${symbol.name}`;
          rendered[index] = line;
        }
        const lineCost = line.length + 1;
        if (used + cost + lineCost > charBudget) continue;
        cost += lineCost;
        picked.push(index);
      }
    }
    if (picked.length === 0) {
      omittedFiles++;
      omittedSymbols += group.symbols.length;
      continue;
    }
    picked.sort((left, right) => left - right);
    lines.push(group.file);
    for (const index of picked) lines.push(rendered[index]!);
    used += cost;
    filesShown++;
    symbolsShown += picked.length;
    omittedSymbols += group.symbols.length - picked.length;
  }

  return { lines, filesShown, symbolsShown, omittedFiles, omittedSymbols };
};

export function assembleMap(request: MapBudgetRequest): BudgetedMap {
  const groups = groupByFile(request.index.symbols);
  rankGroups(groups, request);

  const charBudget = request.maxTokens > 0 ? Math.floor(request.maxTokens) * 4 : 0;
  const legendCost = LEGEND.length + 1;
  const reserved = charBudget >= legendCost + MIN_FILE_ENTRY ? legendCost : 0;
  let plan = spend(groups, charBudget, reserved);
  let legendShown = reserved > 0;
  if (plan.filesShown === 0 && reserved > 0) {
    plan = spend(groups, charBudget, 0);
    legendShown = false;
  }

  const body = plan.lines.join("\n");
  const text = plan.lines.length === 0 ? "" : legendShown ? `${LEGEND}\n${body}\n` : `${body}\n`;
  return {
    text,
    tokensEstimated: estimateTokens({ role: "user", content: text }),
    filesShown: plan.filesShown,
    symbolsShown: plan.symbolsShown,
    omittedFiles: plan.omittedFiles,
    omittedSymbols: plan.omittedSymbols,
    truncated: plan.omittedFiles > 0 || plan.omittedSymbols > 0,
  };
}
