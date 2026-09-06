#!/usr/bin/env node
import readline from "node:readline";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const assistant = (content, extra = {}) => emit({ type: "message_end", message: { role: "assistant", content, stopReason: "stop", ...extra } });
const fail = () => assistant([], {
  stopReason: "error",
  provider: "openai-codex",
  model: "gpt-test",
  errorMessage: "fetch failed",
  diagnostics: [{ error: { message: "WebSocket error" } }],
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  emit({ type: "agent_start" });
  if (request.message === "FAIL_PROVIDER") fail();
  else if (request.message === "RETRY_THEN_SUCCEED") {
    fail();
    emit({ type: "agent_end", isTerminal: false });
    setTimeout(() => {
      emit({ type: "agent_start" });
      assistant("retry recovered");
      emit({ type: "agent_end", isTerminal: true });
    }, 100);
    return;
  } else if (request.message === "REPORT_FABRIC_IDENTITY") {
    assistant(JSON.stringify({
      mainAgentId: process.env.OMP_FABRIC_MAIN_AGENT_ID,
      parentRun: process.env.OMP_FABRIC_PARENT_RUN,
      agentName: process.env.OMP_FABRIC_AGENT_NAME,
    }));
  } else {
    assistant(JSON.stringify({ action: "message", message: `validated actor response:${process.env.OMP_FABRIC_FULL_CODE_MODE}` }), { usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  }
  emit({ type: "turn_end", turnIndex: 0 });
  emit({ type: "agent_end", isTerminal: true });
});
