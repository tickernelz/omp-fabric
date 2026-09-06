import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface OmpBinaryResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  isExecutable?: (file: string) => boolean;
}

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveOmpBinary = (
  configured?: string,
  options: OmpBinaryResolutionOptions = {},
): string => {
  if (configured !== undefined) return configured;
  const env = options.env ?? process.env;
  if (env.OMP_FABRIC_OMP_BINARY !== undefined) return env.OMP_FABRIC_OMP_BINARY;

  if (env.LOCALTERM === "1") {
    const shim = path.join(options.homeDirectory ?? homedir(), ".localterm", "shims", "omp");
    if ((options.isExecutable ?? executable)(shim)) return shim;
  }

  return "omp";
};
