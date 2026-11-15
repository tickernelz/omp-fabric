import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "./types.js";
import {
  buildThinkingDigest,
  THINKING_DIGEST_CUSTOM_TYPE,
  thinkingTransferPolicy,
  translateThinkingForExecutor,
  type ThinkingTransferInput,
  type ThinkingTransferReport,
} from "./thinking-transfer.js";

interface HandoffSessionSource {
  getBranch(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

interface CurrentModel {
  provider: string;
  id: string;
}

type NativeAssistantMessage = Extract<
  SessionMessageEntry["message"],
  { role: "assistant" }
>;
type NativeAssistantEntry = SessionMessageEntry & {
  message: NativeAssistantMessage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolCall = (value: unknown): value is {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments);

const activeFabricTurn = (
  source: HandoffSessionSource,
  outerToolCallId: string,
): NativeAssistantEntry => {
  const leafId = source.getLeafId();
  const entry = leafId ? source.getEntry(leafId) : undefined;
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(
      "Trajectory handoff requires the active fabric_exec assistant turn to be the session leaf",
    );
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const toolCalls = content.filter(isToolCall);
  if (!toolCalls.some((call) => call.id === outerToolCallId)) {
    throw new Error(
      "Trajectory handoff could not find the active fabric_exec assistant turn in the OMP session",
    );
  }
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== "fabric_exec") {
    throw new Error(
      "Trajectory handoff requires fabric_exec to be the only top-level tool call in its assistant turn",
    );
  }
  return entry as NativeAssistantEntry;
};

export const snapshotHandoffSession = (
  source: HandoffSessionSource,
  currentModel: CurrentModel | undefined,
  outerToolResult: AgentToolResultMessage,
  outerToolCallId: string,
  carryBranch = false,
): AgentSessionSeed => {
  if (
    outerToolResult.toolCallId !== outerToolCallId ||
    outerToolResult.toolName !== "fabric_exec"
  ) {
    throw new Error("Trajectory handoff requires the finalized outer fabric_exec result");
  }
  const active = activeFabricTurn(source, outerToolCallId);
  const sourceSessionFile = source.getSessionFile();
  const branch = source.getBranch();
  let model = currentModel
    ? { provider: currentModel.provider, modelId: currentModel.id }
    : undefined;
  let thinkingLevel: string | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!thinkingLevel && entry?.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel ?? undefined;
    }
    if (!model && entry?.type === "model_change") {
      const separator = entry.model.indexOf("/");
      if (separator > 0 && separator < entry.model.length - 1) {
        model = { provider: entry.model.slice(0, separator), modelId: entry.model.slice(separator + 1) };
      }
    }
    if (model && thinkingLevel) break;
  }
  return {
    sourceSessionId: source.getSessionId(),
    ...(sourceSessionFile ? { sourceSessionFile } : {}),
    sourceBranchLeafId: active.id,
    ...(!sourceSessionFile || carryBranch ? { sourceBranch: structuredClone(branch) } : {}),
    ...(model ? { sourceModel: model } : {}),
    ...(thinkingLevel ? { sourceThinkingLevel: thinkingLevel } : {}),
    outerToolResult: structuredClone(outerToolResult),
  };
};

const materializeBranch = async (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): Promise<SessionManager> => {
  if (!seed.sourceBranch) {
    throw new Error("In-memory trajectory handoff is missing its source branch");
  }
  const id = randomUUID();
  const sessionFile = path.join(directory, `handoff-${id}.jsonl`);
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    ...(seed.sourceSessionFile ? { parentSession: seed.sourceSessionFile } : {}),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, ...seed.sourceBranch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return SessionManager.open(sessionFile, directory, undefined, { initialCwd: cwd });
};

const forkBranch = async (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): Promise<SessionManager> => {
  if (!seed.sourceSessionFile) return materializeBranch(seed, cwd, directory);
  const fork = await SessionManager.open(seed.sourceSessionFile, directory, undefined, { initialCwd: cwd });
  if (!fork.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted OMP session`,
    );
  }
  fork.createBranchedSession(seed.sourceBranchLeafId);
  const sessionFile = fork.getSessionFile();
  if (!sessionFile) {
    throw new Error("Trajectory handoff could not create a persisted OMP session branch");
  }
  return SessionManager.open(sessionFile, directory, undefined, { initialCwd: cwd });
};

// File-backed read of the exact branch prefix, cloned so transfer translation
// never mutates the source session's live entries. Used instead of
// forkBranch when the executor's reasoning channel differs: createBranchedSession
// copies raw lines and cannot rewrite foreign thinking signatures.
const persistedBranch = async (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): Promise<SessionEntry[]> => {
  if (!seed.sourceSessionFile) {
    throw new Error("Persisted trajectory handoff is missing its source session file");
  }
  const source = await SessionManager.open(seed.sourceSessionFile, directory, undefined, { initialCwd: cwd });
  if (!source.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted OMP session`,
    );
  }
  return structuredClone(source.getBranch(seed.sourceBranchLeafId));
};

const synchronizeSourceSettings = (
  session: SessionManager,
  seed: AgentSessionSeed,
): void => {
  const context = session.buildSessionContext();
  const currentModel = context.models.default;
  const sourceModel = seed.sourceModel
    ? `${seed.sourceModel.provider}/${seed.sourceModel.modelId}`
    : undefined;
  if (sourceModel && currentModel !== sourceModel) session.appendModelChange(sourceModel);
  if (seed.sourceThinkingLevel && context.thinkingLevel !== seed.sourceThinkingLevel) {
    session.appendThinkingLevelChange(seed.sourceThinkingLevel);
  }
};

export const writeHandoffSession = async (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
  transfer?: ThinkingTransferInput,
): Promise<string> => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policy = transfer ? thinkingTransferPolicy(transfer) : "preserved";
  let session: SessionManager;
  let report: ThinkingTransferReport | undefined;
  let digest: { content: string; citedBlocks: number } | undefined;
  if (!transfer || policy === "preserved") {
    session = seed.sourceBranchRetired && seed.sourceBranch
      ? await materializeBranch(seed, cwd, directory)
      : await forkBranch(seed, cwd, directory);
  } else {
    const rawBranch = seed.sourceBranchRetired && seed.sourceBranch
      ? structuredClone(seed.sourceBranch)
      : seed.sourceSessionFile
      ? await persistedBranch(seed, cwd, directory)
      : structuredClone(seed.sourceBranch ?? (() => {
          throw new Error("Trajectory handoff transfer is missing its source branch");
        })());
    if (policy === "stripped") digest = buildThinkingDigest(rawBranch, transfer);
    const translated = translateThinkingForExecutor(rawBranch, policy);
    report = translated.report;
    session = await materializeBranch({ ...seed, sourceBranch: translated.entries }, cwd, directory);
  }
  synchronizeSourceSettings(session, seed);
  session.appendMessage(seed.outerToolResult);
  if (digest) {
    session.appendCustomMessageEntry(THINKING_DIGEST_CUSTOM_TYPE, digest.content, false, {
      policy,
      citedBlocks: digest.citedBlocks,
    });
  }
  session.appendCustomEntry("omp-fabric-handoff", {
    sourceSessionId: seed.sourceSessionId,
    boundary: "fabric_exec_end",
    ...(transfer && report
      ? {
          thinkingTransfer: {
            policy: report.policy,
            translated: report.translated,
            dropped: report.dropped,
            target: `${transfer.target.provider}/${transfer.target.modelId}`,
          },
        }
      : {}),
  });
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Trajectory handoff did not produce an OMP session file");
  fs.chmodSync(sessionFile, 0o600);
  return sessionFile;
};
