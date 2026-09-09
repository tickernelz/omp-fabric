import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { LcmRuntime } from "./lcm-runtime.js";

export type LcmRuntimeConstructor = new (
  ...args: ConstructorParameters<typeof LcmRuntime>
) => LcmRuntime;

export interface LcmRuntimeLoader {
  readonly unavailable: boolean;
  load(context: ExtensionContext): Promise<LcmRuntimeConstructor | undefined>;
}

export const LCM_SQLITE_NOTICE =
  "omp-fabric LCM compaction needs node:sqlite, which this runtime does not provide";

export const createLcmRuntimeLoader = (
  importRuntime: () => Promise<{ LcmRuntime: LcmRuntimeConstructor }> = () =>
    import("./lcm-runtime.js") as unknown as Promise<{ LcmRuntime: LcmRuntimeConstructor }>,
): LcmRuntimeLoader => {
  let unavailable = false;
  return {
    get unavailable(): boolean {
      return unavailable;
    },
    async load(context: ExtensionContext): Promise<LcmRuntimeConstructor | undefined> {
      if (unavailable) return undefined;
      try {
        return (await importRuntime()).LcmRuntime;
      } catch (error) {
        unavailable = true;
        const detail = error instanceof Error ? error.message : String(error);
        const notice = `${LCM_SQLITE_NOTICE} (${detail}). Compaction falls back to OMP core.`;
        console.warn(`[omp-fabric] ${notice}`);
        if (context.hasUI) context.ui.notify(notice, "warning");
        return undefined;
      }
    },
  };
};
