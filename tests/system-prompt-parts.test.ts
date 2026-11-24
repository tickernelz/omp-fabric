import {
  type ExtensionAPI,
  setActiveSkills,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";
import {
  hostPromptParts,
  restoreSkillsForFullCodePrompt,
  restoreSkillsInPromptParts,
} from "../src/core/skill-prompt.js";

const guidanceSwitch = vi.hoisted(() => ({ forceEmpty: false }));

vi.mock("../src/core/system-guidance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/system-guidance.js")>();
  return {
    ...actual,
    fabricExecutionKernelGuidance: (
      ...args: Parameters<typeof actual.fabricExecutionKernelGuidance>
    ) => (guidanceSwitch.forceEmpty ? "" : actual.fabricExecutionKernelGuidance(...args)),
    fabricSchemaGuidance: (...args: Parameters<typeof actual.fabricSchemaGuidance>) =>
      guidanceSwitch.forceEmpty ? undefined : actual.fabricSchemaGuidance(...args),
  };
});

vi.mock("../src/components/model-guidance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/model-guidance.js")>();
  return {
    ...actual,
    resolveFabricModelGuidance: (
      ...args: Parameters<typeof actual.resolveFabricModelGuidance>
    ) => {
      const resolved = actual.resolveFabricModelGuidance(...args);
      return guidanceSwitch.forceEmpty ? { ...resolved, slotText: "", appendText: "" } : resolved;
    },
  };
});

const skills: Skill[] = [
  {
    name: "release-risk",
    description: "Review launch plans for operational risk.",
    filePath: "/skills/release-risk/SKILL.md",
    baseDir: "/skills/release-risk",
    source: "test",
    hide: false,
  },
];

const SKILLS_HEADING = "# Skills & Rules\n";
const OMP_LOAD_INSTRUCTION = "Matching skill → MUST read `skill://<name>` first.";
const FABRIC_LOAD_INSTRUCTION =
  "Matching skill → MUST read `skill://<name>` through `omp.read` inside `fabric_exec` first.";

type Handler = (event: unknown, context: unknown) => unknown;

const registerExtension = async (): Promise<Handler> => {
  const handlers = new Map<string, Handler[]>();
  const omp = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => ["fabric_exec"]),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const { default: ompFabric } = await import("../src/index.js");
  await ompFabric(omp);
  const handler = handlers.get("before_agent_start")?.[0];
  if (!handler) throw new Error("before_agent_start handler was not registered");
  return handler;
};

const configure = (fullCodeMode: boolean): void => {
  vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue("/tmp");
  vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue({
    ...structuredClone(DEFAULT_FABRIC_CONFIG),
    fullCodeMode,
  });
};

const systemPromptOf = async (
  handler: Handler,
  systemPrompt: string | string[],
): Promise<string[]> => {
  const result = await handler({ systemPrompt, prompt: "inspect source" }, {});
  return (result as { systemPrompt: string[] }).systemPrompt;
};

afterEach(() => {
  guidanceSwitch.forceEmpty = false;
  setActiveSkills([]);
  vi.restoreAllMocks();
});

