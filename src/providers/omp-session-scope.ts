import { AgentRegistry, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobManagerApi } from "@oh-my-pi/pi-coding-agent/async";
import { isSettingsInitialized, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

export type LiveAgentSession = AgentSessionHandle
  & Partial<Pick<AgentSession, "asyncJobManager" | "getAgentId" | "settings">>;

export const liveAgentSession = (session: AgentSessionHandle): LiveAgentSession => session as LiveAgentSession;

interface JobOwner {
  manager: AsyncJobManagerApi;
  agentId: string;
}

const liveOwner = (sessionId: string | null): JobOwner | undefined => {
  if (!sessionId) return undefined;
  for (const ref of AgentRegistry.global().list()) {
    if (ref.session?.sessionManager.getSessionId() !== sessionId) continue;
    const session = liveAgentSession(ref.session);
    const manager = session.asyncJobManager;
    const agentId = session.getAgentId?.() ?? ref.id;
    return manager ? { manager, agentId } : undefined;
  }
  return undefined;
};

export interface OmpJobScope {
  manager: AsyncJobManagerApi;
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

export const shellBackgroundSettings = (
  jobs: OmpJobScope | undefined,
  asyncEnabled: () => boolean = hostAsyncEnabled,
  autoBackground: () => boolean = () => false,
): Record<string, unknown> => ({
  "async.enabled": jobs ? asyncEnabled() : false,
  "bash.autoBackground.enabled": jobs ? autoBackground() : false,
});
