import type { Usage } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { defaultCodePreviewSettings } from "./ui/code-preview.js";
import {
  type FabricToolShellDecorator,
  withCodePreviewShell,
} from "./ui/code-preview-shell.js";
import { registerFabricActorHostEventObservers } from "./actors/host-event-observer.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { registerFabricCommand } from "./commands/fabric.js";
import { resolveAgentDir } from "./core/agent-dir.js";
import {
  AUTO_APPLY_PROPOSAL_KINDS,
  compileEntropySurfaceAsync,
  compiledSurfaceEffectChanged,
  entropyRepairRows,
  entropyReviewKey,
  formatEntropyCompileNotice,
  formatEntropyReviewNotice,
  liveSurfaceSnapshot,
  loadCompiledSurfaceAsync,
  loadObservationPoolAsync,
  machineSessionFilesAsync,
  mergeObservationWindowAsync,
  poolToValueObservations,
  saveCompiledSurfaceAsync,
  saveObservationPoolAsync,
  sessionWindowEvidenceAsync,
} from "./entropy/index.js";
import { setActiveCompiledSurface } from "./entropy/active.js";
import {
  filterPrewalkContinuationMessages,
  settleInPlacePrewalk,
  withTrajectoryRearmDirective,
} from "./prewalk/handoff.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import { autoArmFabricPrewalk } from "./prewalk/arm.js";
import { FabricSpeculationWarmup } from "./speculation/warmup.js";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
} from "./config.js";
import { registerCompactionHook } from "./compaction/hook.js";
import type { LcmRuntime } from "./compaction/lcm-runtime.js";
import { createLcmRuntimeLoader } from "./compaction/lcm-loader.js";
import { canonicalProjectIdentity } from "./storage/lcm-identity.js";
import { compactAtConfiguredThreshold } from "./compaction/threshold.js";
import {
  createToolOwnershipReassertion,
  FabricToolLifecycle,
  FabricToolOwnership,
  ownsFabricToolSource,
} from "./core/tool-ownership.js";
import {
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "./core/skill-dir.js";
import { coreOverridePromptGuidance } from "./core/core-override-guidance.js";
import { OMP_CORE_TOOL_NAMES } from "./core/omp-tools.js";
import {
  fabricExecutionKernelGuidance,
  defaultFabricExecutionGuidance,
  fabricSchemaGuidance,
  extensionToolRosterGuidance,
} from "./core/system-guidance.js";
import {
  FABRIC_EXECUTION_GUIDANCE_SLOT,
  resolveFabricModelGuidance,
} from "./components/model-guidance.js";
import {
  activeSkills,
  listableSkills,
  restoreSkillsForFullCodePrompt,
} from "./core/skill-prompt.js";
import {
  formatProxyContractReminder,
  PROXY_CONTRACT_CUSTOM_TYPE,
  ProxyContractLedger,
  proxyContractMentionsInSkills,
  rewritableHiddenCapturedToolNames,
} from "./core/proxy-contract.js";
import {
  FabricDirectToolApproval,
  mergeFabricApprovalUsage,
} from "./core/direct-tool-approval.js";
import { buildSkillReferenceGuidance } from "./core/skill-references.js";
import { createFabricExecTool } from "./fabric-exec-tool.js";
import { FabricState } from "./fabric-state.js";
import { classifyToolResult } from "./repairs/classify.js";
import { getActiveRepairCompiler } from "./repairs/active.js";
import { ompHostCompatibilityWarning } from "./host-compatibility.js";
import { scheduleFabricUpdateCheck } from "./update/check.js";
import {
  FABRIC_COMPONENT_REGISTER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricComponentRegistration,
  type FabricProviderRegistration,
} from "./protocol.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import { FabricUiController } from "./ui/controller.js";
import { installFabricEscapeHalt } from "./ui/escape-halt.js";
import { FabricToolDisplayController } from "./ui/tool-display.js";
import { configureHighlighting } from "./ui/highlight.js";
import { formatFabricValue } from "./ui/structured.js";
import { truncateMiddle } from "./util.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the Fabric skills bundled with this extension. Resolved
// relative to the extension entry so it works both in development (src/) and
// in an installed package (dist/). Contributed via resources_discover so child
// OMP processes that load Fabric with -e (agents and actors) discover the
// same fabric-exec / fabric-advisor / fabric-council skill references as the
// main agent, which gets them through the package manifest.
const FABRIC_EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));
const FABRIC_ENTRY_DIR = path.dirname(FABRIC_EXTENSION_ENTRY_PATH);
const FABRIC_RUNTIME_PATHS = {
  extension: FABRIC_EXTENSION_ENTRY_PATH,
  worker: path.join(FABRIC_ENTRY_DIR, "worker.js"),
  residentHost: path.join(FABRIC_ENTRY_DIR, "residency", "launcher.js"),
  skills: path.resolve(FABRIC_ENTRY_DIR, "..", "skills"),
};
const FABRIC_SKILLS_DIR = FABRIC_RUNTIME_PATHS.skills;

