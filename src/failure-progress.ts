import type { FabricExecutionTraceV1 } from "./audit/trace.js";
import type { CompletedOutput } from "./completed-outputs.js";

const MAX_COMPLETED_CALLS = 8;
const MAX_PATH_CHARS = 100;

const compactPath = (value: string): string => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_PATH_CHARS) return singleLine;
  return `…${singleLine.slice(-(MAX_PATH_CHARS - 1))}`;
};

const formatOutputs = (outputs: readonly CompletedOutput[]): string => {
  const blocks = outputs.map((output, index) => {
    const target = output.target === undefined ? "" : ` ${output.target}`;
    return `[${index + 1}] ${output.ref}${target} (${output.chars} chars)\n${output.preview}`;
  });
  return [
    `Output of the last ${outputs.length} completed ${outputs.length === 1 ? "call" : "calls"}, cut to fit; call again only for what was cut:`,
    ...blocks,
  ].join("\n");
};

export const formatFailureProgress = (
  trace: FabricExecutionTraceV1,
  outputs: readonly CompletedOutput[] = [],
): string | undefined => {
  if (trace.outcome === "succeeded") return undefined;
  const completed = trace.operations.filter(
    (operation) => operation.outcome === "succeeded",
  );
  if (completed.length === 0) return undefined;
  const summaries = completed.slice(0, MAX_COMPLETED_CALLS).map((operation) => {
    const path = operation.args.path;
    return typeof path === "string"
      ? `${operation.ref}(${compactPath(path)})`
      : operation.ref;
  });
  const omitted = completed.length - summaries.length;
  const returned = outputs.length > 0 ? "outputs of the last calls follow" : "outputs not returned";
  return [
    `Completed before the outer failure (${returned}): ${summaries.join("; ")}${
      omitted > 0 ? `; +${omitted} more` : ""
    }.`,
    "Successful calls may already have changed the workspace; inspect before repeating mutations.",
    ...(outputs.length > 0 ? [formatOutputs(outputs)] : []),
  ].join("\n");
};
