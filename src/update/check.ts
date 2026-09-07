import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { writeJsonAtomic } from "../core/atomic-write.js";
import { compareVersions } from "../host-compatibility.js";
import { resolveFabricIdentity } from "../main-agent.js";

const PACKAGE_NAME = "omp-fabric";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPGRADE_COMMAND = `omp plugin install ${PACKAGE_NAME}`;
const REQUEST_TIMEOUT_MS = 4_000;

export const UPDATE_STATUS_KEY = "fabric-update";
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;

interface UpdateCheckCache {
  format: 1;
  checkedAt: number;
  latest: string;
  notified?: string;
}

export interface FabricUpdateNotice {
  installed: string;
  latest: string;
  message: string;
}

export type FabricUpdateFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface FabricUpdateCheckOptions {
  agentDir: string;
  installedVersion?: string;
  fetchImpl?: FabricUpdateFetch;
  now?: number;
  timeoutMs?: number;
}

export const updateCheckCachePath = (agentDir: string): string =>
  path.join(agentDir, "fabric", "update-check.json");

const installedVersionFromManifest = (): string | undefined => {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch {
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const readCache = (cachePath: string): UpdateCheckCache | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<UpdateCheckCache>;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return undefined;
    if (typeof parsed.latest !== "string" || parsed.latest.length === 0) return undefined;
    return {
      format: 1,
      checkedAt: parsed.checkedAt,
      latest: parsed.latest,
      ...(typeof parsed.notified === "string" ? { notified: parsed.notified } : {}),
    };
  } catch {
    return undefined;
  }
};

const writeCache = (cachePath: string, value: UpdateCheckCache): void => {
  try {
    writeJsonAtomic(cachePath, value, { space: 2, newline: true });
  } catch {
  }
};

const fetchLatestVersion = async (
  fetchImpl: FabricUpdateFetch,
  timeoutMs: number,
): Promise<string | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { version?: unknown } | null;
    const version = payload?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

export const checkFabricUpdate = async (
  options: FabricUpdateCheckOptions,
): Promise<FabricUpdateNotice | undefined> => {
  try {
    const installed = options.installedVersion ?? installedVersionFromManifest();
    if (installed === undefined) return undefined;
    const now = options.now ?? Date.now();
    const cachePath = updateCheckCachePath(options.agentDir);
    const cached = readCache(cachePath);
    const age = cached === undefined ? undefined : now - cached.checkedAt;
    const fresh = cached !== undefined && age !== undefined && age >= 0 && age < UPDATE_CHECK_TTL_MS;
    let record: UpdateCheckCache;
    if (fresh && cached !== undefined) {
      record = cached;
    } else {
      const latest = await fetchLatestVersion(
        options.fetchImpl ?? (globalThis.fetch as unknown as FabricUpdateFetch),
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      if (latest === undefined) return undefined;
      record = {
        format: 1,
        checkedAt: now,
        latest,
        ...(cached?.notified === undefined ? {} : { notified: cached.notified }),
      };
    }
    const behind = compareVersions(record.latest, installed) === 1;
    const announce = behind && record.notified !== record.latest;
    if (!fresh || announce) {
      writeCache(cachePath, announce ? { ...record, notified: record.latest } : record);
    }
    if (!announce) return undefined;
    return {
      installed,
      latest: record.latest,
      message: `${PACKAGE_NAME} ${installed} → ${record.latest} · ${UPGRADE_COMMAND}`,
    };
  } catch {
    return undefined;
  }
};

export interface FabricUpdateScheduleOptions {
  enabled: boolean;
  agentDir: string;
  installedVersion?: string;
  fetchImpl?: FabricUpdateFetch;
  now?: number;
}

export const scheduleFabricUpdateCheck = async (
  context: ExtensionContext,
  options: FabricUpdateScheduleOptions,
): Promise<void> => {
  if (!options.enabled || !context.hasUI) return;
  let sessionId: string;
  try {
    sessionId = context.sessionManager.getSessionId();
  } catch {
    return;
  }
  if (resolveFabricIdentity(sessionId).identity.kind !== "main") return;
  const notice = await checkFabricUpdate({
    agentDir: options.agentDir,
    ...(options.installedVersion === undefined ? {} : { installedVersion: options.installedVersion }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (notice === undefined) return;
  try {
    context.ui.setStatus(UPDATE_STATUS_KEY, notice.message);
  } catch {
  }
};
