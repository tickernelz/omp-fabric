import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { isSettingsInitialized, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

interface JobOwner {
  manager: AsyncJobManager;
  agentId: string;
}

const liveOwner = (sessionId: string | null): JobOwner | undefined => {
  if (!sessionId) return undefined;
  for (const ref of AgentRegistry.global().list()) {
    if (ref.session?.sessionManager.getSessionId() !== sessionId) continue;
    const manager = ref.session.asyncJobManager;
    const agentId = ref.session.getAgentId() ?? ref.id;
    return manager ? { manager, agentId } : undefined;
  }
  return undefined;
};

export interface OmpJobScope {
  manager: AsyncJobManager;
  agentId: () => string | null;
}

/** Job scope for one session identity; the owner id is re-resolved per call because `/new` re-mints it. */
export const ompJobScope = (getSessionId: () => string | null): OmpJobScope | undefined => {
  const owner = liveOwner(getSessionId());
  if (!owner) return undefined;
  return {
    manager: owner.manager,
    agentId: () => liveOwner(getSessionId())?.agentId ?? null,
  };
};

const hostAsyncEnabled = (): boolean =>
  isSettingsInitialized() ? cfgAsyncEnabled.get(Settings.instance) : true;

/** Auto-background stays off: a handover would resolve a guest call with a job notice in place of output. */
export const shellBackgroundSettings = (
  jobs: OmpJobScope | undefined,
  asyncEnabled: () => boolean = hostAsyncEnabled,
): Record<string, unknown> => ({
  "async.enabled": jobs ? asyncEnabled() : false,
  "bash.autoBackground.enabled": false,
});
