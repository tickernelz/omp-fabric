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

export function canonicalLcmPayload(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return encode(normalized);
}

export function hashLcmPayload(value: unknown): string { return crypto.createHash("sha256").update(canonicalLcmPayload(value), "utf8").digest("hex"); }

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

export function defaultLedgerPath(rootDir = path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || ".", ".local", "state"), "omp-fabric", "lcm"), projectKey = "default"): string {
  return path.join(rootDir, `${hash(projectKey).slice(0, 24)}.sqlite`);
}
