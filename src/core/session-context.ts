import { buildSessionContext as buildOmpSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export type ContextMessage = SessionContext["messages"][number];

export const sessionEntryToContextMessages = (entry: SessionEntry): ContextMessage[] =>
  buildOmpSessionContext([entry], entry.id, new Map([[entry.id, entry]]), {
    transcript: true,
    keepDanglingToolCalls: true,
  }).messages;

export const buildSessionContext = (
  entries: readonly SessionEntry[],
  leafId?: string,
  byId?: Map<string, SessionEntry>,
): SessionContext => buildOmpSessionContext([...entries], leafId, byId);
