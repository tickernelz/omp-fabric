import fs from "node:fs";
import path from "node:path";

// Simulates a worker whose transport dies before it can produce any run
// status — the monitored "Agent transport exited without a result" failure
// that a loaded CI runner (Windows especially) can trigger at boot. Attempts
// are recorded in a marker file beside the status file so tests can assert
// how many launches the manager performed.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
if (!statusFile || !taskFile) process.exit(2);
const task = fs.readFileSync(taskFile, "utf8");
const marker = path.join(path.dirname(statusFile), "startup-attempts");
const attempts = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) + 1 : 1;
fs.writeFileSync(marker, String(attempts));

const diesNow = task === "Terminal boot death" || attempts === 1;
if (diesNow) process.exit(3);

const now = Date.now();
fs.writeFileSync(
  statusFile,
  JSON.stringify({
    id: args.get("id"),
    name: args.get("name"),
    task,
    status: "completed",
    runner: args.get("runner") ?? "omp",
    transport: args.get("transport"),
    cwd: args.get("cwd"),
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: 1,
    toolCalls: 0,
    text: "transport death retry recovered",
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
  }),
);
