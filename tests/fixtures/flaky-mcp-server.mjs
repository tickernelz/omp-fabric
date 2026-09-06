import fs from "node:fs";
import readline from "node:readline";

// Serves exactly once per state file: the first spawned process records
// itself and answers normally; any later process dies at startup, so a live
// relist fails while cached descriptors remain available.
const stateFile = process.env.OMP_FABRIC_MCP_FLAKY_STATE;
if (stateFile && fs.existsSync(stateFile)) process.exit(1);
if (stateFile) fs.writeFileSync(stateFile, String(process.pid));

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "omp-fabric-test-flaky", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "flaky-ping",
          description: "Ping from a serve-once fixture",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    respond(request.id, { content: [{ type: "text", text: "flaky:pong" }] });
    return;
  }
  if (request.id !== undefined) respond(request.id, {});
});
