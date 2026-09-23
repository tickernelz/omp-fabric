import { clipUtf8, utf8Bytes } from "./bounds.js";
import { lcmRawAddress, type LcmAddressSource } from "./lcm-addresses.js";

export const DETERMINISTIC_HEADER = "[Nonsemantic deterministic excerpt; not a model summary]";
const ACTIVE_REQUEST_LABEL = "[Active Request]";
const TAIL_DIGEST_LABEL = "[Recent Detail]";
const ACTIVE_REQUEST_MAX_BYTES = 8 * 1024;
const USER_LINE_BYTES = 1_024;
const ASSISTANT_LINE_BYTES = 512;
const CALL_LINE_BYTES = 256;
const RESULT_LINE_BYTES = 256;
const MIN_DIGEST_LINE_BYTES = 64;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

interface MessageEntry { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } }

const blockText = (block: unknown): string => {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return "";
  const record = block as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "toolCall") {
    const name = typeof record.name === "string" ? record.name : "tool";
    const intent = typeof record.intent === "string" ? record.intent : "";
    return `call ${name}${intent ? `: ${intent}` : ""}`;
  }
  return "";
};

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter((part) => part.length > 0).join("\n");
};

const withoutReminders = (text: string): string => text.replace(SYSTEM_REMINDER, "").trim();

const requestText = (content: unknown): string => {
  if (typeof content === "string") return withoutReminders(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block as Record<string, unknown> | null)?.type === "text" ? withoutReminders(blockText(block)) : "")
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
};

const roleOf = (entry: unknown): string | undefined => {
  const typed = entry as MessageEntry | null;
  return typed?.type === "message" ? typed.message?.role : undefined;
};

/** The user request whose turn the cut interrupted, verbatim and addressed, so compaction never drops the task in flight. */
export const activeRequestBlock = (
  entries: readonly unknown[],
  sources: readonly LcmAddressSource[],
  maxBytes = ACTIVE_REQUEST_MAX_BYTES,
): string => {
  if (maxBytes <= 0) return "";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (roleOf(entries[index]) !== "user") continue;
    const entry = entries[index] as MessageEntry;
    const text = requestText(entry.message?.content);
    if (text.length === 0) continue;
    const source = sources[index];
    const header = source ? `${ACTIVE_REQUEST_LABEL} ${lcmRawAddress(source)}` : ACTIVE_REQUEST_LABEL;
    const room = maxBytes - utf8Bytes(header) - 1;
    const body = clipUtf8(text, room);
    return body.length === 0 ? "" : `${header}\n${body}`;
  }
  return "";
};

const digestLine = (entry: unknown): string => {
  const typed = entry as MessageEntry | null;
  if (!typed || typeof typed !== "object") return "";
  if (typed.type !== "message") return typeof typed.type === "string" ? typed.type : "";
  const role = typed.message?.role;
  const text = messageText(typed.message?.content).replace(/\s+/g, " ").trim();
  if (role === "user") return text ? `user: ${clipUtf8(text, USER_LINE_BYTES)}` : "";
  if (role === "assistant") return text ? `assistant: ${clipUtf8(text, ASSISTANT_LINE_BYTES)}` : "";
  if (role === "toolResult") {
    const name = typed.message?.toolName ?? "tool";
    const status = typed.message?.isError ? "error" : "ok";
    return `result ${name} ${status}${text ? `: ${clipUtf8(text, RESULT_LINE_BYTES)}` : ""}`;
  }
  return text ? `${role ?? "entry"}: ${clipUtf8(text, CALL_LINE_BYTES)}` : "";
};

/** Deterministic newest-first digest of entries no summary covers yet, so an unsummarized tail still reaches the model. */
export const tailDigest = (
  entries: readonly unknown[],
  sources: readonly LcmAddressSource[],
  maxBytes: number,
): string => {
  if (maxBytes <= 0 || entries.length === 0) return "";
  const lines = entries.map(digestLine).filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const newest = sources[sources.length - 1];
  const header = `${DETERMINISTIC_HEADER}\n${TAIL_DIGEST_LABEL} ${entries.length} entries${newest ? `, newest ${lcmRawAddress(newest)}` : ""}`;
  let used = utf8Bytes(header);
  const kept: string[] = [];
  let omitted = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = utf8Bytes(line) + 1;
    const reserve = index > 0 ? utf8Bytes(`… omitted ${index} earlier lines\n`) : 0;
    if (used + cost + reserve <= maxBytes) { used += cost; kept.unshift(line); continue; }
    const room = maxBytes - used - reserve - 1;
    if (kept.length === 0 && room >= MIN_DIGEST_LINE_BYTES) { kept.unshift(clipUtf8(line, room)); omitted = index; }
    else omitted = index + 1;
    break;
  }
  if (kept.length === 0) return "";
  const notice = omitted > 0 ? [`… omitted ${omitted} earlier lines`] : [];
  return `${header}\n${[...notice, ...kept].join("\n")}`;
};
