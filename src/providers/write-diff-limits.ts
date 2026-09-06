// Pure write-diff size guards shared by the write-preview tool wrapper and the
// dashboard's core-tool-render. Keep this module free of imports from
// "@oh-my-pi/pi-coding-agent": it is part of the lazily imported
// dashboard graph, which cannot resolve OMP's host package in managed
// installs (issue #13).

const configuredMaxBytes = Number.parseInt(
  process.env.CODE_PREVIEW_MAX_WRITE_DIFF_BYTES ?? "",
  10,
);
export const MAX_WRITE_DIFF_BYTES =
  Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : 200_000;

const configuredMaxChangedLineCells = Number.parseInt(
  process.env.CODE_PREVIEW_MAX_WRITE_DIFF_CHANGED_LINE_CELLS ?? "",
  10,
);
const MAX_WRITE_DIFF_CHANGED_LINE_CELLS =
  Number.isFinite(configuredMaxChangedLineCells) && configuredMaxChangedLineCells > 0
    ? configuredMaxChangedLineCells
    : 1_000_000;

export const writeContentForPreview = (content: string): string | undefined =>
  Buffer.byteLength(content, "utf8") <= MAX_WRITE_DIFF_BYTES ? content : undefined;

export const shouldSkipWriteDiffBytes = (...texts: string[]): boolean => {
  let total = 0;
  for (const text of texts) {
    total += Buffer.byteLength(text, "utf8");
    if (total > MAX_WRITE_DIFF_BYTES) return true;
  }
  return false;
};

export const shouldSkipWriteDiffComplexity = (before: string, after: string): boolean => {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const sharedLimit = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < sharedLimit && beforeLines[prefix] === afterLines[prefix]) prefix++;

  let suffix = 0;
  const suffixLimit = sharedLimit - prefix;
  while (
    suffix < suffixLimit &&
    beforeLines[beforeLines.length - suffix - 1] ===
      afterLines[afterLines.length - suffix - 1]
  ) {
    suffix++;
  }

  const changedBefore = beforeLines.length - prefix - suffix;
  const changedAfter = afterLines.length - prefix - suffix;
  return changedBefore * changedAfter > MAX_WRITE_DIFF_CHANGED_LINE_CELLS;
};
