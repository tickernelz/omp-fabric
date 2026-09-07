import type { Skill } from "@oh-my-pi/pi-coding-agent";

export const formatSkillsSection = (
  skills: readonly Skill[],
  instruction: string,
): string => {
  const visibleSkills = skills.filter((skill) => skill.hide !== true);
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [instruction, "<skills>"];
  for (const skill of visibleSkills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  lines.push("</skills>");
  return lines.join("\n");
};

export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

export const parseSkillBlock = (text: string): ParsedSkillBlock | null => {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1]!,
    location: match[2]!,
    content: match[3]!,
    userMessage: match[4]?.trim() || undefined,
  };
};
