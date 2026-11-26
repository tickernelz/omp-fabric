import type { ExtensionContext, KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import { DynamicBorder } from "../ui/dynamic-border.js";
import type { FabricRows, FabricTheme } from "../ui/render-types.js";
import { keyEvents } from "../ui/keys.js";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { FabricTraceSafeError } from "../audit/trace.js";
import type { FabricApprovalConfig } from "../config.js";
import type { FabricRisk } from "../protocol.js";
import type { ResolvedFabricAction } from "./action-registry.js";
import {
  FabricAutoApprovalClassifier,
  type FabricAutoApprovalDecision,
} from "./auto-approval-classifier.js";

type InvalidatableRows = FabricRows & { invalidate?(): void };

const textRow = (text: string, indent = 0): FabricRows => ({
  render: () => [`${" ".repeat(indent)}${text}`],
});

const spacerRow = (): FabricRows => ({ render: () => [""] });

const inheritedRisks = (): FabricRisk[] => {
  const allowed = new Set<FabricRisk>(["read", "write", "execute", "network", "agent"]);
  return (process.env.OMP_FABRIC_GRANTED_RISKS ?? "")
    .split(",")
    .filter((risk): risk is FabricRisk => allowed.has(risk as FabricRisk));
};

type ApprovalChoice = "allow-once" | "allow-session" | "deny";

const onceLabel = "Allow once";
const sessionLabel = (risk: FabricRisk): string =>
  `Allow ${risk} access for this session`;

interface ApprovalItem {
  value: ApprovalChoice;
  label: string;
  description: string;
}

class ApprovalChoiceList implements FabricRows {
  private selectedIndex = 0;

  constructor(
    private readonly items: ApprovalItem[],
    private readonly theme: FabricTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (choice: ApprovalChoice) => void,
  ) {}

  render(width: number): string[] {
    return this.items.map((item, index) => {
      const selected = index === this.selectedIndex;
      const marker = selected ? this.theme.fg("accent", "› ") : "  ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      return truncate(
        `${marker}${label} ${this.theme.fg("muted", item.description)}`,
        width,
        "",
      );
    });
  }

  handleInput(data: string): void {
    for (const event of keyEvents(data)) {
      if (event.kind === "release") continue;
      if (this.keybindings.matches(event, "tui.select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      } else if (this.keybindings.matches(event, "tui.select.down")) {
        this.selectedIndex =
          this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (this.keybindings.matches(event, "tui.select.confirm")) {
        const item = this.items[this.selectedIndex];
        if (item) this.done(item.value);
      } else if (this.keybindings.matches(event, "tui.select.cancel")) {
        this.done("deny");
      }
    }
  }
}

export class FabricSessionApprovals {
  readonly approvedRisks = new Set<FabricRisk>();
  #tail: Promise<void> = Promise.resolve();

  async serialize<T>(request: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await request();
    } finally {
      release?.();
    }
  }
}

export interface FabricAutoApprovalAudit {
  action: string;
  risk: FabricRisk;
  decision: "allow" | "escalate";
  reason: string;
  model?: string;
  error?: string;
  at: number;
}

export class ApprovalController {
  readonly #inheritedRisks = new Set<FabricRisk>(inheritedRisks());

  constructor(
    readonly config: FabricApprovalConfig,
    readonly context: ExtensionContext,
    readonly sessionApprovals = new FabricSessionApprovals(),
    readonly classifier = new FabricAutoApprovalClassifier(),
    readonly onAutoDecision?: (
      audit: FabricAutoApprovalAudit,
      decision?: FabricAutoApprovalDecision,
    ) => void,
  ) {}

  async approve(
    action: ResolvedFabricAction,
    args: Record<string, unknown> = {},
  ): Promise<void> {
    const mode = this.config[action.risk];
    if (
      mode === "allow" ||
      this.#inheritedRisks.has(action.risk) ||
      this.sessionApprovals.approvedRisks.has(action.risk)
    ) return;
    if (mode === "deny") {
      throw new FabricTraceSafeError(`${action.ref} is denied by the Fabric ${action.risk} policy`);
    }

    await this.sessionApprovals.serialize(async () => {
      if (this.sessionApprovals.approvedRisks.has(action.risk)) return;
      if (mode !== "auto") {
        await this.#requestApproval(action);
        return;
      }

      let decision: FabricAutoApprovalDecision;
      try {
        decision = await this.classifier.classify(
          action,
          args,
          this.context,
          this.config.model,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.onAutoDecision?.({
          action: action.ref,
          risk: action.risk,
          decision: "escalate",
          reason: "Classifier unavailable; explicit approval required",
          error: message,
          at: Date.now(),
        });
        await this.#requestApproval(
          action,
          `Auto mode could not determine safety: ${message}`,
        );
        return;
      }
      this.onAutoDecision?.({
        action: action.ref,
        risk: action.risk,
        decision: decision.decision,
        reason: decision.reason,
        model: decision.model,
        at: Date.now(),
      }, decision);
      if (decision.decision === "allow") return;
      await this.#requestApproval(
        action,
        `Auto mode escalated (${decision.model}): ${decision.reason}`,
      );
    });
  }

  async #requestApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
  ): Promise<void> {
    if (!this.context.hasUI) {
      throw new FabricTraceSafeError(`${action.ref} requires approval, but no interactive UI is available`);
    }

    const notification = escalationReason
      ? `Fabric auto mode needs approval: ${action.ref} · ${escalationReason}`
      : `Fabric permission requested: ${action.ref} needs ${action.risk} access`;
    this.context.ui.notify(notification, "warning");
    const choice = this.context.mode === "tui"
      ? await this.#requestTuiApproval(action, escalationReason)
      : await this.#requestDialogApproval(action, escalationReason);

    if (choice === "deny") {
      this.context.ui.notify(`Denied ${action.risk} access for ${action.ref}`, "warning");
      throw new FabricTraceSafeError(`User denied ${action.risk} access for ${action.ref}`);
    }
    if (choice === "allow-session") {
      this.sessionApprovals.approvedRisks.add(action.risk);
      this.context.ui.notify(
        `Allowed ${action.risk} access for this OMP session`,
        "info",
      );
      return;
    }
    this.context.ui.notify(`Allowed once: ${action.ref}`, "info");
  }

  async #requestDialogApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
  ): Promise<ApprovalChoice> {
    const session = sessionLabel(action.risk);
    const picked = await this.context.ui.select(
      [
        `OMP Fabric permission · ${action.ref} requests ${action.risk} access. ${action.description}`,
        escalationReason,
      ].filter(Boolean).join(" · "),
      [onceLabel, session, "Deny"],
    );
    if (picked === onceLabel) return "allow-once";
    if (picked === session) return "allow-session";
    return "deny";
  }

  async #requestTuiApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
  ): Promise<ApprovalChoice> {
    const choice = await this.context.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
      const children: InvalidatableRows[] = [];
      children.push(new DynamicBorder((text: string) => theme.fg("warning", text)));
      children.push(spacerRow());
      children.push(
        textRow(theme.fg("warning", theme.style("strong", "🛡  OMP Fabric permission request")), 1),
      );
      children.push(spacerRow());
      children.push(
        textRow(
          theme.fg("text", `${action.ref} requests ${action.risk} access.`),
          1,
        ),
      );
      children.push(textRow(theme.fg("muted", action.description), 1));
      if (escalationReason) {
        children.push(spacerRow());
        children.push(
          textRow(theme.fg("warning", escalationReason), 1),
        );
      }
      children.push(spacerRow());
      children.push(
        textRow(
          theme.fg("dim", "Choose whether to allow only this call or this risk class for the session."),
          1,
        ),
      );
      children.push(spacerRow());
      const items: ApprovalItem[] = [
        {
          value: "allow-once",
          label: onceLabel,
          description: "Run only this requested action",
        },
        {
          value: "allow-session",
          label: sessionLabel(action.risk),
          description: "Do not ask again for this risk class until the OMP session ends",
        },
        {
          value: "deny",
          label: "Deny",
          description: "Block the requested action",
        },
      ];
      const list = new ApprovalChoiceList(items, theme, _keybindings, done);
      children.push(list);
      children.push(spacerRow());
      children.push(
        textRow(theme.fg("dim", "↑↓ navigate · enter select · esc deny"), 1),
      );
      children.push(spacerRow());
      children.push(new DynamicBorder((text: string) => theme.fg("warning", text)));
      const view: FabricRows & { invalidate?(): void } = {
        render: (width: number) => children.flatMap((child) => [...child.render(width)]),
        invalidate: () => {
          for (const child of children) child.invalidate?.();
        },
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
      return view;
    });
    return choice ?? "deny";
  }
}
