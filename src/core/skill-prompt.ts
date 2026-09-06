import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { formatSkillsForPrompt } from "./skill-block.js";

const OMP_SKILL_SECTION_MARKER = "<skills>";
const OMP_SKILL_LOAD_INSTRUCTION = "Matching skill → MUST read `skill://<name>` first.";
const FABRIC_OMP_SKILL_LOAD_INSTRUCTION =
  "Matching skill → MUST read `skill://<name>` through `omp.read` inside `fabric_exec` first.";
const LEGACY_SKILL_LOAD_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";
const FABRIC_SKILL_LOAD_INSTRUCTION =
  "Use `omp.read` inside `fabric_exec` to load a skill's file when the task matches its description.";

export const restoreSkillsForFullCodePrompt = (
  systemPrompt: string,
  skills: readonly Skill[],
): string => {
  if (systemPrompt.includes(OMP_SKILL_SECTION_MARKER)) {
    return systemPrompt.replace(
      OMP_SKILL_LOAD_INSTRUCTION,
      FABRIC_OMP_SKILL_LOAD_INSTRUCTION,
    );
  }
  const section = formatSkillsForPrompt([...skills]).replace(
    LEGACY_SKILL_LOAD_INSTRUCTION,
    FABRIC_SKILL_LOAD_INSTRUCTION,
  );
  return section ? `${systemPrompt}${section}` : systemPrompt;
};