describe("before_agent_start system prompt parts", () => {
  it("keeps host parts separate and in order and restores skills in the part that carries them", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const host = [
      "Core identity",
      "Tools\n- read",
      "Memories\n- recalled fact",
      SKILLS_HEADING,
      "Tail rules",
    ];

    const parts = await systemPromptOf(handler, [...host]);

    expect(parts).toHaveLength(host.length + 1);
    expect(parts.slice(0, 3)).toEqual(host.slice(0, 3));
    expect(parts[3]!.startsWith(SKILLS_HEADING)).toBe(true);
    expect(parts[3]).toContain(FABRIC_LOAD_INSTRUCTION);
    expect(parts[3]).toContain("- release-risk: Review launch plans for operational risk.");
    expect(parts[4]).toBe("Tail rules");
    expect(parts.slice(0, 5).filter((part) => part.includes("release-risk"))).toHaveLength(1);
  });

  it("appends guidance as a separate trailing part and never inside a host part", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const host = ["Core identity", SKILLS_HEADING];

    const parts = await systemPromptOf(handler, [...host]);
    const guidance = parts.at(-1)!;

    expect(parts).toHaveLength(host.length + 1);
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance).toContain("fabric_exec");
    expect(host).not.toContain(guidance);
    expect(parts.slice(0, -1).some((part) => part.includes(guidance))).toBe(false);
  });

  it("leaves every part before a changed part byte-identical between turns", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const stable = ["Core identity", SKILLS_HEADING, "Tools\n- read"];

    const first = await systemPromptOf(handler, [...stable, "Memories\n- fact A"]);
    const second = await systemPromptOf(handler, [...stable, "Memories\n- fact B"]);

    expect(second.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(second[3]).not.toBe(first[3]);
    expect(second.at(-1)).toBe(first.at(-1));
  });

  it("keeps the host's volatile segments leading their own parts so the provider cache anchor survives", async () => {
    // Mirrors OMP's provider rule (pi-ai anthropic.ts VOLATILE_SYSTEM_SEGMENT_MARKERS):
    // the cache breakpoint sits on the block before the first part that STARTS with
    // one of these tags. Joining the parts into one string would hide the tags.
    const MARKERS = ["<memories>", "<project-context>"];
    const anchorIndex = (parts: readonly string[]): number => {
      const index = parts.findIndex((part) => MARKERS.some((marker) => part.startsWith(marker)));
      return index === -1 ? parts.length : index;
    };
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const stable = ["Core identity", SKILLS_HEADING, "Tools\n- read"];

    const first = await systemPromptOf(handler, [
      ...stable,
      "<memories>\n- fact A",
      "<project-context>\ncwd /a",
    ]);
    const second = await systemPromptOf(handler, [
      ...stable,
      "<memories>\n- fact B",
      "<project-context>\ncwd /b",
    ]);

    expect(anchorIndex(first)).toBe(3);
    expect(anchorIndex(second)).toBe(3);
    expect(first[3]!.startsWith("<memories>")).toBe(true);
    expect(first[4]!.startsWith("<project-context>")).toBe(true);
    expect(second.slice(0, anchorIndex(second))).toEqual(first.slice(0, anchorIndex(first)));
    // Fabric's own guidance rides after the volatile segments, never inside the cached head.
    expect(first.slice(0, 3).some((part) => part.includes("OMP Fabric full code mode"))).toBe(false);
    expect(first.at(-1)).toContain("OMP Fabric full code mode");
    // The old joined-string form had no leading tag, so the provider found no anchor at all.
    expect(anchorIndex([first.join("\n")])).toBe(1);
  });

  it("restores the load instruction inside the part that holds the skills section", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const section = `${OMP_LOAD_INSTRUCTION}\n<skills>\n- other: Another skill.\n</skills>`;
    const host = ["Core identity", section, `See ${OMP_LOAD_INSTRUCTION} elsewhere`];

    const parts = await systemPromptOf(handler, [...host]);

    expect(parts[0]).toBe("Core identity");
    expect(parts[1]).toBe(section.replace(OMP_LOAD_INSTRUCTION, FABRIC_LOAD_INSTRUCTION));
    expect(parts[2]).toBe(host[2]);
    expect(parts).toHaveLength(host.length + 1);
  });

  it("appends the restored skills as an extra part when no part carries them", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const host = ["Core identity", "Tools\n- read"];

    const parts = await systemPromptOf(handler, [...host]);

    expect(parts).toHaveLength(host.length + 2);
    expect(parts.slice(0, 2)).toEqual(host);
    expect(parts[2]).toContain("<skills>");
    expect(parts[2]).toContain("- release-risk: Review launch plans for operational risk.");
  });

  it("restores a single part exactly as the joined-string path did", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const only = "Core prompt\n\n§ Runtime\n# Skills & Rules\n";

    const parts = await systemPromptOf(handler, [only]);

    expect(parts[0]).toBe(restoreSkillsForFullCodePrompt(only, skills));
    expect(parts).toHaveLength(2);
  });

  it("keeps working when an older host passes the system prompt as one string", async () => {
    setActiveSkills(skills);
    configure(true);
    const handler = await registerExtension();
    const only = "Core prompt\n\n§ Runtime\n# Skills & Rules\n";

    const parts = await systemPromptOf(handler, only);

    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toBe(restoreSkillsForFullCodePrompt(only, skills));
    expect(parts[0]).toContain(FABRIC_LOAD_INSTRUCTION);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain("fabric_exec");
  });

  it("passes the host parts through unchanged outside full code mode", async () => {
    setActiveSkills(skills);
    configure(false);
    const handler = await registerExtension();
    const host = ["Core identity", "Memories\n- recalled fact", SKILLS_HEADING];

    const parts = await systemPromptOf(handler, [...host]);

    expect(parts.slice(0, 3)).toEqual(host);
    expect(parts.slice(3).every((part) => part.length > 0)).toBe(true);
  });

  it("adds no empty part when there is no guidance", async () => {
    setActiveSkills(skills);
    configure(false);
    guidanceSwitch.forceEmpty = true;
    const handler = await registerExtension();
    const host = ["Core identity", "Memories\n- recalled fact"];

    const parts = await systemPromptOf(handler, [...host]);

    expect(parts).toEqual(host);
  });
});

describe("prompt part helpers", () => {
  it("wraps a string prompt as one part and leaves parts alone", () => {
    expect(hostPromptParts("one string")).toEqual(["one string"]);
    const parts = ["a", "b"];
    expect(hostPromptParts(parts)).toBe(parts);
  });

  it("prefers the part holding the skills section over one holding only the heading", () => {
    const heading = `early\n${SKILLS_HEADING}`;
    const section = `${OMP_LOAD_INSTRUCTION}\n<skills>\n- other: x\n</skills>`;

    const parts = restoreSkillsInPromptParts([heading, section], skills);

    expect(parts[0]).toBe(heading);
    expect(parts[1]).toContain(FABRIC_LOAD_INSTRUCTION);
  });

  it("does not mutate its input and adds nothing when no skill is visible", () => {
    const host = ["Core identity", SKILLS_HEADING];
    const hidden = [{ ...skills[0]!, hide: true }];

    expect(restoreSkillsInPromptParts(host, hidden)).toEqual(host);
    expect(restoreSkillsInPromptParts(["Core identity"], hidden)).toEqual(["Core identity"]);
    restoreSkillsInPromptParts(host, skills);
    expect(host).toEqual(["Core identity", SKILLS_HEADING]);
  });
});
