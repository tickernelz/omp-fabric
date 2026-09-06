import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { runResidentHostFromConfigPath } from "./host.js";

const configPath = process.env.OMP_FABRIC_RESIDENT_CONFIG;

export default function (omp: ExtensionAPI): void {
  let controller: AbortController | undefined;
  let host: Promise<void> | undefined;

  omp.on("session_start", (_event, ctx) => {
    if (host) return;
    if (!configPath) {
      ctx.shutdown();
      return;
    }
    controller = new AbortController();
    host = runResidentHostFromConfigPath(configPath, controller.signal)
      .catch(() => undefined)
      .finally(() => ctx.shutdown());
  });

  omp.on("session_shutdown", () => controller?.abort());
}
