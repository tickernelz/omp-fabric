import { describe, expect, it } from "vitest";
import { activeRequestBlock, tailDigest } from "../../src/compaction/lcm-recovery.js";
import { utf8Bytes } from "../../src/compaction/bounds.js";

const source = (entryId: string) => ({ sessionId: "s1", entryId, revision: 1 });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("LCM recovery", () => {
  it("addresses the newest real request and skips injected reminders", () => {
    const entries = [user("first ask"), assistant("answer"), user("second ask"), { type: "message", message: { role: "user", content: [{ type: "text", text: "<system-reminder>be careful</system-reminder>" }] } }];
    const block = activeRequestBlock(entries, [source("e1"), source("e2"), source("e3"), source("e4")]);
    expect(block).toBe("[Active Request] lcm.raw:s1:e3:1\nsecond ask");
  });

  it("strips reminder spans without discarding the request around them", () => {
    const entries = [user("older ask"), user("please ship it\n<system-reminder>You stopped with 3 incomplete todo items</system-reminder>")];
    const block = activeRequestBlock(entries, [source("e1"), source("e2")]);
    expect(block).toBe("[Active Request] lcm.raw:s1:e2:1\nplease ship it");
  });

  it("clips a long request to its budget and keeps the address", () => {
    const block = activeRequestBlock([user("x".repeat(5_000))], [source("e1")], 256);
    expect(utf8Bytes(block)).toBeLessThanOrEqual(256);
    expect(block.startsWith("[Active Request] lcm.raw:s1:e1:1\n")).toBe(true);
  });

  it("keeps the newest digest lines and counts the omitted ones", () => {
    const entries = Array.from({ length: 12 }, (_, index) => user(`step ${index}`));
    const sources = entries.map((_, index) => source(`e${index}`));
    const digest = tailDigest(entries, sources, 260);
    expect(utf8Bytes(digest)).toBeLessThanOrEqual(260);
    expect(digest).toContain("newest lcm.raw:s1:e11:1");
    expect(digest).toContain("user: step 11");
    expect(digest).not.toContain("user: step 0\n");
    const omitted = Number(/… omitted (\d+) earlier lines/.exec(digest)?.[1]);
    const kept = digest.split("\n").filter((line) => line.startsWith("user: ")).length;
    expect(kept + omitted).toBe(12);
  });

  it("still reports the newest line when the budget fits only one", () => {
    const digest = tailDigest([user("a".repeat(400)), user("b".repeat(400))], [source("e1"), source("e2")], 200);
    expect(utf8Bytes(digest)).toBeLessThanOrEqual(200);
    expect(digest).toContain("bbb");
    expect(digest).toContain("omitted 1 earlier lines");
  });

  it("returns nothing without a request or a budget", () => {
    expect(activeRequestBlock([assistant("no request here")], [source("e1")])).toBe("");
    expect(tailDigest([user("x")], [source("e1")], 0)).toBe("");
  });
});
