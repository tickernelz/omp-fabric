import { buildSessionContext as buildOmpSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export type ContextMessage = SessionContext["messages"][number];

type ContextOptions = NonNullable<Parameters<typeof buildOmpSessionContext>[3]>;

const inFlightToolCalls = (entry: SessionEntry): ReadonlySet<string> => {
  const ids = new Set<string>();
  if (entry.type !== "message" || entry.message.role !== "assistant") return ids;
  for (const part of entry.message.content) if (part.type === "toolCall") ids.add(part.id);
  return ids;
};

const singleEntryOptions = (entry: SessionEntry): ContextOptions =>
  ({
    transcript: true,
    inFlightToolCallIds: inFlightToolCalls(entry),
    keepDanglingToolCalls: true,
  }) as ContextOptions;

export const sessionEntryToContextMessages = (entry: SessionEntry): ContextMessage[] =>
  buildOmpSessionContext([entry], entry.id, new Map([[entry.id, entry]]), singleEntryOptions(entry)).messages;

export const buildSessionContext = (
  entries: readonly SessionEntry[],
  leafId?: string,
  byId?: Map<string, SessionEntry>,
): SessionContext => buildOmpSessionContext([...entries], leafId, byId);
