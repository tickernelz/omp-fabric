
import {
  type ExtensionAPI,
  setActiveSkills,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";
import {
  activeSkills,
  listableSkills,
  restoreSkillsForFullCodePrompt,
} from "../src/core/skill-prompt.js";

const makeSkill = (
  input: Pick<Skill, "name" | "description" | "filePath"> & Partial<Skill>,
): Skill => ({
  baseDir: `/skills/${input.name}`,
  source: "test",
  hide: false,
  ...input,
});

const skills: Skill[] = [
  makeSkill({
    name: "release-risk",
    description: "Review launch plans for operational risk.",
    filePath: "/skills/release-risk/SKILL.md",
  }),
  makeSkill({
    name: "manual-only",
    description: "Run only when explicitly invoked.",
    filePath: "/skills/manual-only/SKILL.md",
    hide: true,
  }),
];

const occurrences = (value: string, search: string): number =>
  value.split(search).length - 1;

const registerExtension = async (): Promise<
  (event: unknown, context: unknown) => unknown
> => {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const omp = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => ["fabric_exec"]),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: (event: unknown, context: unknown) => unknown) => {
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

afterEach(() => {
  setActiveSkills([]);
  vi.restoreAllMocks();
});

describe("full code skill prompt", () => {
  it("reads the session's loaded skills from the host registry", () => {
    setActiveSkills(skills);
    expect(activeSkills().map((skill) => skill.name)).toEqual([
      "release-risk",
      "manual-only",
    ]);
    expect(listableSkills(skills)).toEqual(skills);
  });

  it("restores OMP's skills section when the host omitted it", () => {
    setActiveSkills(skills);
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt\n\n§ Runtime\n# Skills & Rules\n\nEnvironment: linux",
      listableSkills(activeSkills()),
    );

    expect(prompt).toContain("Matching skill → MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` first.");
    expect(prompt).toContain(
      "<skills>\n- release-risk: Review launch plans for operational risk.\n</skills>",
    );
    expect(prompt).not.toContain("manual-only");
    expect(prompt).toContain("# Skills & Rules\nMatching skill");
    expect(prompt.endsWith("Environment: linux")).toBe(true);
  });

  it("emits skill metadata verbatim, as the host's noEscape renderer does", () => {
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt",
      [makeSkill({
        name: "review",
        description: 'Review <plans> & "risks".',
        filePath: "/skills/a&b/SKILL.md",
      })],
    );

    expect(prompt).toContain('- review: Review <plans> & "risks".');
    expect(prompt).not.toContain("&amp;");
  });

  it("adapts OMP's rendered skill section instead of duplicating it", () => {
    const original = [
      "Core prompt",
      "§ Runtime",
      "# Skills & Rules",
      "Matching skill → MUST read \`skill://<name>\` first.",
      "<skills>",
      "- release-risk: Review launch plans for operational risk.",
      "</skills>",
      "Environment: linux",
    ].join("\n");

    const prompt = restoreSkillsForFullCodePrompt(original, skills);

    expect(occurrences(prompt, "<skills>")).toBe(1);
    expect(prompt).toContain("Matching skill → MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` first.");
  });

  it("adapts the custom system prompt's skill instruction too", () => {
    const original = [
      "Custom prompt",
      "If a skill applies, you MUST read \`skill://<name>\` before proceeding.",
      "<skills>",
      '<skill name="release-risk">',
      "</skills>",
    ].join("\n");

    expect(restoreSkillsForFullCodePrompt(original, skills)).toContain(
      "If a skill applies, you MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` before proceeding.",
    );
  });

  it("stays idempotent when the section was already restored", () => {
    const once = restoreSkillsForFullCodePrompt(
      "Core prompt\n\n§ Runtime\n# Skills & Rules\n\nEnvironment: linux",
      skills,
    );
    expect(restoreSkillsForFullCodePrompt(once, skills)).toBe(once);
    expect(occurrences(once, "<skills>")).toBe(1);
  });

  it("leaves the prompt unchanged when every skill requires explicit invocation", () => {
    const prompt = "Core prompt\nCurrent working directory: /workspace";
    expect(
      restoreSkillsForFullCodePrompt(prompt, [skills[1]!]),
    ).toBe(prompt);
  });

  it("appends the catalog when a custom prompt has no skills heading", () => {
    const prompt = restoreSkillsForFullCodePrompt("Custom prompt", skills);

    expect(prompt.startsWith("Custom prompt\n\nMatching skill")).toBe(true);
    expect(prompt).toContain("- release-risk:");
  });
});

describe("full code before_agent_start skill listing", () => {
  it("carries the session's skills into the full code system prompt", async () => {
    setActiveSkills(skills);
    vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue("/tmp");
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue({
      ...structuredClone(DEFAULT_FABRIC_CONFIG),
      fullCodeMode: true,
    });
    const handler = await registerExtension();
    const result = await handler({
      systemPrompt: ["Core prompt\n\n§ Runtime\n# Skills & Rules\n"],
      prompt: "inspect source",
    }, {});
    const prompt = (result as { systemPrompt: string[] }).systemPrompt[0]!;

    expect(prompt).toContain("Matching skill → MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` first.");
    expect(prompt).toContain("- release-risk: Review launch plans for operational risk.");
    expect(prompt).not.toContain("manual-only");
  });

  it("resolves skill invocations against the session's skills", async () => {
    setActiveSkills([
      makeSkill({
        name: "active",
        description: "Active workflow",
        filePath: "/skills/active/SKILL.md",
        hide: true,
      }),
      makeSkill({
        name: "dependency",
        description: "Required dependency",
        filePath: "/skills/dependency/SKILL.md",
      }),
    ]);
    vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue("/tmp");
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue({
      ...structuredClone(DEFAULT_FABRIC_CONFIG),
      fullCodeMode: true,
    });
    const handler = await registerExtension();
    const result = await handler({
      systemPrompt: ["Core prompt"],
      prompt: [
        '<skill name="active" location="/skills/active/SKILL.md">',
        "",
        "Always use /dependency.",
        "</skill>",
        "",
        "Inspect source",
      ].join("\n"),
    }, {});
    const message = (result as { message?: { content: string } }).message;

    expect(message?.content).toContain('The active skill "active" is already expanded');
    expect(message?.content).toContain('- /dependency -> "/skills/dependency/SKILL.md"');
  });
});
