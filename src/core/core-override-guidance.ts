import type { CapturedToolCatalog } from "../capture/catalog.js";
import { OMP_CORE_TOOL_NAMES } from "./omp-tools.js";

/**
 * Append authored guidance from the current exact-name core overrides without
 * presenting those definitions as separate extension tools.
 */
export const coreOverridePromptGuidance = (
  catalog: CapturedToolCatalog,
): string => {
  const sections: string[] = [];
  for (const name of OMP_CORE_TOOL_NAMES) {
    const entry = catalog.get(name);
    if (!entry) continue;
    const definition = entry.definition;
    const snippet = Reflect.get(definition, "promptSnippet");
    const guidelines = Reflect.get(definition, "promptGuidelines");
    const lines: string[] = [];
    if (typeof snippet === "string" && snippet.length > 0) {
      lines.push(`Additional guidance for \`omp.${name}\`: ${snippet}`);
    }
    if (Array.isArray(guidelines) && guidelines.every((guideline): guideline is string => typeof guideline === "string")) {
      lines.push(`Guidelines for \`omp.${name}\`:`);
      lines.push(...guidelines.map((guideline) => `- ${guideline}`));
    }
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  return sections.length > 0
    ? `\n\nEffective compatible core override guidance:\n${sections.join("\n")}`
    : "";
};
