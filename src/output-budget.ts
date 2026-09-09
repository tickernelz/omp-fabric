import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { truncateMiddle } from "./util.js";

export const MAX_FAILURE_MODEL_OUTPUT_CHARS = 20_000;

export const modelOutputBudget = (
  configuredMaxChars: number,
  success: boolean,
): number => success
  ? configuredMaxChars
  : Math.min(configuredMaxChars, MAX_FAILURE_MODEL_OUTPUT_CHARS);

export interface BoundedModelOutput {
  text: string;
  artifactPath?: string;
  originalChars: number;
  omittedChars: number;
}

export const fabricStateDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(
    env.XDG_STATE_HOME || path.join(env.HOME || ".", ".local", "state"),
    "omp-fabric",
  );

export const outputArtifactDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(fabricStateDir(env), "output");

export interface OutputArtifactRetention {
  maxAgeMs: number;
  maxBytes: number;
}

export const DEFAULT_OUTPUT_ARTIFACT_RETENTION: OutputArtifactRetention = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  maxBytes: 256 * 1024 * 1024,
};

export const OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

let sweptAt: number | undefined;
let lastSweep: OutputArtifactSweepRecord | undefined;

export const resetOutputArtifactSweepSchedule = (): void => {
  sweptAt = undefined;
  lastSweep = undefined;
};

export const lastOutputArtifactSweep = (): OutputArtifactSweepRecord | undefined => lastSweep;

let activeRetention: OutputArtifactRetention = DEFAULT_OUTPUT_ARTIFACT_RETENTION;

export const configureOutputArtifactRetention = (
  retention: OutputArtifactRetention,
): void => {
  const changed = retention.maxAgeMs !== activeRetention.maxAgeMs
    || retention.maxBytes !== activeRetention.maxBytes;
  activeRetention = { maxAgeMs: retention.maxAgeMs, maxBytes: retention.maxBytes };
  if (changed) resetOutputArtifactSweepSchedule();
};

export const outputArtifactRetention = (): OutputArtifactRetention => activeRetention;

const ARTIFACT_FILE = /^output-[0-9a-z]+-(?:p([0-9a-z]+)-)?[0-9a-f]+\.txt$/;

const ownerAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

interface ArtifactCandidate {
  path: string;
  bytes: number;
  mtimeMs: number;
  held: boolean;
}

export interface OutputArtifactSweep {
  removed: string[];
  keptBytes: number;
  heldBytes: number;
  overBudgetBytes: number;
}

export interface OutputArtifactSweepRecord extends OutputArtifactSweep {
  at: number;
}

export const sweepOutputArtifacts = async (options: {
  directory?: string;
  retention?: OutputArtifactRetention;
  now?: number;
  isOwnerAlive?: (pid: number) => boolean;
} = {}): Promise<OutputArtifactSweep> => {
  const directory = options.directory ?? outputArtifactDir();
  const retention = options.retention ?? activeRetention;
  const now = options.now ?? Date.now();
  const alive = options.isOwnerAlive ?? ownerAlive;

  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { removed: [], keptBytes: 0, heldBytes: 0, overBudgetBytes: 0 };
  }

  const candidates: ArtifactCandidate[] = [];
  for (const name of names) {
    const match = ARTIFACT_FILE.exec(name);
    if (!match) continue;
    const artifactPath = path.join(directory, name);
    let info;
    try {
      info = await stat(artifactPath);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const pid = match[1] === undefined ? Number.NaN : Number.parseInt(match[1], 36);
    candidates.push({
      path: artifactPath,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      held: Number.isInteger(pid) && pid > 0 && alive(pid),
    });
  }
  candidates.sort((left, right) =>
    left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));

  const removed: string[] = [];
  const survivors: ArtifactCandidate[] = [];
  let keptBytes = 0;
  for (const candidate of candidates) {
    if (!candidate.held && now - candidate.mtimeMs >= retention.maxAgeMs) {
      try {
        await rm(candidate.path, { force: true });
        removed.push(candidate.path);
        continue;
      } catch {}
    }
    survivors.push(candidate);
    keptBytes += candidate.bytes;
  }
  for (const candidate of survivors) {
    if (keptBytes <= retention.maxBytes) break;
    if (candidate.held) continue;
    try {
      await rm(candidate.path, { force: true });
    } catch {
      continue;
    }
    removed.push(candidate.path);
    keptBytes -= candidate.bytes;
  }
  let heldBytes = 0;
  for (const candidate of survivors) {
    if (candidate.held) heldBytes += candidate.bytes;
  }
  return {
    removed,
    keptBytes,
    heldBytes,
    overBudgetBytes: Math.max(0, keptBytes - retention.maxBytes),
  };
};

