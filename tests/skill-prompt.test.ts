import { type Skill } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { restoreSkillsForFullCodePrompt } from "../src/core/skill-prompt.js";

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

describe("full code skill prompt", () => {
  it("appends the catalog when OMP omitted its skills section", () => {
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt\n\n§ Runtime\n# Skills & Rules\n\nEnvironment: linux",
      skills,
    );

    expect(prompt).toContain(
      "Use `omp.read` inside `fabric_exec` to load a skill's file when the task matches its description.",
    );
    expect(prompt).toContain("<name>release-risk</name>");
    expect(prompt).not.toContain("manual-only");
    expect(prompt).not.toContain("Use the read tool to load a skill");
  });

  it("uses OMP's XML escaping for model-visible skill metadata", () => {
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt",
      [makeSkill({
        name: "review",
        description: 'Review <plans> & "risks".',
        filePath: "/skills/a&b/SKILL.md",
      })],
    );

    expect(prompt).toContain("Review &lt;plans&gt; &amp; &quot;risks&quot;.");
    expect(prompt).toContain("/skills/a&amp;b/SKILL.md");
  });

  it("adapts OMP's rendered skill section instead of duplicating it", () => {
    const original = [
      "Core prompt",
      "§ Runtime",
      "# Skills & Rules",
      "Matching skill → MUST read `skill://<name>` first.",
      "<skills>",
      "- release-risk: Review launch plans for operational risk.",
      "</skills>",
      "Environment: linux",
    ].join("\n");

    const prompt = restoreSkillsForFullCodePrompt(original, skills);

    expect(occurrences(prompt, "<skills>")).toBe(1);
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).toContain(
      "Matching skill → MUST read `skill://<name>` through `omp.read` inside `fabric_exec` first.",
    );
  });

  it("leaves the prompt unchanged when every skill requires explicit invocation", () => {
    const prompt = "Core prompt\nCurrent working directory: /workspace";
    expect(
      restoreSkillsForFullCodePrompt(prompt, [skills[1]!]),
    ).toBe(prompt);
  });

  it("appends the catalog when a custom prompt has no working-directory marker", () => {
    const prompt = restoreSkillsForFullCodePrompt("Custom prompt", skills);

    expect(prompt.startsWith("Custom prompt\n\nThe following skills")).toBe(true);
    expect(prompt).toContain("<available_skills>");
  });
});
