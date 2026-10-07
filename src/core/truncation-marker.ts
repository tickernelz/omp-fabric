export const TRUNCATION_MARKER = "[[omp-fabric:truncated]]";

export interface TruncationNotice {
  text: string;
  label: string;
  signal: Record<string, unknown>;
}

const REASON_LABELS: Record<string, string> = {
  matchLimit: "match limit",
  perFileMatchLimit: "per-file match limit",
  columnLimit: "column limit",
  fileLimit: "file limit",
  lineBudget: "line budget",
  byteBudget: "byte budget",
  outputLimit: "output limit",
  resultLimit: "result limit",
};

const reasonLabel = (reason: unknown): string | undefined =>
  typeof reason === "string" ? REASON_LABELS[reason] ?? reason : undefined;

const noticeLabel = (signal: Record<string, unknown>): string => {
  const tool = typeof signal.tool === "string" && signal.tool.length > 0 ? signal.tool : "output";
  const reasons = Array.isArray(signal.reasons)
    ? signal.reasons.map(reasonLabel).filter((value): value is string => value !== undefined)
    : [];
  return reasons.length > 0 ? `${tool} truncated · ${reasons.join(", ")}` : `${tool} truncated`;
};

export const splitTruncationNotice = (value: string): TruncationNotice | undefined => {
  const afterNewline = value.lastIndexOf(`\n${TRUNCATION_MARKER}`);
  const start = afterNewline >= 0
    ? afterNewline + 1
    : value.startsWith(TRUNCATION_MARKER) ? 0 : -1;
  if (start === -1) return undefined;
  const lineEnd = value.indexOf("\n", start);
  const line = value.slice(start, lineEnd === -1 ? undefined : lineEnd);
  const body = value.slice(0, start === 0 ? 0 : start - 1) + (lineEnd === -1 ? "" : value.slice(lineEnd));
  const raw = line.slice(TRUNCATION_MARKER.length).trim();
  let signal: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) signal = parsed as Record<string, unknown>;
  } catch {}
  return { text: body, label: noticeLabel(signal), signal };
};
