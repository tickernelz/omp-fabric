export type CodeSymbolKind =
  | "fn"
  | "class"
  | "iface"
  | "type"
  | "const"
  | "enum"
  | "method";

export interface CodeSymbol {
  file: string;
  line: number;
  kind: CodeSymbolKind;
  name: string;
  exported: boolean;
}

export interface SymbolIndex {
  root: string;
  symbols: CodeSymbol[];
  files: string[];
  languages: Record<string, number>;
  fallbackFiles: string[];
  truncated: boolean;
  elapsedMs: number;
}

export interface SymbolIndexRequest {
  root: string;
  glob?: string;
  maxFiles: number;
  maxSymbols: number;
  signal?: AbortSignal;
}

export interface CoChangeEdge {
  file: string;
  score: number;
  commits: number;
}

export interface CoChangeGraph {
  seeds: string[];
  edges: CoChangeEdge[];
  commitsScanned: number;
  truncated: boolean;
  unavailable?: string;
}

export interface CoChangeRequest {
  root: string;
  seeds: string[];
  maxCommits: number;
  limit: number;
}

export interface BudgetedMap {
  text: string;
  tokensEstimated: number;
  filesShown: number;
  symbolsShown: number;
  omittedFiles: number;
  omittedSymbols: number;
  truncated: boolean;
}

export interface MapBudgetRequest {
  index: SymbolIndex;
  maxTokens: number;
  focus?: string;
  cascade?: CoChangeGraph;
}
