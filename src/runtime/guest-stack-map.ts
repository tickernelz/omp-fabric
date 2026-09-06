// Stack frames captured from the executed guest bundle reference the emitted
// omp-fabric-guest.js (wrapper header plus TypeScript printer layout), not the
// author's program. These helpers decode the transpile source map and rewrite
// error text so stack positions point back at the user-submitted code.

interface GuestSourcePosition {
  line: number;
  column: number;
}

export interface GuestStackMap {
  lookup(line: number, column: number): GuestSourcePosition | undefined;
}

interface GuestSourceMapJson {
  mappings?: unknown;
}

interface MappingSegment {
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
}

const BASE64_VALUES = (() => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const table = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index += 1) {
    table.set(alphabet[index] as string, index);
  }
  return table;
})();

const decodeVlqSegment = (segment: string): number[] => {
  const values: number[] = [];
  let index = 0;
  while (index < segment.length) {
    let value = 0;
    let shift = 0;
    let continuation = true;
    while (continuation) {
      const digit = BASE64_VALUES.get(segment[index] as string);
      if (digit === undefined) return values;
      index += 1;
      continuation = (digit & 32) !== 0;
      value += (digit & 31) * 2 ** shift;
      shift += 5;
    }
    values.push((value & 1) === 1 ? -(value >> 1) : value >> 1);
  }
  return values;
};

const decodeMappings = (mappings: string): MappingSegment[][] => {
  const lines: MappingSegment[][] = [];
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of mappings.split(";")) {
    const segments: MappingSegment[] = [];
    let generatedColumn = 0;
    for (const rawSegment of line.split(",")) {
      if (!rawSegment) continue;
      const values = decodeVlqSegment(rawSegment);
      // values[1] is the source index delta; single-source guest maps never
      // need it, so only generated column and source position accumulate.
      if (values.length < 4) continue;
      generatedColumn += values[0] as number;
      sourceLine += values[2] as number;
      sourceColumn += values[3] as number;
      segments.push({ generatedColumn, sourceLine, sourceColumn });
    }
    lines.push(segments);
  }
  return lines;
};

export const createGuestStackMap = (
  sourceMapText: string | undefined,
): GuestStackMap | undefined => {
  if (!sourceMapText) return undefined;
  let mappings: string;
  try {
    const parsed = JSON.parse(sourceMapText) as GuestSourceMapJson;
    if (typeof parsed.mappings !== "string") return undefined;
    mappings = parsed.mappings;
  } catch {
    return undefined;
  }
  // Validating the envelope above is cheap; decoding the VLQ mappings defers
  // to the first error lookup so clean executions pay almost nothing for
  // diagnostics they never render.
  let decoded: MappingSegment[][] | undefined;
  return {
    lookup(line, column) {
      decoded ??= decodeMappings(mappings);
      const segments = decoded[line - 1];
      if (!segments) return undefined;
      const target = column - 1;
      let best: MappingSegment | undefined;
      for (const segment of segments) {
        if (segment.generatedColumn > target) break;
        best = segment;
      }
      // Columns before the first segment point at line indentation; anchor
      // them to the first statement segment rather than leaving the frame
      // in emitted-file coordinates.
      best ??= segments[0];
      if (!best) return undefined;
      // The wrapper header occupies source line 1, so the zero-based source
      // line already equals the author's one-based program line.
      return { line: best.sourceLine, column: best.sourceColumn + 1 };
    },
  };
};

const GUEST_FRAME_PATTERN = /omp-fabric-guest\.js:(\d+):(\d+)/g;

export const remapGuestErrorText = (
  text: string,
  stackMap: GuestStackMap | undefined,
  guestLineCount?: number,
): string => {
  if (!stackMap || !text.includes("omp-fabric-guest.js:")) return text;
  return text.replace(GUEST_FRAME_PATTERN, (match, lineText, columnText) => {
    const line = Number(lineText);
    const mapped = stackMap.lookup(line, Number(columnText));
    if (mapped) return `guest code:${mapped.line}:${mapped.column}`;
    // Both runtimes append their driver call after the emitted bundle, so
    // frames beyond it can only be harness machinery, never user statements.
    if (guestLineCount !== undefined && line > guestLineCount) return "fabric driver";
    return match;
  });
};
