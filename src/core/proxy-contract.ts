import { OMP_CORE_TOOL_NAME_SET } from "./omp-tools.js";

export const PROXY_CONTRACT_CUSTOM_TYPE = "omp-fabric-proxy";

const FABRIC_EXEC_TOOL = "fabric_exec";
const MAX_PROXY_NAMES = 8;

// Same envelopes the furnace strips before scoring. Here they are the *only*
// source of evidence: ambient skill prose, not user intent.
const SKILL_REGION =
  /<available_skills\b[^>]*>[\s\S]*?(?:<\/available_skills\s*>|$)|<skill\b[^>]*>[\s\S]*?(?:<\/skill\s*>|$)/g;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isRewritableCapturedToolName = (name: string): boolean => {
  if (!name || name === FABRIC_EXEC_TOOL) return false;
  if (OMP_CORE_TOOL_NAME_SET.has(name)) return false;
  return name.includes("_") || name.length >= 10;
};

export const rewritableHiddenCapturedToolNames = (
  names: Iterable<string>,
): string[] =>
  [...new Set(names)]
    .filter(isRewritableCapturedToolName)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

const mentionPattern = (name: string): RegExp =>
  new RegExp(`(?<![\\w.])${escapeRegex(name)}(?![\\w])`);

export const extractSkillRegions = (text: string): string => {
  const regions: string[] = [];
  for (const match of text.matchAll(SKILL_REGION)) {
    const region = match[0];
    if (region) regions.push(region);
  }
  return regions.join("\n");
};

export const capturedToolMentions = (
  text: string,
  names: readonly string[],
): string[] => names.filter((name) => mentionPattern(name).test(text));

export const proxyContractMentionsInSkills = (
  prompt: string,
  systemPrompt: string,
  names: readonly string[],
): string[] => {
  const envelope = `${extractSkillRegions(prompt)}\n${extractSkillRegions(systemPrompt)}`;
  if (envelope.trim().length === 0) return [];
  return capturedToolMentions(envelope, names).slice(0, MAX_PROXY_NAMES);
};

export const formatProxyContractReminder = (names: readonly string[]): string => {
  const rows = names.map((name) => `\u25aa ${name} \u2192 extensions.${name}`);
  return [
    "Proxy contract: these names in the loaded skill are captured tools, not top-level calls.",
    "Call them as `extensions.<name>({...})` inside `fabric_exec`.",
    "",
    ...rows,
  ].join("\n");
};

const namesFromEntry = (entry: {
  type?: unknown;
  customType?: unknown;
  details?: unknown;
}): string[] => {
  if (entry.type !== "custom_message" || entry.customType !== PROXY_CONTRACT_CUSTOM_TYPE) {
    return [];
  }
  const details = entry.details as { names?: unknown } | undefined;
  if (Array.isArray(details?.names)) {
    return details.names.filter((name): name is string => typeof name === "string" && name.length > 0);
  }
  return [];
};

/**
 * Branch-local set of captured names already reminded. Restored from
 * `omp-fabric-proxy` transcript entries only — never counted as furnace fires.
 */
export class ProxyContractLedger {
  #reminded = new Set<string>();

  reset(): void {
    this.#reminded.clear();
  }

  restoreFromEntries(entries: readonly unknown[]): void {
    this.#reminded.clear();
    for (const entryUnknown of entries) {
      if (typeof entryUnknown !== "object" || entryUnknown === null) continue;
      for (const name of namesFromEntry(entryUnknown as Parameters<typeof namesFromEntry>[0])) {
        this.#reminded.add(name);
      }
    }
  }

  take(candidates: readonly string[]): string[] {
    const fresh = candidates.filter((name) => !this.#reminded.has(name));
    for (const name of fresh) this.#reminded.add(name);
    return fresh;
  }
}
