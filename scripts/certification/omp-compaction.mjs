import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as OMP from "@oh-my-pi/pi-coding-agent";
import { estimateTokens } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { prepareCompaction, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { registerCompactionHook } from "../../dist/compaction/hook.js";

const HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";
const CORE_COMPACTION_MODULE = "@oh-my-pi/pi-agent-core/compaction";
const HOST_SHIM_MODULE = "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

const hostPackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(HOST_PACKAGE))));
const hostPackage = JSON.parse(fs.readFileSync(path.join(hostPackageRoot, "package.json"), "utf8"));
const fabricPackage = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
);

const declaredHostRange = fabricPackage.peerDependencies?.[HOST_PACKAGE];
if (typeof declaredHostRange !== "string" || declaredHostRange.trim() === "") {
  throw new Error(
    `omp-fabric declares no ${HOST_PACKAGE} peer range, so certification has no host contract to verify`,
  );
}

const parseVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(value).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
};

const satisfiesComparator = (version, comparator) => {
  if (comparator === "*" || comparator === "x") return true;
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(comparator);
  const bound = match ? parseVersion(match[2]) : undefined;
  if (!bound) {
    throw new Error(
      `Declared ${HOST_PACKAGE} peer range "${declaredHostRange}" uses a comparator certification cannot evaluate: "${comparator}"`,
    );
  }
  const majorCeiling = [bound[0] + 1, 0, 0];
  const minorCeiling = [bound[0], bound[1] + 1, 0];
  switch (match[1] ?? "=") {
    case ">=":
      return compareVersions(version, bound) >= 0;
    case ">":
      return compareVersions(version, bound) > 0;
    case "<=":
      return compareVersions(version, bound) <= 0;
    case "<":
      return compareVersions(version, bound) < 0;
    case "^":
      return compareVersions(version, bound) >= 0
        && compareVersions(version, bound[0] === 0 ? minorCeiling : majorCeiling) < 0;
    case "~":
      return compareVersions(version, bound) >= 0 && compareVersions(version, minorCeiling) < 0;
    default:
      return compareVersions(version, bound) === 0;
  }
};

const satisfiesRange = (version, range) => range.split("||").some((group) =>
  group
    .replace(/(>=|<=|>|<|=|\^|~)\s+/gu, "$1")
    .trim()
    .split(/\s+/u)
    .filter((comparator) => comparator !== "")
    .every((comparator) => satisfiesComparator(version, comparator)));

const hostVersion = parseVersion(hostPackage.version);
if (!hostVersion) {
  throw new Error(
    `Installed ${HOST_PACKAGE} at ${hostPackageRoot} reports an unparseable version: ${String(hostPackage.version)}`,
  );
}
if (!satisfiesRange(hostVersion, declaredHostRange)) {
  throw new Error(
    `Certification requires an installed ${HOST_PACKAGE} inside omp-fabric's declared peer range "${declaredHostRange}"; resolved ${hostPackage.version} at ${hostPackageRoot}`,
  );
}

const requiredHostSurface = {
  [`${HOST_PACKAGE} buildSessionContext`]: OMP.buildSessionContext,
  [`${HOST_SHIM_MODULE} estimateTokens`]: estimateTokens,
  [`${CORE_COMPACTION_MODULE} prepareCompaction`]: prepareCompaction,
  [`${CORE_COMPACTION_MODULE} shouldCompact`]: shouldCompact,
};
const missingHostSurface = Object.entries(requiredHostSurface)
  .filter(([, value]) => typeof value !== "function")
  .map(([name]) => name);
if (missingHostSurface.length > 0) {
  throw new Error(
    `Installed ${HOST_PACKAGE} ${hostPackage.version} does not expose the compaction surface this certification measures: ${missingHostSurface.join(", ")}`,
  );
}

export const HOST_COMPACTION_API = Object.freeze({
  hostPackage: HOST_PACKAGE,
  hostVersion: hostPackage.version,
  declaredPeerRange: declaredHostRange,
  resolvedFrom: Object.freeze({
    buildSessionContext: HOST_PACKAGE,
    estimateTokens: HOST_SHIM_MODULE,
    prepareCompaction: CORE_COMPACTION_MODULE,
    shouldCompact: CORE_COMPACTION_MODULE,
  }),
  rootExports: Object.freeze({
    buildSessionContext: typeof OMP.buildSessionContext === "function",
    prepareCompaction: typeof OMP.prepareCompaction === "function",
    shouldCompact: typeof OMP.shouldCompact === "function",
    buildContextEntries: typeof OMP.buildContextEntries === "function",
  }),
});

const SMALL_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  reserveTokens: 63,
  keepRecentTokens: 1,
});

const SMALL_CONTEXT_WINDOW = 64;

const hostContextTokens = (manager) =>
  manager.buildSessionContext().messages.reduce((total, message) => total + estimateTokens(message), 0);

export const contextMessagesFromEntries = (entries) => OMP.buildSessionContext(
  entries,
  entries.at(-1)?.id ?? null,
  new Map(entries.map((entry) => [entry.id, entry])),
).messages;

export const contextMessagesMatch = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

export const prepareEligibleCompaction = (
  manager,
  settings = SMALL_COMPACTION_SETTINGS,
  contextWindow = SMALL_CONTEXT_WINDOW,
) => {
  const branchEntries = manager.getBranch();
  const contextMessages = manager.buildSessionContext().messages;
  const publicContextMessages = OMP.buildSessionContext(
    manager.getEntries(),
    manager.getLeafId(),
  ).messages;
  const contextTokens = hostContextTokens(manager);
  const eligible = shouldCompact(contextTokens, contextWindow, settings);
  const preparation = eligible ? prepareCompaction(branchEntries, settings) : undefined;
  return {
    branchEntries,
    contextMessages,
    publicContextMessages,
    contextTokens,
    contextWindow,
    eligible,
    preparation,
  };
};

let fabricHandler;
const fakeOMP = {
  on(name, handler) {
    if (name === "session_before_compact") fabricHandler = handler;
  },
};
registerCompactionHook(fakeOMP, { getEngine: () => "fabric" });
if (typeof fabricHandler !== "function") throw new Error("Fabric compaction hook was not registered");

export const invokeRegisteredFabricCompactor = ({ preparation, branchEntries, customInstructions }) => {
  let previousSummaryReads = 0;
  const instrumentedPreparation = new Proxy(preparation, {
    get(target, property, receiver) {
      if (property === "previousSummary") previousSummaryReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const event = {
    type: "session_before_compact",
    preparation: instrumentedPreparation,
    branchEntries,
    ...(customInstructions === undefined ? {} : { customInstructions }),
    signal: new AbortController().signal,
  };
  const result = fabricHandler(event, undefined);
  return {
    event,
    result,
    instrumentation: {
      previousSummaryReads,
      priorSummaryFedAsInput: previousSummaryReads > 0,
    },
  };
};

export const appendFabricCompaction = (manager, compaction, summary = compaction.summary) =>
  manager.appendCompaction(
    summary,
    compaction.shortSummary,
    compaction.firstKeptEntryId,
    compaction.tokensBefore,
    { details: compaction.details, fromExtension: true },
  );

export const contextSubchainAfterCompaction = (branchEntries, compactionEntry) => {
  if (!compactionEntry.firstKeptEntryId) return [compactionEntry];
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
  if (firstKeptIndex < 0) return [compactionEntry];
  return [...branchEntries.slice(firstKeptIndex), compactionEntry];
};
