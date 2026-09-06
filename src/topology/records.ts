import type { FabricActorInfo } from "../actors/types.js";
import type { AgentHandleInfo, AgentRunRecord } from "../agents/types.js";
import type { FabricParticipantRecord } from "./types.js";

const isAgentRunRecord = (
  record: AgentRunRecord | AgentHandleInfo,
): record is AgentRunRecord => "startedAt" in record;

export const agentParticipantRecords = (
  records: Array<AgentRunRecord | AgentHandleInfo>,
  rootId: string,
  ownerHostId: string,
  ownerIdentityId: string,
  parentId: string,
  firstSeen: Map<string, number>,
): FabricParticipantRecord[] => {
  const participants: FabricParticipantRecord[] = [];
  const append = (
    record: AgentRunRecord | AgentHandleInfo,
    semanticParentId: string,
  ): void => {
    const observedAt = firstSeen.get(record.id) ?? Date.now();
    firstSeen.set(record.id, observedAt);
    const run = isAgentRunRecord(record) ? record : undefined;
    const parent = record.actorId ?? semanticParentId;
    if (record.actorId) return;
    const active = record.status === "queued" || record.status === "running";
    participants.push({
      format: 1,
      id: record.id,
      kind: "agent",
      rootId,
      ownerHostId,
      ownerIdentityId,
      parentId: parent,
      name: record.name,
      status: record.status,
      residency: record.residency ?? "session",
      runner: record.runner,
      transport: record.transport,
      capabilities: [
        ...(active ? (["steer", "followUp", "stop"] as const) : []),
        ...(record.attachCommand ? (["attach"] as const) : []),
        ...(record.recursive ? (["fabric"] as const) : []),
      ],
      cwd: record.cwd,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      startedAt: run?.startedAt ?? observedAt,
      updatedAt: run?.updatedAt ?? observedAt,
      ...(run?.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run?.currentTool ? { currentTool: run.currentTool } : {}),
      ...(run ? { turns: run.turns, toolCalls: run.toolCalls, usage: { ...run.usage } } : {}),
      controlProtocol: "v1",
    });
  };
  for (const record of records) append(record, parentId);
  return participants;
};

export const actorParticipantRecord = (
  actor: FabricActorInfo,
  rootId: string,
  ownerHostId: string,
  ownerIdentityId: string,
  parentId: string,
): FabricParticipantRecord => ({
  format: 1,
  id: actor.id,
  kind: "actor",
  rootId: actor.rootId ?? rootId,
  ownerHostId,
  ownerIdentityId,
  parentId,
  name: actor.name,
  status: actor.status,
  residency: actor.residency ?? "session",
  runner: actor.runner,
  transport: "host",
  capabilities: [
    ...(actor.status === "stopped"
      ? []
      : (["steer", "followUp", "stop", "ask", "actor-bindings"] as const)),
    ...(actor.runner === "omp" && actor.extensions !== false ? (["fabric"] as const) : []),
  ],
  ...(actor.model ? { model: actor.model } : {}),
  ...(actor.thinking ? { thinking: actor.thinking } : {}),
  startedAt: actor.createdAt,
  updatedAt: actor.updatedAt,
  actorQueued: actor.queued,
  actorMessages: actor.messages,
  controlProtocol: "v1",
});
