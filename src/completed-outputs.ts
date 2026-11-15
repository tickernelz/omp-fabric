export interface CompletedOutput {
  ref: string;
  target?: string;
  chars: number;
  preview: string;
}

const MAX_ENTRIES = 6;
const HEAD_CHARS = 450;
const TAIL_CHARS = 250;
const TARGET_CHARS = 100;

const outputText = (value: unknown): string | undefined => {
  try {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return undefined;
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.output === "string") return record.output;
      if (typeof record.text === "string") return record.text;
      return JSON.stringify(value);
    }
    return String(value);
  } catch {
    return undefined;
  }
};

const targetOf = (args: Record<string, unknown>): string | undefined => {
  const raw = typeof args.path === "string"
    ? args.path
    : typeof args.cmd === "string"
      ? args.cmd
      : typeof args.command === "string"
        ? args.command
        : undefined;
  if (raw === undefined) return undefined;
  const line = raw.trim().split("\n", 1)[0] ?? "";
  if (line === "") return undefined;
  return line.length <= TARGET_CHARS ? line : `…${line.slice(-(TARGET_CHARS - 1))}`;
};

const excerpt = (text: string): string =>
  text.length <= HEAD_CHARS + TAIL_CHARS
    ? text
    : `${text.slice(0, HEAD_CHARS)}\n…[${text.length - HEAD_CHARS - TAIL_CHARS} chars omitted]…\n${text.slice(-TAIL_CHARS)}`;

export class CompletedOutputJournal {
  readonly #entries: CompletedOutput[] = [];

  record(ref: string, args: Record<string, unknown>, value: unknown): void {
    const text = outputText(value);
    if (text === undefined || text.trim() === "") return;
    const target = targetOf(args);
    this.#entries.push({
      ref,
      ...(target !== undefined ? { target } : {}),
      chars: text.length,
      preview: excerpt(text),
    });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
  }

  entries(): CompletedOutput[] {
    return [...this.#entries];
  }
}
