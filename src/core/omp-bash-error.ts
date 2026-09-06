const OMP_BASH_EXIT_MARKER = Symbol.for("omp-fabric.bash-exit");

class OmpBashExitError extends Error {
  readonly [OMP_BASH_EXIT_MARKER] = true;
  readonly ompBashExit = true;

  constructor(message: string, readonly exitCode: number, readonly output: string) {
    super(message);
  }
}
export const stripOmpBashTiming = (text: string): string =>
  text
    .replace(/(\r?\n)\r?\n\r?\nWall time:? [^\r\n]+\r?\n\r?\n/g, "$1\n")
    .replace(/(\r?\n)\r?\n\r?\nWall time:? [^\r\n]+$/g, "$1")
    .replace(/(\r?\n)\r?\nWall time:? [^\r\n]+\r?\n\r?\n/g, "$1\n")
    .replace(/(\r?\n)\r?\nWall time:? [^\r\n]+$/g, "$1");

export function classifyOmpBashError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const match = /(?:^|\n\n)Command exited with code (\d+)$/.exec(error.message);
  if (!match) return error;
  const exitCode = Number(match[1]);
  if (!Number.isSafeInteger(exitCode) || exitCode <= 0) return error;
  return new OmpBashExitError(
    error.message,
    exitCode,
    stripOmpBashTiming(error.message.slice(0, match.index)),
  );
}

// Display cleanup only: this never decides whether an error is a native exit.
// Work exclusively with the final text so redacted/cleared content stays gone.
function bashResultOutput(original: { message: string; exitCode: number; output: string }, text: string): string {
  const hadTiming = text.includes("Wall time:");
  const processed = stripOmpBashTiming(text);
  const message = stripOmpBashTiming(original.message);
  const index = processed.indexOf(message);
  if (index >= 0) {
    return processed.slice(0, index + original.output.length) + processed.slice(index + message.length);
  }

  const marker = new RegExp(`(?:^|\\r?\\n\\r?\\n)Command exited with code ${original.exitCode}(?=\\r?\\n|$)`, "g");
  const match = marker.exec(processed);
  if (!match || marker.exec(processed)) return processed;
  const prefix = processed.slice(0, match.index);
  const suffix = processed.slice(match.index + match[0].length);
  if (hadTiming) return `${prefix}${text.includes("\r\n") ? "\r\n" : "\n"}${suffix}`;
  return prefix + suffix;
}

export function ompBashExitError(exitCode: number, text: string): Error {
  const marker = new RegExp(`(?:^|\\r?\\n\\r?\\n)Command exited with code ${exitCode}(?=\\r?\\n|$)`);
  const match = marker.exec(text);
  if (!match) return new OmpBashExitError(text, exitCode, text);
  const prefix = text.slice(0, match.index);
  const tail = text.slice(match.index + match[0].length);
  const output = stripOmpBashTiming(prefix) + (tail ? tail.replace(/^\r?\n/, "") : "");
  return new OmpBashExitError(text, exitCode, output);
}

/** Keep native exit status independent of middleware display transformations. */
export function ompBashResultError(original: unknown, text: string): Error {
  const metadata = ompBashExitMetadata(original);
  if (metadata) {
    const message = original instanceof Error ? original.message : text;
    return new OmpBashExitError(text, metadata.exitCode, bashResultOutput({ message, ...metadata }, text));
  }
  return new Error(text.trim() || "OMP bash failed");
}

/** Only provider-classified exits may cross a runtime bridge as settle metadata. */
export function ompBashExitMetadata(error: unknown): { exitCode: number; output: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (Reflect.get(error, OMP_BASH_EXIT_MARKER) !== true && Reflect.get(error, "ompBashExit") !== true) return undefined;
  const exitCode = Reflect.get(error, "exitCode");
  const output = Reflect.get(error, "output");
  return Number.isSafeInteger(exitCode) && typeof output === "string"
    ? { exitCode, output }
    : undefined;
}
