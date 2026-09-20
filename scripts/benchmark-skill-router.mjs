#!/usr/bin/env bun
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { FabricJudgmentLane } from "../src/judgment/lane.ts";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.ts";
import { suggestSkill } from "../src/judgment/gates/skills.ts";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment/typesafe";

const fixturePath = process.argv[2] ?? path.join(import.meta.dir, "fixtures", "skill-router.json");
const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("TYPESAFE_API_KEY is required: this harness measures the live ranker.");
  process.exit(2);
}

const frontmatter = (source) => {
  const match = /^---\n([\s\S]*?)\n---/u.exec(source);
  if (!match) return undefined;
  const name = /^name:\s*(.+)$/mu.exec(match[1]);
  const description = /^description:\s*(?:>-?\s*\n([\s\S]*?)(?=\n\w|$)|(.+))$/mu.exec(match[1]);
  if (!name) return undefined;
  const text = (description?.[1] ?? description?.[2] ?? "").replaceAll(/\s+/gu, " ").trim();
  return { name: name[1].trim(), description: text };
};

const loadRoster = () => {
  const roots = [
    path.join(process.env.HOME ?? "", ".agents", "skills"),
    path.join(process.env.HOME ?? "", ".omp", "agent", "managed-skills"),
  ].filter((root) => existsSync(root));
  const skills = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(root, entry.name, "SKILL.md");
      if (!existsSync(filePath)) continue;
      const parsed = frontmatter(readFileSync(filePath, "utf-8"));
      if (parsed) skills.push({ ...parsed, filePath });
    }
  }
  return skills;
};

const roster = loadRoster();
const cases = JSON.parse(readFileSync(fixturePath, "utf-8"));
const known = new Set(roster.map((skill) => skill.name));
const unknown = cases.filter((entry) => entry.expected && !known.has(entry.expected));

console.log(`roster: ${roster.length} skills from ~/.agents/skills and ~/.omp/agent/managed-skills`);
console.log(`cases: ${cases.length} (${cases.filter((entry) => entry.expected === null).length} expecting no skill)`);
if (unknown.length > 0) {
  console.log(`WARNING: ${unknown.length} case(s) name a skill absent from this roster: ${unknown.map((entry) => entry.expected).join(", ")}`);
}
console.log("");
console.log("This measures the ranker, not the agent. It reports which skill the router names,");
console.log("not whether the model then loads it, which only an end-to-end agent run can show.");
console.log("");

const lane = new FabricJudgmentLane(
  DEFAULT_FABRIC_CONFIG.judgment,
  async () => new TypeSafeJudge({ apiKey: key }),
);

let hit = 0;
let miss = 0;
let falsePositive = 0;
let trueNegative = 0;
let unanswered = 0;
const latencies = [];
const started = Date.now();
const unhappy = (stats) => stats.failures + stats.timeouts + stats.refusals;
for (const entry of cases) {
  const before = unhappy(lane.stats());
  const at = Date.now();
  const suggestion = await suggestSkill(lane, entry.prompt, roster);
  const ms = Date.now() - at;
  const answered = unhappy(lane.stats()) === before;
  const named = suggestion?.name ?? null;
  let verdict;
  if (!answered) {
    unanswered++;
    verdict = "UNANSWERED";
  } else {
    latencies.push(ms);
    if (entry.expected === null) {
      if (named === null) {
        trueNegative++;
        verdict = "ok";
      } else {
        falsePositive++;
        verdict = "FALSE SUGGESTION";
      }
    } else if (named === entry.expected) {
      hit++;
      verdict = "ok";
    } else {
      miss++;
      verdict = "MISS";
    }
  }
  console.log(`${verdict.padEnd(17)} ${String(ms).padStart(5)}ms  want=${entry.expected ?? "-"}  got=${named ?? "-"}  ${entry.prompt.slice(0, 60)}`);
}

const labelled = hit + miss;
const nulls = falsePositive + trueNegative;
const sorted = [...latencies].sort((left, right) => left - right);
const at = (fraction) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
console.log("");
if (unanswered > 0) {
  console.log(`${unanswered} of ${cases.length} cases went unanswered and are excluded from every figure below.`);
  console.log("An unanswered case is not a declined suggestion: the gate fails open, so a dead backend");
  console.log("would otherwise read as a perfect false-suggestion score.");
}
console.log(`top-1 on answered labelled cases : ${labelled === 0 ? "n/a" : `${hit}/${labelled}`}`);
console.log(`suggested when nothing fits      : ${nulls === 0 ? "n/a" : `${falsePositive}/${nulls}`}`);
console.log(`per-turn latency, run serially   : p50 ${at(0.5)}ms, p90 ${at(0.9)}ms, max ${sorted[sorted.length - 1] ?? 0}ms`);
console.log(`wall clock                       : ${((Date.now() - started) / 1000).toFixed(1)}s for ${cases.length} cases`);
console.log(`lane                             : ${JSON.stringify(lane.stats())}`);
