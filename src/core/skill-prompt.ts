
import { getActiveSkills, Settings, type Skill } from "@oh-my-pi/pi-coding-agent";
import { cfgSkillful } from "@oh-my-pi/pi-coding-agent/session/settings";
import { formatSkillsSection } from "./skill-block.js";

const OMP_SKILL_SECTION_MARKER = "<skills>";
const OMP_SKILL_SECTION_HEADING = "# Skills & Rules\n";
const OMP_SKILL_LOAD_INSTRUCTION = "Matching skill → MUST read \`skill://<name>\` first.";
const OMP_CUSTOM_SKILL_LOAD_INSTRUCTION =
  "If a skill applies, you MUST read \`skill://<name>\` before proceeding.";
const FABRIC_OMP_SKILL_LOAD_INSTRUCTION =
  "Matching skill → MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` first.";
const FABRIC_CUSTOM_SKILL_LOAD_INSTRUCTION =
  "If a skill applies, you MUST read \`skill://<name>\` through \`omp.read\` inside \`fabric_exec\` before proceeding.";

export const activeSkills = (): readonly Skill[] => getActiveSkills();

export const listableSkills = (skills: readonly Skill[]): readonly Skill[] => {
  try {
    if (cfgSkillful.get(Settings.instance) === false) return [];
  } catch {
    return skills;
  }
  return skills;
};

export const restoreSkillsForFullCodePrompt = (
  systemPrompt: string,
  skills: readonly Skill[],
): string => {
  if (systemPrompt.includes(OMP_SKILL_SECTION_MARKER)) {
    return systemPrompt
      .replace(OMP_SKILL_LOAD_INSTRUCTION, FABRIC_OMP_SKILL_LOAD_INSTRUCTION)
      .replace(OMP_CUSTOM_SKILL_LOAD_INSTRUCTION, FABRIC_CUSTOM_SKILL_LOAD_INSTRUCTION);
  }
  const section = formatSkillsSection(skills, FABRIC_OMP_SKILL_LOAD_INSTRUCTION);
  if (!section) return systemPrompt;
  const heading = systemPrompt.indexOf(OMP_SKILL_SECTION_HEADING);
  if (heading < 0) return `${systemPrompt}\n\n${section}`;
  const insertAt = heading + OMP_SKILL_SECTION_HEADING.length;
  return `${systemPrompt.slice(0, insertAt)}${section}\n${systemPrompt.slice(insertAt)}`;
};

/**
 * Older hosts pass the system prompt as one string instead of as parts.
 */
export const hostPromptParts = (prompt: string | readonly string[]): readonly string[] =>
  typeof prompt === "string" ? [prompt] : prompt;

/**
 * Restores the skills section inside the one prompt part that carries it and
 * leaves every other part untouched and in order. The part holding the
 * `<skills>` section wins, then the part holding the skills heading. With no
 * such part, the restored section is appended as an extra part.
 */
export const restoreSkillsInPromptParts = (
  parts: readonly string[],
  skills: readonly Skill[],
): string[] => {
  const marked = parts.findIndex((part) => part.includes(OMP_SKILL_SECTION_MARKER));
  const index = marked >= 0
    ? marked
    : parts.findIndex((part) => part.includes(OMP_SKILL_SECTION_HEADING));
  if (index >= 0) {
    return parts.map((part, i) =>
      i === index ? restoreSkillsForFullCodePrompt(part, skills) : part
    );
  }
  const section = formatSkillsSection(skills, FABRIC_OMP_SKILL_LOAD_INSTRUCTION);
  return section ? [...parts, section] : [...parts];
};
