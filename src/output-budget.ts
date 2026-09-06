import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

type ArtifactWriter = (content: string) => Promise<string>;

const writeOutputArtifact: ArtifactWriter = async (content) => {
  const directory = await mkdtemp(path.join(tmpdir(), "omp-fabric-output-"));
  const artifactPath = path.join(directory, "output.txt");
  await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
  return artifactPath;
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
  try {
    artifactPath = await writeArtifact(fullOutput);
  } catch {
    artifactPath = undefined;
  }
  const suffix = artifactPath
    ? `\n\n[Full output (${fullOutput.length} chars) saved to: ${artifactPath}]`
    : "";
  const bodyBudget = Math.max(1, maxChars - suffix.length);
  const text = `${truncateMiddle(visible, bodyBudget)}${suffix}`;
  return {
    text: text.length <= maxChars ? text : truncateMiddle(text, maxChars),
    ...(artifactPath ? { artifactPath } : {}),
    originalChars: fullOutput.length,
    omittedChars: Math.max(0, fullOutput.length - Math.min(fullOutput.length, bodyBudget)),
  };
};
