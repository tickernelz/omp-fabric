const encoder = new TextEncoder();

const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

export const MAX_COMPACTION_INSTRUCTIONS_CHARS = 8 * 1024;
const MAX_COMPACTION_INSTRUCTIONS_BYTES = 8 * 1024;
export const MAX_PRESERVE_ITEMS = 16;
export const MAX_PRESERVE_ITEM_CHARS = 2 * 1024;
const MAX_PRESERVE_ITEM_BYTES = 2 * 1024;

export interface CompactionRequest {
  instructions?: string;
  preserve?: string[];
}

export interface CompactionRequestBoundsError {
  message: string;
}

const hasPairedSurrogates = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const compactionRequestBoundsError = (
  request: CompactionRequest,
): CompactionRequestBoundsError | undefined => {
  if (request.instructions !== undefined) {
    if (!hasPairedSurrogates(request.instructions)) {
      return { message: "compaction instructions contain an unpaired UTF-16 surrogate" };
    }
    if (request.instructions.length > MAX_COMPACTION_INSTRUCTIONS_CHARS
      || utf8Bytes(request.instructions) > MAX_COMPACTION_INSTRUCTIONS_BYTES) {
      return {
        message: `compaction instructions exceed ${MAX_COMPACTION_INSTRUCTIONS_CHARS} characters or ${MAX_COMPACTION_INSTRUCTIONS_BYTES} UTF-8 bytes`,
      };
    }
  }
  if (request.preserve !== undefined) {
    if (request.preserve.length > MAX_PRESERVE_ITEMS) {
      return { message: `compaction preserve exceeds ${MAX_PRESERVE_ITEMS} items` };
    }
    for (const item of request.preserve) {
      if (!hasPairedSurrogates(item)) {
        return { message: "compaction preserve item contains an unpaired UTF-16 surrogate" };
      }
      if (item.length > MAX_PRESERVE_ITEM_CHARS || utf8Bytes(item) > MAX_PRESERVE_ITEM_BYTES) {
        return {
          message: `compaction preserve item exceeds ${MAX_PRESERVE_ITEM_CHARS} characters or ${MAX_PRESERVE_ITEM_BYTES} UTF-8 bytes`,
        };
      }
    }
  }
  return undefined;
};

export const composeCompactionInstructions = (request: CompactionRequest): string | undefined => {
  const boundsError = compactionRequestBoundsError(request);
  if (boundsError) throw new Error(boundsError.message);
  const preserve = request.preserve && request.preserve.length > 0
    ? `Preserve these facts in the summary:\n${request.preserve.map((item) => `- ${item}`).join("\n")}`
    : undefined;
  const parts = [request.instructions, preserve].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
};
