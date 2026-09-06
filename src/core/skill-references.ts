export interface SkillReference {
  name: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

const INVOCATION_VERB =
  /^\s*(?:[-*]\s*)?(?:(?:then|next|first|always|must|you must)\s+)?(?:run|invoke|load|start|follow|use)\b/i;
const NEGATED_INVOCATION =
  /^\s*(?:[-*]\s*)?(?:do not|don't|never)\s+(?:run|invoke|load|start|follow|use)\b/i;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const referencesSkill = (line: string, skillName: string): boolean => {
  const name = escapeRegex(skillName);
  return new RegExp(`/(?:skill:)?${name}(?=[\\s\`'".,;:!?<>)\\]}]|$)`, "i").test(line);
};

export const buildSkillReferenceGuidance = (
  prompt: string,
  skills: readonly SkillReference[],
): string | undefined => {
  const active = skills.find((skill) =>
    prompt.startsWith(`<skill name="${skill.name}" location="${skill.filePath}">`),
  );
  if (!active) return undefined;

  const closingTag = prompt.indexOf("</skill>");
  if (closingTag < 0) return undefined;
  const openingEnd = prompt.indexOf("\n\n");
  if (openingEnd < 0 || openingEnd >= closingTag) return undefined;
  const body = prompt.slice(openingEnd + 2, closingTag);
  const invocationLines = body
    .split("\n")
    .filter((line) => INVOCATION_VERB.test(line) && !NEGATED_INVOCATION.test(line));

  const referenced = skills.filter(
    (skill) =>
      skill.name !== active.name &&
      skill.disableModelInvocation !== true &&
      invocationLines.some((line) => referencesSkill(line, skill.name)),
  );
  if (referenced.length === 0) return undefined;

  const mappings = referenced
    .map((skill) => `- /${skill.name} -> ${JSON.stringify(skill.filePath)}`)
    .join("\n");
  return [
    `The active skill ${JSON.stringify(active.name)} is already expanded; do not reread ${JSON.stringify(active.filePath)}.`,
    "Resolve the skill invocations below before task exploration:",
    mappings,
    "Load each mapped SKILL.md through omp.read inside fabric_exec and follow it. Skill loading is a dependency, not task exploration. Continue the active workflow after tool results and later user replies until it completes.",
  ].join("\n");
};
