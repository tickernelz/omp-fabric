import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}

const statusFile = args.get("status-file");
const lifecycleFile = args.get("lifecycle-file");
const id = args.get("id");
const name = args.get("name");
const depth = Number(args.get("depth") ?? "1");
const actorId = args.get("actor-id");
const occurredAt = Date.now();

const usage = {
  runId: id,
  name,
  runner: "omp",
  depth,
  ...(actorId ? { actorId } : {}),
  input: 4,
  output: 6,
  cacheRead: 2,
  cacheWrite: 1,
  cost: 0.0005,
  cumulativeTokens: 13,
};

fs.mkdirSync(path.dirname(lifecycleFile), { recursive: true });
fs.appendFileSync(lifecycleFile, JSON.stringify({ version: 1, event: "tokens.usage", occurredAt, data: usage }) + "\n");

const record = {
  id,
  name,
  task: "fake usage",
  status: "completed",
  transport: args.get("transport"),
  cwd: args.get("cwd"),
  startedAt: occurredAt,
  updatedAt: occurredAt,
  finishedAt: occurredAt,
  turns: 1,
  toolCalls: 0,
  text: "usage worker complete",
  exitCode: 0,
  usage: { input: 8, output: 10, cacheRead: 3, cacheWrite: 2, cost: 0.001 },
};
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(record));
