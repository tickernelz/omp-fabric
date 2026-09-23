export const MAX_SUMMARY_BYTES = 32 * 1024;
/** The configuration ceiling for entries in one leaf. */
export const MAX_LEAF_ENTRIES = 128;
const MAX_REQUEST_SOURCE_BYTES = 8 * 1024;

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

export interface CanonicalText {
  text: string;
  truncated: boolean;
  sourceBytes: number;
}

export const canonicalizeText = (input: string, maxBytes = MAX_REQUEST_SOURCE_BYTES): CanonicalText => {
  const canonical = input.trim().split(/\s+/u).filter(Boolean).join(" ");
  const sourceBytes = utf8Bytes(canonical);
  return {
    text: clipUtf8(canonical, maxBytes),
    truncated: sourceBytes > maxBytes,
    sourceBytes,
  };
};

export interface AddressedValue {
  entryId: string;
}

export interface AddressedSample<T extends AddressedValue> {
  values: T[];
  omitted: number;
  omittedFirstEntryId?: string;
  omittedLastEntryId?: string;
  splitIndex: number;
}

export const sampleAddressedFrom = <T extends AddressedValue>(
  source: Iterable<T>,
  maxValues: number,
): AddressedSample<T> => {
  const earliestLimit = Math.ceil(maxValues / 2);
  const latestLimit = Math.floor(maxValues / 2);
  const earliest: T[] = [];
  const latest: T[] = [];
  let omitted = 0;
  let omittedFirstEntryId: string | undefined;
  let omittedLastEntryId: string | undefined;

  for (const value of source) {
    if (earliest.length < earliestLimit) {
      earliest.push(value);
      continue;
    }
    latest.push(value);
    if (latest.length <= latestLimit) continue;
    const displaced = latest.shift()!;
    omitted += 1;
    omittedFirstEntryId ??= displaced.entryId;
    omittedLastEntryId = displaced.entryId;
  }

  return {
    values: [...earliest, ...latest],
    omitted,
    ...(omittedFirstEntryId !== undefined ? { omittedFirstEntryId } : {}),
    ...(omittedLastEntryId !== undefined ? { omittedLastEntryId } : {}),
    splitIndex: earliest.length,
  };
};

export const sampleAddressed = <T extends AddressedValue>(
  values: readonly T[],
  maxValues: number,
): AddressedSample<T> => sampleAddressedFrom(values, maxValues);

export const omissionLine = (
  count: number,
  firstEntryId: string | undefined,
  lastEntryId: string | undefined,
  noun: string,
): string => {
  const range = firstEntryId || lastEntryId
    ? `${firstEntryId || "(start)"} → ${lastEntryId || "(end)"}`
    : "(unknown range)";
  return `… omitted ${count} ${noun}; source entries ${range}`;
};
