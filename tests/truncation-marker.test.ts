import { describe, expect, it } from "vitest";
import { splitTruncationNotice, TRUNCATION_MARKER } from "../src/core/truncation-marker.js";

const marker = (signal: unknown): string => `${TRUNCATION_MARKER} ${JSON.stringify(signal)}`;

describe("splitTruncationNotice", () => {
  it("returns undefined when no marker is present", () => {
    expect(splitTruncationNotice("plain output\n")).toBeUndefined();
  });

  it("strips a trailing marker line and keeps the output before it", () => {
    const value = `line one\nline two\n${marker({ tool: "bash", partial: true, reasons: ["columnLimit"] })}\n`;
    const notice = splitTruncationNotice(value);
    expect(notice?.text).toBe("line one\nline two\n");
    expect(notice?.label).toBe("bash truncated · column limit");
  });

  it("strips a marker that starts the text", () => {
    const value = `${marker({ tool: "wait", reasons: ["outputLimit"] })}\n`;
    const notice = splitTruncationNotice(value);
    expect(notice?.text).toBe("\n");
    expect(notice?.label).toBe("wait truncated · output limit");
  });

  it("keeps a valid signal object and falls back to a generic label on broken JSON", () => {
    const valid = splitTruncationNotice(`out\n${marker({ tool: "grep", reasons: ["matchLimit", "perFileMatchLimit"] })}\n`);
    expect(valid?.signal).toEqual({ tool: "grep", reasons: ["matchLimit", "perFileMatchLimit"] });
    expect(valid?.label).toBe("grep truncated · match limit, per-file match limit");
    const broken = splitTruncationNotice(`out\n${TRUNCATION_MARKER} {not json}\n`);
    expect(broken?.text).toBe("out\n");
    expect(broken?.label).toBe("output truncated");
    expect(broken?.signal).toEqual({});
  });

  it("ignores the marker when it is not at a line start", () => {
    const value = `prefix ${TRUNCATION_MARKER} {}\n`;
    expect(splitTruncationNotice(value)).toBeUndefined();
  });
});
