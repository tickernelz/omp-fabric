import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ProjectIdentityInput { recordedCwd?: string; liveCwd?: string }
export interface ProjectIdentity { version: 1; key: string; canonicalPath?: string; device?: number; inode?: number; aliases: string[] }
export interface SessionEntry { projectKey: string; sessionId: string; entryId: string; revision?: number; role: string; content: string; payloadJson: string; parentEntryId?: string | null; branch?: string | null; recordedCwd?: string; createdAt?: number }
export interface RawEntry extends SessionEntry { revision: number; contentHash: string; payloadHash: string; createdAt: number }
export interface DeleteConfirmationToken { readonly projectKey: string; readonly value: string; readonly __brand: "DeleteConfirmationToken" }

export const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (target: string): string => path.normalize(path.resolve(target));
const statIdentity = (target: string) => { try { const stats = fs.statSync(target); return { device: Number(stats.dev), inode: Number(stats.ino) }; } catch { return {}; } };

const encodeCanonical = (item: unknown): string => {
  if (Array.isArray(item)) return `[${item.map(encodeCanonical).join(",")}]`;
  if (item !== null && typeof item === "object") return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encodeCanonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(item);
};

export function canonicalLcmPayload(value: unknown): string {
  return encodeCanonical(JSON.parse(JSON.stringify(value)));
}

export function hashLcmPayload(value: unknown): string { return crypto.createHash("sha256").update(canonicalLcmPayload(value), "utf8").digest("hex"); }

const BLOB_PREFIX = "blob:sha256:";
const SIGNATURE_KEYS: ReadonlySet<string> = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);
const VOLATILE_MESSAGE_KEYS = ["retryRecovery"] as const;
const blobRef = (bytes: Buffer): string => `${BLOB_PREFIX}${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const imageDataRef = (data: string): string => data.startsWith(BLOB_PREFIX) ? data : blobRef(Buffer.from(data, "base64"));
const isImageMime = (value: unknown): boolean => typeof value === "string" && value.toLowerCase().startsWith("image/");

const normalizeNode = (value: unknown, key: string | undefined): unknown => {
  if (typeof value === "string") {
    return key === "image_url" && value.startsWith("data:image/") && value.includes(";base64,") ? blobRef(Buffer.from(value, "utf8")) : value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeNode(item, key));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const image = typeof record.data === "string" && (record.type === "image" || isImageMime(record.mimeType));
  const generated = record.type === "image_generation_call" && typeof record.result === "string";
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(record)) {
    if (SIGNATURE_KEYS.has(childKey)) continue;
    if ((image && childKey === "data") || (generated && childKey === "result")) out[childKey] = imageDataRef(child as string);
    else out[childKey] = normalizeNode(child, childKey);
  }
  return out;
};

/** True for a tool result the host has already replaced with a pruning notice. */
export function isPrunedLcmEntry(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const message = (value as Record<string, unknown>).message;
  return message !== null && typeof message === "object" && typeof (message as Record<string, unknown>).prunedAt === "number";
}

/** Drops the signatures, externalized blob bytes, retry bookkeeping and zero errorId the host rewrites after the fact. */
function normalizeLcmEntry(value: unknown): unknown {
  const normalized = normalizeNode(JSON.parse(JSON.stringify(value)), undefined);
  const message = normalized !== null && typeof normalized === "object" ? (normalized as Record<string, unknown>).message : undefined;
  if (message !== null && typeof message === "object" && !Array.isArray(message)) {
    const fields = message as Record<string, unknown>;
    for (const field of VOLATILE_MESSAGE_KEYS) delete fields[field];
    if (fields.errorId === 0) delete fields.errorId;
  }
  return normalized;
}

/** Canonical JSON of the normalized entry: the stored payload and the source of its identity hash. */
export function canonicalLcmEntry(value: unknown): string { return encodeCanonical(normalizeLcmEntry(value)); }

export function createDeleteConfirmationToken(projectKey: string): DeleteConfirmationToken { return { projectKey, value: hash(`delete:${projectKey}`), __brand: "DeleteConfirmationToken" }; }

export function canonicalProjectIdentity(input: ProjectIdentityInput): ProjectIdentity {
  const source = input.recordedCwd?.trim() || input.liveCwd?.trim();
  if (!source) throw new Error("project cwd is required");
  const normalized = normalize(source);
  let canonicalPath = normalized;
  try { canonicalPath = fs.realpathSync.native(normalized); } catch {}
  const ids = statIdentity(canonicalPath);
  const key = ids.device !== undefined && ids.inode !== undefined ? `v1:devino:${ids.device}:${ids.inode}` : `v1:path:${canonicalPath}`;
  return { version: 1, key, canonicalPath, ...ids, aliases: [normalized, canonicalPath] };
}

export function defaultLedgerRoot(): string {
  return path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || ".", ".local", "state"), "omp-fabric", "lcm");
}

export function defaultLedgerPath(rootDir = defaultLedgerRoot(), projectKey = "default"): string {
  return path.join(rootDir, `${hash(projectKey).slice(0, 24)}.sqlite`);
}
