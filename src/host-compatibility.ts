import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const MINIMUM_OMP_HOST_VERSION = "18.3.0";

const OMP_HOST_PACKAGE_NAMES: Record<string, true> = {
  "@oh-my-pi/pi-coding-agent": true,
};

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease?: string;
}

const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
};

export const compareVersions = (left: string, right: string): number | undefined => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < a.numbers.length; index++) {
    const delta = a.numbers[index]! - b.numbers[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return (a.prerelease ?? "").localeCompare(b.prerelease ?? "");
};

const manifestHostVersion = (directory: string): string | undefined => {
  const manifestPath = path.join(directory, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      typeof manifest.name === "string" &&
      OMP_HOST_PACKAGE_NAMES[manifest.name] === true &&
      typeof manifest.version === "string"
    ) {
      return manifest.version;
    }
  } catch {
  }
  return undefined;
};

const walkForHostVersion = (startPath: string): string | undefined => {
  let directory: string;
  try {
    directory = path.dirname(realpathSync(startPath));
  } catch {
    return undefined;
  }
  while (true) {
    const version = manifestHostVersion(directory);
    if (version) return version;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

export const detectOmpHostVersion = (
  cliPath: string | undefined = process.argv[1],
): string | undefined => (cliPath ? walkForHostVersion(cliPath) : undefined);

export interface HostVersionWitnesses {
  argvPath?: string | undefined;
  execPath?: string | undefined;
  hostVersion?: () => Promise<string | undefined>;
}

const hostModuleVersion = async (): Promise<string | undefined> =>
  await import("@oh-my-pi/pi-coding-agent").then(
    (host) => (typeof host.VERSION === "string" ? host.VERSION : undefined),
    () => undefined,
  );

export const resolveHostVersion = async (
  witnesses: HostVersionWitnesses = {},
): Promise<string | undefined> => {
  const argvPath = "argvPath" in witnesses ? witnesses.argvPath : process.argv[1];
  const execPath = "execPath" in witnesses ? witnesses.execPath : process.execPath;
  return (argvPath ? walkForHostVersion(argvPath) : undefined)
    ?? (execPath ? walkForHostVersion(execPath) : undefined)
    ?? await (witnesses.hostVersion ?? hostModuleVersion)();
};

export const ompHostCompatibilityWarning = (
  version: string | undefined = detectOmpHostVersion(),
): string | undefined => {
  if (!version) return undefined;
  const comparison = compareVersions(version, MINIMUM_OMP_HOST_VERSION);
  if (comparison === undefined || comparison >= 0) return undefined;
  return `OMP Fabric requires OMP >= ${MINIMUM_OMP_HOST_VERSION}; detected ${version}. Upgrade OMP before relying on Fabric continuation behavior.`;
};
