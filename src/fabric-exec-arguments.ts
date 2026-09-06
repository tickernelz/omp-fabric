import { normalizeRunDisplay } from "./run-display.js";
import { repairFabricGuestCode } from "./runtime/guest-code-repair.js";

const OPTIONAL_FABRIC_EXEC_KEYS = [
  "payloads",
  "resultFormat",
  "tokenBudget",
  "agentBudget",
  "timeoutMs",
  "display",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePayloads = (input: unknown): Record<string, string> | undefined => {
  let value = input;
  for (let attempt = 0; attempt < 2 && typeof value === "string"; attempt++) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) return undefined;
  return value as Record<string, string>;
};

export const resolveFabricExecPayloads = (params: { payloads?: unknown }): Record<string, string> | undefined =>
  parsePayloads(params.payloads);

export const prepareFabricExecArguments = (input: unknown): unknown => {
  if (typeof input === "string") return { code: repairFabricGuestCode(input) };
  if (!isRecord(input)) return input;
  let prepared = input;
  const writable = (): Record<string, unknown> => {
    if (prepared === input) prepared = { ...input };
    return prepared;
  };
  if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
    writable().code = prepared.code.join("\n");
  }
  if (typeof prepared.code === "string") {
    const repaired = repairFabricGuestCode(prepared.code);
    if (repaired !== prepared.code) writable().code = repaired;
  }
  for (const key of OPTIONAL_FABRIC_EXEC_KEYS) {
    if (Object.hasOwn(prepared, key) && (prepared[key] === null || prepared[key] === undefined)) {
      delete writable()[key];
    }
  }
  if (typeof prepared.display === "string" || isRecord(prepared.display)) {
    const normalized = normalizeRunDisplay(prepared.display);
    if (normalized) writable().display = normalized;
    else delete writable().display;
  }
  if (Object.hasOwn(prepared, "payloads")) {
    const normalized = parsePayloads(prepared.payloads);
    if (normalized && prepared.payloads !== normalized) writable().payloads = normalized;
  }
  return prepared;
};
