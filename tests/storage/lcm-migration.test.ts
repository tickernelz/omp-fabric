import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMigrationSessions, migrationWindow, migrateSessions, reconcileSession, sourceStillValid } from "../../src/storage/lcm-migration.js";
import { openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";
const make = () => tempRoot("lcm-migrate-");
afterEach(releaseTemp);
const file = (root: string, cwd: string, rows: unknown[]) => { const p = path.join(root, "sessions", "project", "run.jsonl"); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); return p; };
const header = (cwd: string) => ({ type: "session", version: 3, id: "run-1", cwd, timestamp: "2026-09-08T00:00:00.000Z" });
const msg = (id: string, timestamp: string, content = "hello", parentId?: string) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content } });
describe("LCM session migration", () => {
  it("uses one startup UTC window and inclusive boundaries", () => { const w = migrationWindow({ now: Date.parse("2026-09-08T12:00:00.000Z") }); expect(w.since).toBe(Date.parse("2026-09-05T12:00:00.000Z")); const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=file(root,cwd,[header(cwd),msg("a","2026-09-05T12:00:00.000Z"),msg("b","2026-09-08T12:00:00.000Z"),msg("c","2026-09-05T11:59:59.999Z")]); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],now:w.until,apply:true}); expect(r.counts.imported).toBe(2); expect(r.counts.skippedOutOfWindow).toBe(1); l.close(); });
  it("keeps structured message content and excludes message_end", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=file(root,cwd,[header(cwd),{type:"message",id:"a",timestamp:"2026-09-07T00:00:00.000Z",parentId:null,message:{role:"assistant",content:[{type:"text",text:"hi"},{type:"image",data:"x"}],toolCall:{name:"x"}}},{type:"message_end",id:"end",timestamp:"2026-09-07T00:00:01.000Z",message:{role:"assistant",content:"detached"}}]); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}); expect(r.counts.imported).toBe(1); const raw = l.readRaw()[0]!; expect(JSON.parse(raw.payloadJson)).toEqual({ type: "message", id: "a", timestamp: "2026-09-07T00:00:00.000Z", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "image", data: "x" }], toolCall: { name: "x" } } }); expect(raw.payloadHash).toBe(raw.contentHash); expect(raw.content).toContain('"toolCall"'); l.close(); });
  it("is repeat-safe and starts a new source generation after changes", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=file(root,cwd,[header(cwd),msg("a","2026-09-07T00:00:00.000Z")]); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const opts={agentDir:root,ledger:l,files:[p],now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}; expect(migrateSessions(opts).counts.imported).toBe(1); expect(migrateSessions(opts).counts.skippedDuplicate).toBe(1); fs.appendFileSync(p,JSON.stringify(msg("b","2026-09-07T01:00:00.000Z","changed"))+"\n"); const r=migrateSessions(opts); expect(r.generations).toHaveLength(1); expect(r.counts.imported).toBe(1); expect(l.readRaw()).toHaveLength(2); l.close(); });
  it("reports malformed and oversized rows without truncation", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=file(root,cwd,[header(cwd),"{bad",{type:"message",id:"large",timestamp:"2026-09-07T00:00:00.000Z",message:{role:"user",content:"x".repeat(300)}}]); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],maxLineBytes:256,now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}); expect(r.counts.malformed).toBe(1); expect(r.counts.oversized).toBe(1); l.close(); });
  it("rejects persisted rows with blank type or id", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=file(root,cwd,[header(cwd),{type:"",id:"a",timestamp:"2026-09-07T00:00:00.000Z",message:{role:"user",content:"x"}},{type:"message",id:" ",timestamp:"2026-09-07T00:00:00.000Z",message:{role:"user",content:"x"}}]); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}); expect(r.counts.malformed).toBe(2); expect(r.counts.imported).toBe(0); l.close(); });
  it("flags missing candidate directories as incomplete", () => { const root=make(); const d=discoverMigrationSessions({agentDir:root,projectCwd:path.join(root,"missing")}); expect(d.incomplete).toBeGreaterThan(0); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); expect(migrateSessions({agentDir:root,ledger:l,projectCwd:cwd}).exitCode).toBe(1); l.close(); });
  it("reconciles only the selected file without a 72-hour cutoff", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const selected=path.join(root,"selected.jsonl"); const unrelated=path.join(root,"unrelated.jsonl"); fs.writeFileSync(selected,[header(cwd),msg("old","2020-01-01T00:00:00.000Z")].map((row) => JSON.stringify(row)).join("\n")+"\n"); fs.writeFileSync(unrelated,[header(cwd),msg("other","2020-01-02T00:00:00.000Z")].map((row) => JSON.stringify(row)).join("\n")+"\n"); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const opts={agentDir:root,ledger:l,files:[selected] as [string],liveCwd:cwd,projectCwd:cwd,apply:true}; expect(reconcileSession(opts).counts.imported).toBe(1); expect(reconcileSession(opts).counts.skippedDuplicate).toBe(1); expect(l.readRaw().map(entry=>entry.entryId)).toEqual(["old"]); expect(unrelated).toBeTruthy(); l.close(); });
  it("keeps reading a session file that grows while the live session writes it", () => {
    const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd);
    const p=file(root,cwd,[header(cwd),msg("a","2026-09-07T00:00:00.000Z")]);
    const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}});
    const opts={agentDir:root,ledger:l,files:[p] as [string],liveCwd:cwd,projectCwd:cwd,apply:true};

    expect(reconcileSession(opts).counts.errors).toBe(0);
    fs.appendFileSync(p, JSON.stringify(msg("b","2026-09-07T00:00:01.000Z"))+"\n");
    const second = reconcileSession(opts);

    expect(second.counts.errors).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(l.readRaw().map(entry=>entry.entryId)).toEqual(["a","b"]);
    expect(sourceStillValid(100, 220)).toBe(true);
    expect(sourceStillValid(220, 100)).toBe(false);
  });
  it("adopts the session header after preamble records", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=path.join(root,"sessions","project","run.jsonl"); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,[{type:"title",v:1,title:"Resumed",source:"auto",updatedAt:"2026-09-07T00:00:00.000Z"},header(cwd),msg("a","2026-09-07T00:00:00.000Z"),msg("b","2026-09-07T00:00:01.000Z")].map(row=>JSON.stringify(row)).join("\n")+"\n"); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}); expect(r.counts.imported).toBe(2); expect(r.counts.malformed).toBe(0); expect(r.exitCode).toBe(0); expect(l.readRaw().map(entry=>entry.sessionId)).toEqual(["run-1","run-1"]); });
  it("reports the entries it drops at the line size cap", () => {
    const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd);
    const p=file(root,cwd,[header(cwd),msg("small","2026-09-07T00:00:00.000Z"),{type:"message",id:"huge",timestamp:"2026-09-07T00:00:01.000Z",message:{role:"user",content:"x".repeat(400)}}]);
    const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}});
    const result=reconcileSession({agentDir:root,ledger:l,files:[p] as [string],liveCwd:cwd,maxLineBytes:256,apply:true});
    expect(result.counts.imported).toBe(1);
    expect(result.drops.entries).toBe(1);
    expect(result.drops.oversizedLines).toBe(1);
    expect(result.drops.oversizedLineBytes).toBeGreaterThan(256);
    expect(result.degraded).toBe(true);
    expect(l.readRaw().map(entry=>entry.entryId)).toEqual(["small"]);
  });
  it("reports whole files dropped at the file and total size caps", () => {
    const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd);
    const rows=[header(cwd),msg("a","2026-09-07T00:00:00.000Z")].map(row=>JSON.stringify(row)).join("\n")+"\n";
    const first=path.join(root,"a.jsonl"); const second=path.join(root,"b.jsonl");
    fs.writeFileSync(first,rows); fs.writeFileSync(second,rows);
    const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}});
    const base={agentDir:root,ledger:l,files:[first,second],liveCwd:cwd,now:Date.parse("2026-09-08T00:00:00.000Z")};
    const clean=migrateSessions(base);
    expect(clean.degraded).toBe(false);
    expect(clean.drops).toEqual({oversizedFiles:0,oversizedFileBytes:0,oversizedLines:0,oversizedLineBytes:0,skippedFiles:0,entries:0});
    const capped=migrateSessions({...base,maxTotalBytes:rows.length+1});
    expect(capped.filesScanned).toBe(1);
    expect(capped.drops.skippedFiles).toBe(1);
    expect(capped.degraded).toBe(true);
    const oversized=migrateSessions({...base,maxFileBytes:8});
    expect(oversized.drops.oversizedFiles).toBe(2);
    expect(oversized.drops.oversizedFileBytes).toBe(rows.length*2);
    expect(oversized.degraded).toBe(true);
  });
  it("reports a source that never declares a session header", () => { const root=make(); const cwd=path.join(root,"project"); fs.mkdirSync(cwd); const p=path.join(root,"sessions","project","run.jsonl"); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,[{type:"title",v:1,title:"Headerless"},msg("a","2026-09-07T00:00:00.000Z")].map(row=>JSON.stringify(row)).join("\n")+"\n"); const l=openLedger({dbPath:path.join(root,"l.sqlite"),project:{liveCwd:cwd}}); const r=migrateSessions({agentDir:root,ledger:l,files:[p],now:Date.parse("2026-09-08T00:00:00.000Z"),apply:true}); expect(r.counts.imported).toBe(0); expect(r.counts.malformed).toBe(2); expect(r.exitCode).toBe(1); expect(l.readRaw()).toHaveLength(0); });
});
