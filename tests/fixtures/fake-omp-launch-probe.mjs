#!/usr/bin/env node
import readline from "node:readline";
const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  const report = {
    extensions: !args.includes("--no-extensions"),
    extensionPath: value("-e"),
    tools: (value("--tools") ?? "").split(",").filter(Boolean),
    fullCodeModeEnv: process.env.OMP_FABRIC_FULL_CODE_MODE,
    toolAllowlistEnv: JSON.parse(process.env.OMP_FABRIC_TOOL_ALLOWLIST ?? "[]"),
    grantedRisksEnv: (process.env.OMP_FABRIC_GRANTED_RISKS ?? "").split(",").filter(Boolean),
  };
  for (const event of [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", content: JSON.stringify(report), stopReason: "stop" } },
    { type: "agent_end", isTerminal: true },
  ]) process.stdout.write(JSON.stringify(event) + "\n");
});
