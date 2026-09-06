import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { spawnDetached, transportStderrPath } from "./process-utils.js";

export class ProcessTransport implements AgentTransportAdapter {
  readonly kind = "process" as const;

  async available(): Promise<boolean> {
    return true;
  }

  async launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const processHandle = await spawnDetached(
      request.workerPath,
      request.workerArguments,
      request.cwd,
      request.runDirectory
        ? { stderrFile: transportStderrPath(request.runDirectory) }
        : {},
    );
    return {
      kind: this.kind,
      sessionId: String(processHandle.pid),
      isAlive: processHandle.isAlive,
      stop: processHandle.stop,
    };
  }
}
