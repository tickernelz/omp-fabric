import { mkdir, writeFile } from "node:fs/promises";
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

type ArtifactWriter = (content: string) => Promise<string>;

const writeOutputArtifact: ArtifactWriter = async (content) => {
  const directory = outputArtifactDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(
    directory,
    `output-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.txt`,
  );
  await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
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
