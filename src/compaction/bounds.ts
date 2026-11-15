const encoder = new TextEncoder();

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

export const clipUtf8 = (text: string, maxBytes: number, suffix = "…"): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes >= maxBytes) return "";
  let output = "";
  let used = 0;
  const available = maxBytes - suffixBytes;
  for (const character of text) {
    const bytes = utf8Bytes(character);
    if (used + bytes > available) break;
    output += character;
    used += bytes;
  }
  return `${output}${suffix}`;
};