export const sweepOutputArtifactsIfDue = async (options: {
  directory?: string;
  retention?: OutputArtifactRetention;
  now?: number;
  isOwnerAlive?: (pid: number) => boolean;
  intervalMs?: number;
} = {}): Promise<OutputArtifactSweep | undefined> => {
  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS;
  if (sweptAt !== undefined && now - sweptAt < interval) return undefined;
  sweptAt = now;
  const sweep = await sweepOutputArtifacts(options);
  lastSweep = { ...sweep, at: now };
  if (sweep.overBudgetBytes > 0) {
    const cap = (options.retention ?? activeRetention).maxBytes;
    console.warn(
      `[omp-fabric] output artifacts keep ${sweep.keptBytes} bytes against a ${cap} byte cap; ` +
      `${sweep.overBudgetBytes} bytes stay because ${sweep.heldBytes} bytes belong to running sessions`,
    );
  }
  return sweep;
};

type ArtifactWriter = (content: string) => Promise<string>;

const writeOutputArtifact: ArtifactWriter = async (content) => {
  const directory = outputArtifactDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(
    directory,
    `output-${Date.now().toString(36)}-p${process.pid.toString(36)}-${randomBytes(6).toString("hex")}.txt`,
  );
  await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await sweepOutputArtifactsIfDue({ directory });
  } catch {}
  return artifactPath;
};

const MAX_ARTIFACT_FAILURE_REASON_CHARS = 160;

const artifactFailureReason = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (!flattened) return "unknown error";
  return flattened.length <= MAX_ARTIFACT_FAILURE_REASON_CHARS
    ? flattened
    : `${flattened.slice(0, MAX_ARTIFACT_FAILURE_REASON_CHARS - 1)}…`;
};

export const boundModelOutput = async (
  visible: string,
  maxChars: number,
  fullOutput = visible,
  writeArtifact: ArtifactWriter = writeOutputArtifact,
): Promise<BoundedModelOutput> => {
  if (visible.length <= maxChars && fullOutput.length <= maxChars) {
    return { text: visible, originalChars: fullOutput.length, omittedChars: 0 };
  }

  let artifactPath: string | undefined;
  let failureReason: string | undefined;
  try {
    artifactPath = await writeArtifact(fullOutput);
  } catch (error) {
    failureReason = artifactFailureReason(error);
  }
  const suffix = artifactPath
    ? `\n\n[Full output (${fullOutput.length} chars) saved to: ${artifactPath}]`
    : `\n\n[full output ${fullOutput.length} chars; overflow could not be saved: ${failureReason}]`;
  const bodyBudget = Math.max(1, maxChars - suffix.length);
  const body = truncateMiddle(visible, bodyBudget);
  const combined = `${body}${suffix}`;
  return {
    text: combined.length <= maxChars ? combined : truncateMiddle(combined, maxChars),
    ...(artifactPath ? { artifactPath } : {}),
    originalChars: fullOutput.length,
    omittedChars: Math.max(0, fullOutput.length - Math.min(fullOutput.length, body.length)),
  };
};
