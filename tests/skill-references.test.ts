import { describe, expect, it } from "vitest";
import {
  buildSkillReferenceGuidance,
  type SkillReference,
} from "../src/core/skill-references.js";

const skills: SkillReference[] = [
  {
    name: "grill-me",
    filePath: "/skills/grill-me/SKILL.md",
    hide: true,
  },
  {
    name: "grilling",
    filePath: "/skills/grilling/SKILL.md",
  },
  {
    name: "research",
    filePath: "/skills/research/SKILL.md",
  },
  {
    name: "private-flow",
    filePath: "/skills/private-flow/SKILL.md",
    hide: true,
  },
];

const expandedPrompt = (body: string, args = "") => {
  const block = [
    '<skill name="grill-me" location="/skills/grill-me/SKILL.md">',
    "References are relative to /skills/grill-me.",
    "",
    body,
    "</skill>",
  ].join("\n");
  return args ? `${block}\n${args}` : block;
};

describe("skill reference guidance", () => {
  it("resolves an invoked model-visible skill from an expanded wrapper", () => {
    const guidance = buildSkillReferenceGuidance(
      expandedPrompt("Run a `/grilling` session."),
      skills,
    );

    expect(guidance).toContain('active skill "grill-me" is already expanded');
    expect(guidance).toContain('- /grilling -> "/skills/grilling/SKILL.md"');
    expect(guidance).not.toContain("/research ->");
  });

  it("supports OMP-style delegated skill commands", () => {
    const guidance = buildSkillReferenceGuidance(
      expandedPrompt("Load `/skill:research` and follow its process."),
      skills,
    );

    expect(guidance).toContain('- /research -> "/skills/research/SKILL.md"');
  });

  it("does not resolve references from user arguments outside the skill block", () => {
    const guidance = buildSkillReferenceGuidance(
      expandedPrompt("Interview the user.", "Please run /research too."),
      skills,
    );

    expect(guidance).toBeUndefined();
  });

  it("does not bypass disabled model invocation", () => {
    const guidance = buildSkillReferenceGuidance(
      expandedPrompt("Run the `/private-flow` skill."),
      skills,
    );

    expect(guidance).toBeUndefined();
  });

  it("ignores negated and non-invocation references", () => {
    expect(
      buildSkillReferenceGuidance(
        expandedPrompt("Do not use `/research`."),
        skills,
      ),
    ).toBeUndefined();
    expect(
      buildSkillReferenceGuidance(
        expandedPrompt("The related skill is `/research`."),
        skills,
      ),
    ).toBeUndefined();
    expect(
      buildSkillReferenceGuidance(
        expandedPrompt("When more evidence is needed, use `/research`."),
        skills,
      ),
    ).toBeUndefined();
  });

  it("ignores ordinary prompts and malformed expanded blocks", () => {
    expect(buildSkillReferenceGuidance("Run /grilling", skills)).toBeUndefined();
    expect(
      buildSkillReferenceGuidance(
        '<skill name="grill-me" location="/skills/grill-me/SKILL.md">\nRun /grilling',
        skills,
      ),
    ).toBeUndefined();
  });
});
