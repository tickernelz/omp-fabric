#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const input = readline.createInterface({ input: process.stdin });
const steering = [];
const followUp = [];
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.FAKE_OMP_STEER_LOG) fs.appendFileSync(process.env.FAKE_OMP_STEER_LOG, JSON.stringify(request) + "\n");
  if (request.type === "prompt") {
    emit({ type: "agent_start" });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: "ready", stopReason: "stop" } });
      emit({ type: "agent_end", isTerminal: true });
    }, 1500);
  } else if (request.type === "steer" || request.type === "follow_up") {
    (request.type === "steer" ? steering : followUp).push(request.message);
    emit({ type: "queue_update", steering, followUp });
  } else if (request.type === "compact") {
    emit({ type: "response", command: "compact", id: request.id, success: true, data: { summary: "compacted", tokensBefore: 100 } });
  } else {
    emit({ type: "response", command: request.type, success: true });
  }
});