const componentRegistrationFrom = (
  value: unknown,
): FabricComponentRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<FabricComponentRegistration>;
  const component = registration.component;
  if (
    registration.version !== 1 ||
    typeof component !== "object" ||
    component === null ||
    typeof component.name !== "string" ||
    typeof component.activate !== "function"
  ) {
    return undefined;
  }
  return registration as FabricComponentRegistration;
};

const registrationFrom = (value: unknown): FabricProviderRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<FabricProviderRegistration>;
  const provider = registration.provider;
  if (
    registration.version !== 1 ||
    typeof provider !== "object" ||
    provider === null ||
    typeof provider.name !== "string" ||
    typeof provider.description !== "string" ||
    typeof provider.list !== "function" ||
    typeof provider.describe !== "function" ||
    typeof provider.invoke !== "function"
  ) {
    return undefined;
  }
  return registration as FabricProviderRegistration;
};

const SKILL_REFERENCE_CUSTOM_TYPE = "omp-fabric-skill-reference";

export default async function ompFabric(omp: ExtensionAPI): Promise<void> {
  const codePreviewSettings = defaultCodePreviewSettings();
  const decorateShell: FabricToolShellDecorator = withCodePreviewShell;
  let compatibilityWarningShown = false;
  let updateCheckStarted = false;
  configureHighlighting(
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
  );
  const capturedTools = new CapturedToolCatalog();
  const proxyContract = new ProxyContractLedger();
  const state = new FabricState(omp, capturedTools, {
    paths: FABRIC_RUNTIME_PATHS,
    lcmContext: () => lcmRuntime?.memoryContext(),
    lcmRuntime: () => lcmRuntime,
  });
  const directToolApproval = new FabricDirectToolApproval(
    omp,
    () => state.config,
    state.sessionApprovals,
  );
  const pendingHandoffs = new Map<string, PendingFabricHandoff>();
  let lcmRuntime: LcmRuntime | undefined;
  const lcmLoader = createLcmRuntimeLoader();
  let lcmCwd: string | undefined;
  let lcmProjectKey: string | undefined;
  const toolOwnership = new FabricToolOwnership(omp);
  const fabricUi = new FabricUiController(state, codePreviewSettings, {
    getToolDefinition: (name) => name === "fabric_exec" ? fabricTool : capturedTools.get(name)?.definition,
    getMessageRenderer: (type) => capturedTools.runner?.getMessageRenderer(type),
  });
  const toolDisplay = new FabricToolDisplayController();

  const capturePolicy = () => effectiveToolCaptureConfig(state.config);
  const fabricOwnsModelTools = (): boolean =>
    state.config.fullCodeMode || state.config.schema.mode === "enforce";
  const hiddenCapturedToolNames = (): Set<string> => {
    const policy = capturePolicy();
    const keep = new Set([...policy.keepVisible, ...policy.includeTools]);
    return new Set(
      capturedTools.list()
        .map((entry) => entry.name)
        .filter((name) => policy.hideFromModel && !keep.has(name) && !policy.excludeTools.includes(name)),
    );
  };
  const ownershipPolicy = () => {
    const policy = capturePolicy();
    return {
      fullCodeMode: state.config.fullCodeMode,
      schemaMode: state.config.schema.mode,
      includeTools: new Set(policy.includeTools),
      excludeTools: new Set(policy.excludeTools),
    };
  };
  const { reassert: reassertToolOwnership, schedule: scheduleOwnershipReassert } =
    createToolOwnershipReassertion({
      ready: () => state.cwd !== undefined,
      active: () => state.cwd !== undefined,
      hiddenNames: hiddenCapturedToolNames,
      apply: (hidden) => toolOwnership.apply(ownershipPolicy(), hidden),
    });

  const unsubscribeComponentRegistration = omp.events.on(
    FABRIC_COMPONENT_REGISTER_EVENT,
    (value: unknown) => {
      const registration = componentRegistrationFrom(value);
      if (!registration) throw new Error("Invalid OMP Fabric component registration");
      state.registerExternalComponent(
        registration.component,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

  const unsubscribeProviderRegistration = omp.events.on(
    FABRIC_PROVIDER_REGISTER_EVENT,
    (value: unknown) => {
      const registration = registrationFrom(value);
      if (!registration) throw new Error("Invalid OMP Fabric provider registration");
      state.registerExternal(
        registration.provider,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

  omp.on("resources_discover", async () => {
    if (existsSync(FABRIC_SKILLS_DIR)) return { skillPaths: [FABRIC_SKILLS_DIR] };
    return {};
  });

  const fabricTool = createFabricExecTool(
    state,
    codePreviewSettings,
    pendingHandoffs,
    decorateShell,
    toolDisplay,
  );
  const refreshCodePreviewSettings = (): void => {
    Object.assign(codePreviewSettings, state.config.codePreview);
    configureHighlighting(
      codePreviewSettings.shikiTheme,
      codePreviewSettings.syntaxHighlighting,
    );
  };
  const fabricToolLifecycle = new FabricToolLifecycle(
    () => ownsFabricToolSource(omp.getAllTools(), FABRIC_EXTENSION_ENTRY_PATH),
    () => state.initialized ? state.execution.authorizer : undefined,
    () => state.initialized ? directToolApproval : undefined,
  );

  const inactiveCapturePolicy = {
    ...structuredClone(DEFAULT_FABRIC_CONFIG.capture),
    enabled: false,
    hideFromModel: false,
  };
  const toolCapture = await installRegisteredToolCapture({
    anchorDefinition: fabricTool,
    catalog: capturedTools,
    initialPolicy: inactiveCapturePolicy,
    onCatalogRefresh: () => {
      scheduleOwnershipReassert();
    },
  });
  omp.registerTool(fabricTool);
  const applyFabricMode = (): void => {
    capturedTools.markResumed();
    toolCapture.setPolicy(capturePolicy());
    omp.registerTool(fabricTool);
    toolOwnership.apply(ownershipPolicy(), hiddenCapturedToolNames());
    capturedTools.refresh();
  };
  const suspendToolCapture = (): void => {
    // Mark the suspension before the policy flip: setPolicy clears the
    // catalog, and the freeze must already be in effect when that clear
    // reaches derived-surface listeners.
    capturedTools.markSuspended();
    toolCapture.setPolicy(inactiveCapturePolicy);
  };

  // ESC stop-the-world: a lone Escape (debounced to ignore escape sequences
  // such as arrow keys) halts every persistent actor — aborting in-flight runs
  // and cancelling queued work — and arms a stop-the-world gate that freezes
  // host-event and mesh dispatch so the interrupted actors are not re-armed by
  // the interrupt's own turn_end / agent_end events. The gate lifts when the
  // user resumes by sending a new message (the "input" host event). Escape is
  // observed but not consumed, so OMP's native cancel-streaming still fires;
  // single ESC therefore stops the current turn and the advisor/supervisor
  // actors at once. Disabled when mesh/actors are off or ui.haltOnEscape is
  // false.
  let haltOnEscapeUnsubscribe: (() => void) | undefined;
  const uninstallHaltOnEscape = (): void => {
    haltOnEscapeUnsubscribe?.();
    haltOnEscapeUnsubscribe = undefined;
  };
  const installHaltOnEscape = (context: ExtensionContext): void => {
    uninstallHaltOnEscape();
    if (!state.config.ui.haltOnEscape || !state.config.mesh.enabled) return;
    haltOnEscapeUnsubscribe = installFabricEscapeHalt(context, {
      enabled: () => state.initialized && state.config.mesh.enabled && state.config.ui.haltOnEscape,
      ownsInput: () => fabricUi.ownsInput,
      halted: () => state.actors.halted,
      halt: () => state.actors.haltAll().halted,
    });
  };

  const refreshProxyLedger = (context: ExtensionContext): void => {
    proxyContract.restoreFromEntries(context.sessionManager?.getBranch?.() ?? []);
  };

  // alwaysRearm means always armed: every session opens with prewalk armed.
  // Config-health skips (no prewalk.model, gated modes) warn once per process
  // rather than on every session switch.
  let prewalkAutoArmNoticeShown = false;
  const autoArmPrewalk = async (context: ExtensionContext): Promise<void> => {
    const skipReason = await autoArmFabricPrewalk(state, context, omp);
    if (!skipReason || prewalkAutoArmNoticeShown || !context.hasUI) return;
    prewalkAutoArmNoticeShown = true;
    context.ui.notify(skipReason, "warning");
  };

  const cleanupActivationSideEffects = (): void => {
    uninstallHaltOnEscape();
    fabricUi.stop();
  };
  state.setActivationHook(async (context) => {
    refreshCodePreviewSettings();
    Object.assign(
      fabricTool,
      createFabricExecTool(state, codePreviewSettings, pendingHandoffs, decorateShell, toolDisplay),
    );
    await autoArmPrewalk(context);
    applyFabricMode();
    fabricUi.start(context);
    installHaltOnEscape(context);
  }, cleanupActivationSideEffects);

  // Continual entropy reduction runs off the interaction path. Session-tree
  // discovery and JSONL ingestion use async I/O, scoring yields in fixed trace
  // chunks, and durable stores acquire locks cooperatively. Turn hooks only
  // enqueue work; a pending turn coalesces to the newest context.
  let entropyEvidenceThisTurn = false;
  let entropyCompileInFlight: Promise<void> | undefined;
  let entropyCompilePending: EntropyCompileRequest | undefined;
  let entropyLastReview = "";
  let entropyLifecycleEpoch = 0;

  interface EntropyCompileRequest {
    context: ExtensionContext;
    delayMs: number;
    epoch: number;
  }

  const compileEntropyNow = async (
    context: ExtensionContext,
    epoch: number,
  ): Promise<void> => {
    const current = (): boolean =>
      epoch === entropyLifecycleEpoch && state.initialized && state.config.entropy.compile;
    if (!current()) return;
    const startedAt = performance.now();
    const agentDir = resolveAgentDir();
    const cwd = state.cwd ?? context.cwd;
    const repairs = entropyRepairRows(state.repairs.repairs);
    const [files, loaded, poolLoaded, snapshot] = await Promise.all([
      machineSessionFilesAsync(agentDir, cwd),
      loadCompiledSurfaceAsync(agentDir),
      loadObservationPoolAsync(agentDir),
      liveSurfaceSnapshot({ registry: state.registry, extensionContext: context, cwd }),
    ]);
    if (!current() || files.length === 0 || loaded.error || poolLoaded.error) return;
    const evidence = await sessionWindowEvidenceAsync(files);
    if (!current() || evidence.traces.length === 0) return;
    const mergedPool = await mergeObservationWindowAsync(
      poolLoaded.file,
      evidence.observationWindows,
    );
    await saveObservationPoolAsync(agentDir, mergedPool.file);
    if (!current()) return;
    const outcome = await compileEntropySurfaceAsync({
      traces: evidence.traces,
      surface: snapshot,
      repairs,
      valueObservations: poolToValueObservations(mergedPool.file),
      auditCalls: evidence.auditCalls,
      ...(loaded.file ? { artifact: loaded.file } : {}),
    });
    if (!current()) return;
    const review = outcome.proposals.filter(
      (proposal) => !(AUTO_APPLY_PROPOSAL_KINDS as readonly string[]).includes(proposal.kind),
    );
    const reviewKey = entropyReviewKey(review);
    const reviewChanged = reviewKey !== entropyLastReview;
    let compileNotified = false;
    if (outcome.status === "compiled" && outcome.artifact) {
      const saved = await saveCompiledSurfaceAsync(agentDir, outcome.artifact);
      if (saved.written && current()) {
        // Activate immediately: enforcement follows the background compile,
        // never waiting for the next session start. Provenance-only artifact
        // updates stay silent because they do not alter the live surface.
        setActiveCompiledSurface(outcome.artifact);
        if (compiledSurfaceEffectChanged(loaded.file, outcome.artifact) && context.hasUI) {
          context.ui.notify(
            formatEntropyCompileNotice({
              proposals: outcome.proposals,
              beforeScore: outcome.report.score,
              afterScore: outcome.after?.score ?? outcome.report.score,
              elapsedMs: performance.now() - startedAt,
              ...(reviewChanged && review.length > 0 ? { reviewCount: review.length } : {}),
            }),
            "info",
          );
          compileNotified = true;
        }
      }
    }
    if (epoch !== entropyLifecycleEpoch) return;
    if (reviewChanged) {
      entropyLastReview = reviewKey;
      if (review.length > 0 && !compileNotified && context.hasUI) {
        context.ui.notify(formatEntropyReviewNotice(review), "info");
      }
    }
  };

  const launchEntropyCompile = (request: EntropyCompileRequest): void => {
    const task = (async () => {
      try {
        if (request.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, request.delayMs));
        }
        await compileEntropyNow(request.context, request.epoch);
      } catch (error) {
        console.warn(
          `[omp-fabric] entropy compile failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
    entropyCompileInFlight = task;
    void task.finally(() => {
      if (entropyCompileInFlight !== task) return;
      entropyCompileInFlight = undefined;
      const pending = entropyCompilePending;
      entropyCompilePending = undefined;
      if (pending) launchEntropyCompile(pending);
    });
  };

  const scheduleEntropyCompile = (
    context: ExtensionContext,
    delayMs = 250,
  ): void => {
    const request = { context, delayMs, epoch: entropyLifecycleEpoch };
    if (entropyCompileInFlight) {
      entropyCompilePending = request;
      return;
    }
    launchEntropyCompile(request);
  };

  const settleEntropyCompiles = async (): Promise<void> => {
    while (entropyCompileInFlight) await entropyCompileInFlight;
  };

  omp.on("session_start", async (_event, context) => {
    entropyLifecycleEpoch += 1;
    entropyEvidenceThisTurn = false;
    entropyCompilePending = undefined;
    entropyLastReview = "";
    pendingHandoffs.clear();
    directToolApproval.clear();
    toolDisplay.clear();
    uninstallHaltOnEscape();
    fabricUi.stop();
    suspendToolCapture();
    proxyContract.reset();
    refreshProxyLedger(context);
    if (!compatibilityWarningShown) {
      compatibilityWarningShown = true;
      const warning = ompHostCompatibilityWarning();
      if (warning) {
        console.warn(`[omp-fabric] ${warning}`);
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
    }
    await state.bootstrap(context);
    const recordedCwd = context.sessionManager.getRecordedCwd?.() || context.cwd;
    const projectKey = canonicalProjectIdentity({ liveCwd: recordedCwd }).key;
    if (lcmRuntime && (lcmCwd !== context.cwd || lcmProjectKey !== projectKey || state.config.compaction.engine !== "lcm")) {
      await lcmRuntime.shutdown();
      lcmRuntime = undefined;
      lcmCwd = undefined;
      lcmProjectKey = undefined;
    }
    if (state.config.compaction.engine === "lcm" && !lcmRuntime) {
      const LcmRuntimeClass = await lcmLoader.load(context);
      if (LcmRuntimeClass) lcmRuntime = new LcmRuntimeClass(context, () => ({
        ...(state.config.compaction.summaryModel ? { summaryModel: state.config.compaction.summaryModel } : {}),
        maxLeafEntries: state.config.compaction.lcmMaxLeafEntries,
        maxCondenseChildren: state.config.compaction.lcmMaxCondenseChildren,
        maxMaintenancePasses: state.config.compaction.lcmMaintenancePasses,
        modelSummaries: state.config.compaction.lcmModelSummaries,
        modelTimeoutSeconds: state.config.compaction.lcmModelTimeoutSeconds,
        maxDailyModelCalls: state.config.compaction.lcmMaxDailyModelCalls,
        maxSessionModelCalls: state.config.compaction.lcmMaxSessionModelCalls,
        maxDailyModelSeconds: state.config.compaction.lcmMaxDailyModelSeconds,
        lcmMaxInputChars: state.config.compaction.lcmMaxInputChars,
        lcmMaxOutputTokens: state.config.compaction.lcmMaxOutputTokens,
        lcmMaxOutputChars: state.config.compaction.lcmMaxOutputChars,
        softThresholdRatio: state.config.compaction.softThresholdRatio,
      }));
      lcmCwd = lcmRuntime ? context.cwd : undefined;
      lcmProjectKey = lcmRuntime?.projectKey;
    }
    if (state.config.compaction.engine === "lcm" && lcmRuntime) await lcmRuntime.reconcileSelectedSession();
    refreshCodePreviewSettings();
    applyFabricMode();
    if (!updateCheckStarted) {
      updateCheckStarted = true;
      void scheduleFabricUpdateCheck(context, {
        enabled: state.config.update.check,
        agentDir: resolveAgentDir(),
      });
    }
    if (state.shouldEagerlyActivate(context)) await state.ensure(context);
  });

  // Branch changes move the leaf: emitted echoes and spent reminder budget
  // must track it exactly. Rewind removes abandoned-branch residue.
  omp.on("session_tree", async (_event, context) => {
    proxyContract.reset();
    refreshProxyLedger(context);
    // OMP emits session_tree before it clears and rebuilds the transcript:
    // drop card invalidators from abandoned branches so a later display-mode
    // switch only refreshes cards registered by the rebuilt active branch.
    toolDisplay.clear();
    return undefined;
  });

  omp.on("input", async (event, context) => {
    if (!state.initialized) return;
    state.prewalk.observeTask(
      context.sessionManager.getSessionId(),
      event.text,
    );
    await state.publishHostLifecycle("omp.input", event);
  });

  omp.on("agent_start", async (event) => {
    if (state.initialized) await state.publishHostLifecycle("omp.agent_start", event);
  });

  omp.on("turn_end", async (event, context) => {
    // Speculation never crosses a turn boundary; registry.endInvocation already
    // dropped entries for completed fabric_exec runs, this catches turns where
    // the program never executed (type errors, aborts).
    if (state.initialized) state.resetSpeculation();
    if (state.initialized) await state.publishHostLifecycle("omp.turn_end", event);
    // A turn with new action evidence only enqueues the background compiler;
    // the hook returns without scanning session files or waiting on a lock.
    if (entropyEvidenceThisTurn) {
      entropyEvidenceThisTurn = false;
      scheduleEntropyCompile(context);
    }
  });

  omp.on("agent_end", async (event, context) => {
    if (event.willContinue === true) return;
    await lcmRuntime?.syncAndSchedule();
    if (!state.initialized) {
      await compactAtConfiguredThreshold(context, state.config);
      return;
    }
    const sessionId = context.sessionManager.getSessionId();
    const settledInPlace = await settleInPlacePrewalk(state.prewalk, omp, context, {
      compactOnReturn: state.config.prewalk.compactOnReturn,
      compact: state.compact,
    });
    if (!settledInPlace && state.prewalk.settleTask(sessionId)) {
      const status = state.prewalk.status();
      context.ui.setStatus(
        "fabric-prewalk",
        status.state === "armed" ? `armed → ${status.model}` : undefined,
      );
    }
    // Drift baselines track armed windows: re-anchor when still armed (a
    // re-arm starts each new window from the just-settled tree state), drop
    // once prewalk is no longer armed for this session.
    if (state.prewalk.status().state === "armed") {
      void state.prewalkDrift.captureBaseline(sessionId, context.cwd);
    } else {
      state.prewalkDrift.drop(sessionId);
    }
    // Keep the completed widget mounted until a newer Fabric run replaces it.
    // Removing rows at settle would pull the editor and latest chat content upward.
    // OMP's compact API is callback-based. Await the controller's Promise here
    // so ExtensionRunner does not finish this handler (and OMP does not publish
    // its public agent_end event) before compaction settles.
    await state.compact.maybeCommit(context);
    await compactAtConfiguredThreshold(context, state.config);
    await state.publishHostLifecycle("omp.agent_end", event);
  });

  const speculationWarmup = new FabricSpeculationWarmup({
    enabled: () => {
      try {
        return state.config.speculation.enabled === true;
      } catch {
        return false;
      }
    },
    tap: () => state.speculationTap,
    activate: (context) => state.ensure(context),
  });

  // Speculative PTC: follow fabric_exec argument streaming and pre-launch
  // literal-argument read calls so their latency hides behind generation.
  omp.on("message_start", () => {
    speculationWarmup.reset();
    state.speculationTap?.reset();
  });

  omp.on("message_update", (event, context) => {
    speculationWarmup.handleMessageUpdate(event, context);
  });

  omp.on("tool_call", (event, context) =>
    fabricToolLifecycle.toolCall(event, context));

  // The OMP host intentionally ignores `isError` returned by custom-tool
  // execute(). Repair the finalized outer result through official middleware.
  omp.on("tool_result", (event) => fabricToolLifecycle.toolResult(event));

  omp.on("tool_result", (event, context) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = expandSkillDirMarkersForRead(
        part.text,
        event.input,
        context.cwd,
      );
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  omp.on("message_end", () => {
    lcmRuntime?.markDirty();
  });

  omp.on("message_end", (event) => {
    if (event.message.role !== "toolResult") return;
    const message = event.message as AgentToolResultMessage & { usage?: Usage };
    const usage = directToolApproval.takeUsage(message.toolCallId);
    if (!usage) return;
    message.usage = mergeFabricApprovalUsage(message.usage, usage);
  });

  // message_end runs after all tool-result middleware and tool_execution_end but
  // before OMP persists the native toolResult or starts another model turn. That
  // is the complete outer fabric_exec boundary: fork the exact message, wait for
  // the child, then replace what Main sees while terminate prevents inference.
  omp.on("message_end", async (event, context) => {
    if (event.message.role !== "toolResult") return;
    const pending = pendingHandoffs.get(event.message.toolCallId);
    if (!pending || event.message.toolName !== "fabric_exec") return;
    pendingHandoffs.delete(event.message.toolCallId);

    const outerToolResult = event.message as AgentToolResultMessage;
    const handoff = await state.runHandoffAtBoundary(
      pending,
      outerToolResult,
      context,
    );
    Object.assign(outerToolResult, handoff);
  });

  omp.on("tool_execution_end", async (event, context) => {
    if (!state.initialized) return;
    if (event.toolName === "fabric_exec") entropyEvidenceThisTurn = true;
    state.noteMainActivity(context);
    if (event.isError) {
      const classified = classifyToolResult({
        toolName: event.toolName,
        isError: true,
        content: event.result,
      });
      const registryObserved =
        event.toolName === "fabric_exec" &&
        (classified?.stage === "invocation_args" ||
          classified?.stage === "invocation_unknown_action");
      if (classified && !registryObserved) {
        getActiveRepairCompiler()?.observe(classified);
      }
      state.dispatchHostEvent("tool_error", event, context);
      await state.publishHostLifecycle("omp.tool_error", event);
    }
  });

  omp.on("session_compact", async (event, context) => {
    await lcmRuntime?.syncAndSchedule();
    if (!state.initialized) return;
    await state.publishHostLifecycle("omp.session_compact", event);
  });

  // Deterministic, LLM-free compaction is registered unconditionally and is
  // active by default. The documented "omp" escape hatch returns early so
  // OMP's own summarization proceeds normally.
  registerCompactionHook(omp, {
    getEngine: () =>
      lcmLoader.unavailable
        ? "omp"
        : state.cwd
          ? state.config.compaction.engine
          : DEFAULT_FABRIC_CONFIG.compaction.engine,
    getTargetContextRatio: () =>
      state.cwd
        ? state.config.compaction.targetContextRatio
        : DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
    lcm: {
      compact: (input) => lcmRuntime?.compact(input),
    },
  });

  omp.on("context", (event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    const continuation = filterPrewalkContinuationMessages(
      event.messages,
      (continuationId) => state.initialized &&
        state.prewalk.acceptContinuation(sessionId, continuationId),
    );
    let changed = continuation.changed;
    const messages = continuation.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = expandSkillDirMarkersInSkillBlock(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== "text") return part;
        const text = expandSkillDirMarkersInSkillBlock(part.text);
        if (text === part.text) return part;
        changed = true;
        messageChanged = true;
        return { ...part, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    return changed ? { messages } : undefined;
  });

  omp.on("before_agent_start", async (event, context) => {
    const fullCodeMode = state.cwd
      ? state.config.fullCodeMode
      : DEFAULT_FABRIC_CONFIG.fullCodeMode;
    const schemaMode = state.cwd
      ? state.config.schema.mode
      : DEFAULT_FABRIC_CONFIG.schema.mode;
    reassertToolOwnership();
    const effectiveFullCodeMode = fullCodeMode || schemaMode === "enforce";
    if (!omp.getActiveTools().includes("fabric_exec")) return;
    const skills = activeSkills();
    const captureSnapshot = state.cwd ? capturePolicy() : undefined;
    const systemPrompt = effectiveFullCodeMode
      ? restoreSkillsForFullCodePrompt(
        event.systemPrompt.join("\n"),
        listableSkills(skills),
      )
      : event.systemPrompt.join("\n");
    // OMP expands the invoked skill into the user message, but wrappers may
    // delegate by name. Resolve only explicit invocation lines so full code
    // mode preserves OMP's progressive skill loading without exposing read.
    // Turn-derived: delivered via the message channel (below), never the
    // system prompt, so the cached system prefix stays byte-stable.
    const skillReferenceGuidance = effectiveFullCodeMode
      ? buildSkillReferenceGuidance(event.prompt, skills)
      : undefined;
    const currentModel = context.model
      ? `${context.model.provider}/${context.model.id}`
      : undefined;
    const resolvedGuidance = resolveFabricModelGuidance(state.modelGuidance(), {
      ...(currentModel ? { model: currentModel } : {}),
      target: process.env.OMP_FABRIC_PARENT_RUN ? "participant" : "main",
      defaults: [{
        slot: FABRIC_EXECUTION_GUIDANCE_SLOT,
        content: defaultFabricExecutionGuidance(effectiveFullCodeMode),
      }],
    });
    const overrideGuidance = effectiveFullCodeMode
      ? coreOverridePromptGuidance(capturedTools).trim()
      : undefined;
    const extensionRoster = effectiveFullCodeMode
      ? extensionToolRosterGuidance(capturedTools.list(), new Set(OMP_CORE_TOOL_NAMES))
      : undefined;
    // Only turn-stable sections go into the system prompt. Anything derived
    // from the current prompt (skill references) rides
    // the message channel so provider prefix caches never cold-prefill.
    const guidance = [
      fabricExecutionKernelGuidance(effectiveFullCodeMode),
      resolvedGuidance.slotText,
      fabricSchemaGuidance(schemaMode),
      overrideGuidance,
      extensionRoster,
      resolvedGuidance.appendText,
    ].filter((section): section is string => Boolean(section)).join("\n\n");
    // Turn-varying content (skill reference guidance) is delivered here as a
    // persistent message, not appended to the system prompt. Keeping the
    // system prompt byte-identical across turns is what lets provider prefix
    // caches (e.g. DeepSeek) stay warm.
    if (!skillReferenceGuidance) return {
      systemPrompt: [`${systemPrompt}\n\n${guidance}`],
    };
    return {
      systemPrompt: [`${systemPrompt}\n\n${guidance}`],
      message: {
        customType: SKILL_REFERENCE_CUSTOM_TYPE,
        content: skillReferenceGuidance,
        display: false,
        details: {},
      },
    };
  });

  // Ambient skill prose that names hidden captured tools is not user intent,
  // so the furnace strips it. This sidecar retargets the call site without
  // spending hint budget, echoing tokens, or burning ash.
  omp.on("before_agent_start", (event) => {
    if (!omp.getActiveTools().includes("fabric_exec")) return;
    const captureSnapshot = state.cwd ? capturePolicy() : undefined;
    if (
      !captureSnapshot?.enabled ||
      !captureSnapshot.hideFromModel ||
      !fabricOwnsModelTools()
    ) {
      return;
    }
    const names = rewritableHiddenCapturedToolNames(hiddenCapturedToolNames());
    if (names.length === 0) return;
    const mentioned = proxyContractMentionsInSkills(
      event.prompt,
      event.systemPrompt.join("\n"),
      names,
    );
    const fresh = proxyContract.take(mentioned);
    if (fresh.length === 0) return;
    return {
      message: {
        customType: PROXY_CONTRACT_CUSTOM_TYPE,
        content: formatProxyContractReminder(fresh),
        display: false,
        details: { names: fresh, origin: "skill" },
      },
    };
  });

  registerFabricActorHostEventObservers(omp, (eventName, event, context) => {
    if (!state.initialized) return;
    state.dispatchHostEvent(eventName, event, context);
  });

  omp.on("session_shutdown", async (_event, context) => {
    // Queue the richest final window and let async I/O/cooperative scoring
    // finish before teardown; the TUI event loop remains responsive.
    if (entropyEvidenceThisTurn) {
      entropyEvidenceThisTurn = false;
      scheduleEntropyCompile(context, 0);
    }
    await settleEntropyCompiles();
    entropyLifecycleEpoch += 1;
    entropyCompilePending = undefined;
    unsubscribeComponentRegistration();
    unsubscribeProviderRegistration();
    pendingHandoffs.clear();
    directToolApproval.clear();
    toolDisplay.clear();
    try {
      await lcmRuntime?.shutdown();
      lcmRuntime = undefined;
      lcmCwd = undefined;
      lcmProjectKey = undefined;
      await state.shutdown();
    } finally {
      uninstallHaltOnEscape();
      fabricUi.stop();
      suspendToolCapture();
      toolOwnership.release();
      fabricToolLifecycle.clear();
      toolCapture.dispose();
    }
  });

  // Turn-scoped invariant: even if another extension rewrote the active tool
  // set (e.g. a permission system filtering its allowlist at before_agent_start,
  // or a refresh that ran before Fabric's policy was active), captured tools
  // must not leak into the model's next turn.
  omp.on("before_agent_start", () => {
    reassertToolOwnership();
  });

  registerFabricCommand(omp, {
    state,
    fabricUi,
    capturedTools,
    applyFabricMode,
    suspendToolCapture,
    refreshCodePreviewSettings,
    refreshToolDisplay: () => toolDisplay.refresh(),
  });
}

export * from "./audit/index.js";
export * from "./entropy/index.js";
export * from "./protocol.js";
