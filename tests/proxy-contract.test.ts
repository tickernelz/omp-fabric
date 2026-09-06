import { describe, expect, it } from "vitest";
import {
  capturedToolMentions,
  extractSkillRegions,
  formatProxyContractReminder,
  isRewritableCapturedToolName,
  PROXY_CONTRACT_CUSTOM_TYPE,
  ProxyContractLedger,
  proxyContractMentionsInSkills,
  rewritableHiddenCapturedToolNames,
} from "../src/core/proxy-contract.js";

const foveaSkill = [
  `<skill name="pi-fovea" location="/skills/pi-fovea/SKILL.md">`,
  "1. `fovea_sketch` — production-first silhouette.",
  "2. `fovea_focus` — point at a symbol.",
  "Inside fabric_exec call await extensions.fovea_focus({ query: \"CreateUserHandler\" }).",
  "Use grep for native text. Use fovea_dwell after focus. Use fovea_impact before edits.",
  "</skill>",
].join("\n");

describe("proxy contract reminder", () => {
  it("treats underscored extension names as rewritable and skips core tools", () => {
    expect(rewritableHiddenCapturedToolNames([
      "fovea_sketch",
      "fovea_focus",
      "grep",
      "read",
      "btw",
      "fabric_exec",
    ])).toEqual(["fovea_sketch", "fovea_focus"]);
    expect(isRewritableCapturedToolName("fovea_dwell")).toBe(true);
    expect(isRewritableCapturedToolName("grep")).toBe(false);
  });

  it("reads bare names only from skill envelopes, not from user prose", () => {
    const names = ["fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact"];
    const prompt = ["survey this repo before I touch auth", foveaSkill].join("\n");
    expect(extractSkillRegions(prompt)).toContain("fovea_sketch");
    expect(proxyContractMentionsInSkills(prompt, "", names)).toEqual([
      "fovea_sketch",
      "fovea_focus",
      "fovea_dwell",
      "fovea_impact",
    ]);
    expect(
      proxyContractMentionsInSkills(
        "please call fovea_focus on CreateUserHandler",
        "",
        names,
      ),
    ).toEqual([]);
    expect(
      capturedToolMentions("Then extensions.fovea_focus({ query: \"x\" }).", [
        "fovea_focus",
      ]),
    ).toEqual([]);
  });

  it("formats a call-site remap without furnace vocabulary", () => {
    const text = formatProxyContractReminder(["fovea_sketch", "fovea_focus"]);
    expect(text).toContain("not top-level calls");
    expect(text).toContain("inside `fabric_exec`");
    expect(text).toContain("fovea_sketch → extensions.fovea_sketch");
    expect(text).toContain("fovea_focus → extensions.fovea_focus");
    expect(text).not.toContain("Steer:");
    expect(text).not.toContain("matched your prompt");
  });

  it("reminds each name once per branch and ignores furnace custom messages", () => {
    const ledger = new ProxyContractLedger();
    expect(ledger.take(["fovea_sketch", "fovea_focus"])).toEqual([
      "fovea_sketch",
      "fovea_focus",
    ]);
    expect(ledger.take(["fovea_focus", "fovea_dwell"])).toEqual(["fovea_dwell"]);

    ledger.restoreFromEntries([
      {
        type: "custom_message",
        customType: "omp-fabric-capability",
        content: "fovea_sketch matched your prompt.",
        details: { matches: [{ namespace: "extension:pi-fovea" }] },
      },
      {
        type: "custom_message",
        customType: PROXY_CONTRACT_CUSTOM_TYPE,
        content: formatProxyContractReminder(["fovea_sketch"]),
        details: { names: ["fovea_sketch"] },
      },
    ]);
    expect(ledger.take(["fovea_sketch", "fovea_focus"])).toEqual(["fovea_focus"]);
  });
});
