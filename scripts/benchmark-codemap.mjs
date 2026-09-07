import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import { assembleMap } from "../src/codemap/budget.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const ROOT = process.argv[2] ?? process.cwd();
const TARGET = join(ROOT, "src");
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).length;

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
};

const files = walk(TARGET);
let raw = 0;
let summaryPlain = 0;
let summaryFiltered = 0;
const DROP = /^\s*(import |export \{[^}]*\} from |\/\/|\/\*|\*|})/;

for (const file of files) {
  const code = readFileSync(file, "utf8");
  raw += bytes(code);
  const result = summarizeCode({ code, path: file });
  if (!result.parsed) {
    summaryPlain += bytes(code);
    summaryFiltered += bytes(code);
    continue;
  }
  const lines = code.split("\n");
  const kept = [];
  for (const segment of result.segments) {
    if (segment.kind !== "kept") continue;
    for (let index = segment.startLine - 1; index < segment.endLine && index < lines.length; index++) {
      kept.push(lines[index]);
    }
  }
  summaryPlain += bytes(kept.join("\n") + "\n");
  summaryFiltered += bytes(kept.filter((line) => line.trim() && !DROP.test(line)).join("\n") + "\n");
}

const index = await buildSymbolIndex({
  root: ROOT,
  glob: "src/**/*.ts",
  maxFiles: 20_000,
  maxSymbols: 500_000,
});

const full = assembleMap({ index, maxTokens: 10_000_000 });
if (full.truncated) {
  console.error("benchmark budget was too small to render the whole index");
  process.exit(1);
}
const indexBytes = bytes(full.text);

const ratio = (value) => (raw / value).toFixed(2) + "x";
const rows = [
  ["raw source", raw, "1.00x"],
  ["summarizeCode unfiltered", summaryPlain, ratio(summaryPlain)],
  ["summarizeCode filtered", summaryFiltered, ratio(summaryFiltered)],
  ["native astGrep symbol index", indexBytes, ratio(indexBytes)],
];

console.log(`files: ${files.length}  symbols: ${index.symbols.length}  rendered: ${full.symbolsShown}  elapsed: ${index.elapsedMs}ms  fallback files: ${index.fallbackFiles.length}`);
for (const [label, size, compression] of rows) {
  console.log(`${label.padEnd(30)} ${String(size).padStart(10)}  ${compression.padStart(7)}`);
}

const FLOOR = 15;
const achieved = raw / indexBytes;
if (achieved < FLOOR) {
  console.error(`symbol index compression ${achieved.toFixed(2)}x is below the ${FLOOR}x floor`);
  process.exit(1);
}
console.log(`floor ${FLOOR}x satisfied`);
