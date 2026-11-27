#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = process.argv.slice(2);
const binaryIndex = args.indexOf("--binary");
const binary = binaryIndex >= 0 ? args[binaryIndex + 1] : undefined;
if (binaryIndex >= 0 && !binary) throw new Error("--binary needs the path of the omp executable");

const HOST = "@oh-my-pi/";
const staticRe = /(?:^|[;\n])\s*(?:import|export)\s*(?:(\{[^}]*\})|[\w$*][^"';]*?)?\s*(?:from\s*)?"(@oh-my-pi\/[^"]+)"/g;
const dynamicRe = /\bimport\(\s*"(@oh-my-pi\/[^"]+)"\s*\)/g;

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });

const imports = new Map();
const record = (specifier, file, kind, names = []) => {
  const entry = imports.get(specifier) ?? { kinds: new Set(), names: new Set(), files: new Set() };
  entry.kinds.add(kind);
  entry.files.add(relative(root, file));
  for (const name of names) entry.names.add(name);
  imports.set(specifier, entry);
};

const distFiles = files(dist);
for (const file of distFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(staticRe)) {
    const names = (match[1] ?? "")
      .replace(/[{}]/g, "")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
      .filter((name) => name && name !== "default");
    record(match[2], file, "static", names);
  }
  for (const match of source.matchAll(dynamicRe)) record(match[1], file, "dynamic");
}

const moduleMap = binary
  ? new Set(
      [...readFileSync(binary).toString("latin1").matchAll(/"(@oh-my-pi\/[^"\s]+)": [A-Za-z_$][\w$]*/g)].map(
        (match) => match[1],
      ),
    )
  : undefined;
if (moduleMap && moduleMap.size === 0) throw new Error(`No @oh-my-pi module map found in ${binary}`);

const failures = [];
const fallbacks = [];
let names = 0;
for (const [specifier, entry] of [...imports].sort(([a], [b]) => a.localeCompare(b))) {
  const required = entry.kinds.has("static");
  const problems = [];
  if (moduleMap && !moduleMap.has(specifier)) problems.push("not in the host binary module map");
  try {
    const loaded = await import(specifier);
    for (const name of entry.names) {
      names++;
      if (!(name in loaded)) problems.push(`no export ${name}`);
    }
  } catch (error) {
    problems.push(`cannot be imported: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (problems.length === 0) continue;
  const line = `${specifier}: ${problems.join("; ")} (${[...entry.files].sort().join(", ")})`;
  (required ? failures : fallbacks).push(line);
}

const against = binary ? `the module map of ${binary} and the installed host packages` : "the installed host packages";
console.log(
  `host imports: ${distFiles.length} files, ${imports.size} specifiers, ${names} names checked against ${against}`,
);
for (const line of fallbacks) console.log(`fallback (dynamic import, Fabric degrades): ${line}`);
if (failures.length > 0) {
  console.error(`Static host imports that would stop omp-fabric from loading:\n${failures.join("\n")}`);
  process.exit(1);
}
