import type { Judge } from "@oh-my-pi/pi-ai";

/** Host key selecting the chat-model judge chain; an unknown key makes `resolveJudge` throw, which the lane reports as unsupported. */
const ONLINE_JUDGMENT_BACKEND = "online";

export interface HostJudgeContext {
  modelRegistry?: unknown;
  model?: unknown;
  sessionId?: string;
}

interface JudgmentModule {
  resolveJudge: (deps: Record<string, unknown>) => Judge;
}

interface SettingsModule {
  settings: unknown;
}

/**
 * Resolves the host's judge (TypeSafe when credentialed, else its tiny/smol chat chain).
 * Returns `undefined` on a host that predates the judgment module so the lane stays inert.
 */
export const resolveHostJudge = async (context: HostJudgeContext): Promise<Judge | undefined> => {
  if (context.modelRegistry === undefined) return undefined;
  const [judgment, settingsModule] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/judgment") as Promise<unknown>,
    import("@oh-my-pi/pi-coding-agent/config/settings") as Promise<unknown>,
  ]);
  const resolveJudge = (judgment as Partial<JudgmentModule>).resolveJudge;
  const settings = (settingsModule as Partial<SettingsModule>).settings;
  if (typeof resolveJudge !== "function" || settings === undefined) return undefined;
  return resolveJudge({
    settings,
    registry: context.modelRegistry,
    backend: ONLINE_JUDGMENT_BACKEND,
    ...(context.model !== undefined ? { sessionModel: context.model } : {}),
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
  });
};
