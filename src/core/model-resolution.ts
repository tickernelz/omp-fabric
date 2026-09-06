const PROVIDER_MODEL_RE = /^[^\s/]+\/[^\s/]+$/;

/** Minimal model view needed for resolution; satisfied by pi Model entries. */
export interface FabricModelCandidate {
  provider: string;
  id: string;
  name?: string;
}

export type FabricModelResolution =
  | { kind: "resolved"; model: FabricModelCandidate; via?: string }
  | { kind: "already-active"; model: FabricModelCandidate }
  | { kind: "ambiguous"; query: string; candidates: FabricModelCandidate[] }
  | { kind: "not-found"; query: string; tried?: string[] };

/** Markers reported in `via` when an inexact selector is fuzzy-resolved. */
export const FUZZY_RESOLUTION_MARKERS = ["closest", "recent", "latest"] as const;

const modelKey = (model: FabricModelCandidate): string => `${model.provider}/${model.id}`;

const sameModel = (
  left: FabricModelCandidate,
  right: FabricModelCandidate | undefined,
): boolean =>
  right !== undefined &&
  left.provider.toLowerCase() === right.provider.toLowerCase() &&
  left.id.toLowerCase() === right.id.toLowerCase();

/**
 * Normalize raw `models.aliases` config into alias name → ordered targets.
 * String targets degrade to one-element fallback chains. Entries whose name,
 * target list, or any `provider/model` target string is malformed are
 * dropped entirely, matching the lenient fallback style of the other config
 * normalizers (no partial alias survives with a silently missing target).
 */
export const normalizeModelAliases = (input: unknown): Record<string, string[]> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const aliases: Record<string, string[]> = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const values = typeof rawValue === "string" ? [rawValue] : rawValue;
    if (!Array.isArray(values) || values.length === 0) continue;
    const targets: string[] = [];
    let valid = true;
    for (const candidate of values) {
      if (typeof candidate !== "string") {
        valid = false;
        break;
      }
      const target = candidate.trim();
      if (!PROVIDER_MODEL_RE.test(target)) {
        valid = false;
        break;
      }
      if (!targets.includes(target)) targets.push(target);
    }
    if (valid && targets.length > 0) aliases[name] = targets;
  }
  return aliases;
};

const FUZZY_MIN_QUERY_LENGTH = 4;
const FUZZY_LEVENSHTEIN_MIN_RATIO = 0.55;

/**
 * Span covered when every character of `needle` appears in `haystack` in
 * order (first to last matched index), or Infinity when it does not. A tight
 * span keeps abbreviated selectors honest: "gmni" spans 6 chars in
 * "gemini-2.5-pro" but 10 in "gpt-5-mini", so only the former reads as the
 * same token with letters dropped.
 */
const subsequenceSpan = (needle: string, haystack: string): number => {
  let index = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < haystack.length && index < needle.length; i += 1) {
    if (haystack[i] === needle[index]) {
      if (first === -1) first = i;
      last = i;
      index += 1;
    }
  }
  return index === needle.length ? last - first + 1 : Number.POSITIVE_INFINITY;
};

