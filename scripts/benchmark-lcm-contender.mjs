import fs from "node:fs";
import { LcmLedger } from "../src/storage/lcm-ledger.ts";

const [, , dbPath, liveCwd, reportPath, stopPath] = process.argv;
const ledger = new LcmLedger({ dbPath, project: { liveCwd } });
const report = { appends: 0, reads: 0, lockErrors: 0, otherErrors: 0 };
const payload = (index) => JSON.stringify({ type: "message", id: `contender-${index}`, parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "contender" }] } });

let index = 0;
while (!fs.existsSync(stopPath)) {
  try {
    ledger.appendRaw({ projectKey: ledger.project.key, sessionId: "contender", entryId: `contender-${index}`, role: "user", content: "contender", payloadJson: payload(index) });
    report.appends += 1;
    report.reads += ledger.readRaw(ledger.project.key, "contender").length > 0 ? 1 : 0;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/SQLITE_BUSY|database is locked/iu.test(message)) report.lockErrors += 1;
    else report.otherErrors += 1;
  }
  index += 1;
}
ledger.close();
fs.writeFileSync(reportPath, JSON.stringify(report));
