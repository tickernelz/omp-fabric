import { StringDecoder } from "node:string_decoder";

export class LfJsonlParser {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #onRecord;

  constructor(onRecord) {
    this.#onRecord = onRecord;
  }

  push(chunk) {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    this.#drain(false);
  }

  end(chunk) {
    if (chunk !== undefined) this.push(chunk);
    this.#buffer += this.#decoder.end();
    this.#drain(true);
  }

  #drain(flush) {
    while (true) {
      const lf = this.#buffer.indexOf("\n");
      if (lf < 0) break;
      let record = this.#buffer.slice(0, lf);
      this.#buffer = this.#buffer.slice(lf + 1);
      if (record.endsWith("\r")) record = record.slice(0, -1);
      if (record.length > 0) this.#onRecord(JSON.parse(record));
    }
    if (flush && this.#buffer.length > 0) {
      const record = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
      this.#buffer = "";
      if (record.length > 0) this.#onRecord(JSON.parse(record));
    }
  }
}

const positiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const positiveInteger = (value) => {
  const parsed = positiveNumber(value);
  return parsed === null || !Number.isInteger(parsed) ? null : parsed;
};

export const benchmarkGate = (env = process.env) => {
  const reasons = [];
  if (env.OMP_FABRIC_REAL_RESUME !== "1") reasons.push("OMP_FABRIC_REAL_RESUME must equal 1");
  if (!env.OMP_FABRIC_BENCH_MODEL) reasons.push("OMP_FABRIC_BENCH_MODEL is required");
  if (!env.OMP_FABRIC_BENCH_PROVIDER) reasons.push("OMP_FABRIC_BENCH_PROVIDER is required");
  const keyVariable = env.OMP_FABRIC_BENCH_KEY_ENV;
  if (!keyVariable) reasons.push("OMP_FABRIC_BENCH_KEY_ENV is required");
  else if (!env[keyVariable]) reasons.push(`credential variable ${keyVariable} is not set`);
  const repeats = positiveInteger(env.OMP_FABRIC_BENCH_REPEATS);
  if (repeats === null) reasons.push("OMP_FABRIC_BENCH_REPEATS must be a positive integer");
  const maxUsd = positiveNumber(env.OMP_FABRIC_BENCH_MAX_USD);
  if (maxUsd === null) reasons.push("OMP_FABRIC_BENCH_MAX_USD must be a positive number");
  return {
    enabled: reasons.length === 0,
    reasons,
    config: {
      model: env.OMP_FABRIC_BENCH_MODEL ?? null,
      provider: env.OMP_FABRIC_BENCH_PROVIDER ?? null,
      keyVariable: keyVariable ?? null,
      repeats: repeats ?? 0,
      maxUsd: maxUsd ?? 0,
      seed: env.OMP_FABRIC_BENCH_SEED ?? "omp-fabric-resume-v1",
      ompCommand: env.OMP_FABRIC_OMP_COMMAND ?? "omp",
    },
  };
};

const hashSeed = (text) => {
  let state = 0x811c9dc5;
  for (const character of text) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return state || 1;
};

export const pairedOrders = (repeats, seed, variants = ["baseline", "fabric"]) => {
  let state = hashSeed(seed);
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return Array.from({ length: repeats }, () => {
    const order = [...variants];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    return order;
  });
};

export const wilsonInterval = (successes, total, z = 1.959963984540054) => {
  if (total === 0) return { low: 0, high: 1 };
  const rate = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
};

export const summarizeBenchmark = (runs, orders, budget) => {
  const variants = [...new Set(runs.map((run) => run.variant))];
  const byVariant = Object.fromEntries(variants.map((variant) => {
    const selected = runs.filter((run) => run.variant === variant);
    const successes = selected.filter((run) => run.oracle.passed).length;
    const sum = (field) => selected.reduce((total, run) => total + (run[field] ?? 0), 0);
    return [variant, {
      runs: selected.length,
      successes,
      passRate: selected.length === 0 ? 0 : successes / selected.length,
      passRate95: wilsonInterval(successes, selected.length),
      tokens: sum("tokens"),
      costUsd: sum("costUsd"),
      toolCalls: sum("toolCalls"),
      recallCalls: sum("recallCalls"),
      wallMs: sum("wallMs"),
    }];
  }));
  const pairedRates = {};
  for (let leftIndex = 0; leftIndex < variants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < variants.length; rightIndex += 1) {
      const left = variants[leftIndex];
      const right = variants[rightIndex];
      let leftWins = 0;
      let rightWins = 0;
      let ties = 0;
      const repeats = new Set(runs.map((run) => run.repeat));
      for (const repeat of repeats) {
        const leftRun = runs.find((run) => run.repeat === repeat && run.variant === left);
        const rightRun = runs.find((run) => run.repeat === repeat && run.variant === right);
        if (!leftRun || !rightRun) continue;
        if (leftRun.oracle.passed === rightRun.oracle.passed) ties += 1;
        else if (leftRun.oracle.passed) leftWins += 1;
        else rightWins += 1;
      }
      pairedRates[`${left}_vs_${right}`] = { leftWins, rightWins, ties };
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    randomizedOrders: orders,
    budget: { maxUsd: budget, observedUsd: runs.reduce((sum, run) => sum + run.costUsd, 0) },
    variants: byVariant,
    pairedRates,
    runs,
  };
};