/** Normalized Levenshtein similarity in [0, 1]; 1 means identical. */
const levenshteinRatio = (left: string, right: string): number => {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, column) => column);
  for (let i = 0; i < left.length; i += 1) {
    const current: number[] = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current.push(Math.min(
        previous[j]! + 1,
        current[j]! + 1,
        previous[j]! + (left[i] === right[j] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length);
};

/**
 * Closeness score for an inexact selector against one candidate. Tiered so a
 * substring hit always outranks a subsequence hit, which always outranks a
 * typo-level Levenshtein resemblance; coverage bonuses reward selectors that
 * span most of the target id name. Zero means no resemblance at all.
 */
const closenessScore = (query: string, model: FabricModelCandidate): number => {
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase();
  if (id.startsWith(query)) return 60 + (query.length / id.length) * 20;
  if (id.includes(query)) return 50 + (query.length / id.length) * 15;
  if (name?.startsWith(query) === true) return 45 + (query.length / name.length) * 15;
  if (name?.includes(query) === true) return 40 + (query.length / name.length) * 10;
  if (model.provider.toLowerCase().includes(query)) return 25;
  if (
    query.length >= 3 &&
    query[0] === id[0] &&
    subsequenceSpan(query, id) <= query.length + 2
  ) {
    return 18 + (query.length / id.length) * 6;
  }
  if (query.length >= FUZZY_MIN_QUERY_LENGTH) {
    const idRatio = levenshteinRatio(query, id);
    if (idRatio >= FUZZY_LEVENSHTEIN_MIN_RATIO) return 8 + idRatio * 10;
    if (name !== undefined) {
      const nameRatio = levenshteinRatio(query, name);
      if (nameRatio >= FUZZY_LEVENSHTEIN_MIN_RATIO) return 6 + nameRatio * 8;
    }
  }
  return 0;
};

export type FabricModelUsage = Record<string, number>;

/**
 * Pick the closest candidate for an inexact selector. Ranking is closeness
 * first; equal-closeness ties fall to the most recently used model (recency
 * timestamps such as pi-model-sort's extensions/pi-model-sort.json under the
 * agent dir, keyed by provider/id), then to the highest-sorting key, mirroring
 * OMP's convention that the newest alias/versioned id sorts last.
 */
const pickClosestCandidate = (
  query: string,
  pool: readonly FabricModelCandidate[],
  lastUsed: FabricModelUsage | undefined,
): { model: FabricModelCandidate; via: "closest" | "recent" | "latest" } | undefined => {
  const usage: FabricModelUsage = {};
  for (const [key, value] of Object.entries(lastUsed ?? {})) {
    usage[key.toLowerCase()] = value;
  }
  const recency = (model: FabricModelCandidate): number =>
    usage[`${model.provider}/${model.id}`.toLowerCase()] ?? 0;
  let best: FabricModelCandidate | undefined;
  let bestScore = 0;
  let tied = false;
  for (const model of pool) {
    const score = closenessScore(query, model);
    if (score <= 0) continue;
    if (best === undefined || score > bestScore) {
      best = model;
      bestScore = score;
      tied = false;
      continue;
    }
    if (score === bestScore) {
      tied = true;
      const bestRecent = recency(best);
      const nextRecent = recency(model);
      if (nextRecent > bestRecent || (nextRecent === bestRecent && modelKey(model) > modelKey(best))) {
        best = model;
      }
    }
  }
  if (best === undefined) return undefined;
  const runnersUp = pool.filter(
    (model) => model !== best && closenessScore(query, model) === bestScore,
  );
  const wonOnRecency = tied
    && runnersUp.some((model) => recency(model) !== recency(best));
  return {
    model: best,
    via: !tied ? "closest" : wonOnRecency ? "recent" : "latest",
  };
};

/**
 * Resolve a model selector against aliases and the available (authenticated)
 * registry. Order: alias lookup first so a configured name always wins, then
 * exact provider/id, exact id, then fuzzy selection. A lone partial match is
 * returned directly; broader candidate pools are ranked by closeness, with
 * equal-closeness ties falling to the most recently used model (when usage
 * timestamps are supplied, e.g. from pi-model-sort) and then to the
 * highest-sorting key, mirroring OMP's newest-alias convention. Only a pool
 * with no resemblance at all stays not-found; `ambiguous` is retained for
 * defensive completeness but the ranker always produces a deterministic pick.
 */
export const resolveFabricModel = (
  query: string,
  options: {
    aliases: Record<string, string[]>;
    available: readonly FabricModelCandidate[];
    current?: FabricModelCandidate;
    provider?: string;
    lastUsed?: FabricModelUsage;
  },
): FabricModelResolution => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { kind: "not-found", query };
  const providerFilter = options.provider?.trim().toLowerCase();
  const available = providerFilter
    ? options.available.filter((model) => model.provider.toLowerCase() === providerFilter)
    : [...options.available];
  if (available.length === 0) return { kind: "not-found", query };

  const aliasKey = Object.keys(options.aliases).find(
    (key) => key.toLowerCase() === normalized,
  );
  const tried: string[] = [];
  if (aliasKey !== undefined) {
    const chain = options.aliases[aliasKey] ?? [];
    for (const target of chain) {
      tried.push(target);
      const separator = target.indexOf("/");
      const provider = target.slice(0, separator);
      const id = target.slice(separator + 1);
      const match = available.find(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === id.toLowerCase(),
      );
      if (match) {
        return sameModel(match, options.current)
          ? { kind: "already-active", model: match }
          : { kind: "resolved", model: match, via: aliasKey };
      }
    }
    return { kind: "not-found", query, tried };
  }

  const exact = available.find((model) => modelKey(model).toLowerCase() === normalized)
    ?? available.find((model) => model.id.toLowerCase() === normalized);
  if (exact) {
    return sameModel(exact, options.current)
      ? { kind: "already-active", model: exact }
      : { kind: "resolved", model: exact };
  }

  const candidates = available.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      (model.name !== undefined && model.name.toLowerCase().includes(normalized)) ||
      model.provider.toLowerCase().includes(normalized),
  );
  if (candidates.length === 1) {
    const match = candidates[0];
    if (match === undefined) return { kind: "not-found", query };
    return sameModel(match, options.current)
      ? { kind: "already-active", model: match }
      : { kind: "resolved", model: match };
  }
  const pool = candidates.length > 1 ? candidates : available;
  const picked = pickClosestCandidate(normalized, pool, options.lastUsed);
  if (picked) {
    return sameModel(picked.model, options.current)
      ? { kind: "already-active", model: picked.model }
      : { kind: "resolved", model: picked.model, via: picked.via };
  }
  if (candidates.length > 1) return { kind: "ambiguous", query, candidates };
  return { kind: "not-found", query };
};

const unavailableOmpModelError = (
  query: string,
  resolution?: Extract<FabricModelResolution, { kind: "ambiguous" | "not-found" }>,
): Error => {
  const detail = resolution?.kind === "not-found" && resolution.tried !== undefined
    ? ` Alias targets tried: ${resolution.tried.join(", ")}.`
    : resolution?.kind === "ambiguous"
      ? ` Visible matches: ${resolution.candidates.map(modelKey).join(", ")}.`
      : "";
  return new Error(
    `Model ${JSON.stringify(query)} is not available to this OMP session.${detail} ` +
      'Use agents.models({ runner: "omp" }) to list the models visible to this session.',
  );
};

/**
 * Resolve an OMP participant selector strictly within the execution owner's
 * visible registry. Exact provider/id keys never fall back to fuzzy matching;
 * aliases and inexact selectors retain the normal Fabric resolution policy.
 */
export const resolveAvailableOmpModel = (
  selector: string,
  options: {
    aliases: Record<string, string[]>;
    available: readonly FabricModelCandidate[];
    lastUsed?: FabricModelUsage;
  },
): FabricModelCandidate => {
  const query = selector.trim();
  const alias = Object.keys(options.aliases).some(
    (name) => name.toLowerCase() === query.toLowerCase(),
  );
  if (PROVIDER_MODEL_RE.test(query) && !alias) {
    const exact = options.available.find(
      (model) => modelKey(model).toLowerCase() === query.toLowerCase(),
    );
    if (exact) return exact;
    throw unavailableOmpModelError(query);
  }

  const resolution = resolveFabricModel(query, options);
  if (resolution.kind === "resolved" || resolution.kind === "already-active") {
    return resolution.model;
  }
  throw unavailableOmpModelError(query, resolution);
};
