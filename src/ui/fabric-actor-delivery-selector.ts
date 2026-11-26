import { getKeybindings, type Theme } from "@oh-my-pi/pi-coding-agent";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { FabricActorDeliveryPolicy } from "../actors/delivery-policy.js";
import { keyEvents } from "./keys.js";
import type { FabricRows } from "./render-types.js";

const MIN_PRIMARY_COLUMN_WIDTH = 18;
const MAX_PRIMARY_COLUMN_WIDTH = 34;

const POLICIES: Array<FabricActorDeliveryPolicy & { value: string; label: string; description: string }> = [
  { value: "mailbox", label: "Mailbox only", description: "keep output in actor history", delivery: "mailbox", triggerTurn: false },
  { value: "steer-passive", label: "Steer · passive", description: "deliver now without starting idle Main", delivery: "steer", triggerTurn: false },
  { value: "steer-active", label: "Steer · resume Main", description: "deliver now and start Main when idle", delivery: "steer", triggerTurn: true },
  { value: "followUp-passive", label: "Follow-up · passive", description: "deliver after the run without starting idle Main", delivery: "followUp", triggerTurn: false },
  { value: "followUp-active", label: "Follow-up · resume Main", description: "deliver after the run and start Main when idle", delivery: "followUp", triggerTurn: true },
  { value: "next-turn", label: "Next user turn", description: "defer until the next user prompt", delivery: "nextTurn", triggerTurn: false },
];

interface DeliveryItem {
  value: string;
  label: string;
  description: string;
  policy: FabricActorDeliveryPolicy;
}

export interface FabricActorDeliverySelectorOptions {
  theme: Theme;
  currentValue: FabricActorDeliveryPolicy;
  onSelect: (policy: FabricActorDeliveryPolicy) => void;
  onCancel: () => void;
  headerText?: string;
}

export class FabricActorDeliverySelector implements FabricRows {
  private readonly theme: Theme;
  private readonly items: DeliveryItem[];
  private readonly primaryWidth: number;
  private readonly headerText: string;
  private readonly onSelectCallback: (policy: FabricActorDeliveryPolicy) => void;
  private readonly onCancelCallback: () => void;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricActorDeliverySelectorOptions) {
    this.theme = options.theme;
    this.headerText =
      options.headerText ?? "Choose how actor output enters Main and whether it starts a turn.";
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    const current = POLICIES.find(
      (policy) =>
        policy.delivery === options.currentValue.delivery &&
        policy.triggerTurn === options.currentValue.triggerTurn,
    )?.value;
    this.items = POLICIES.map((policy) => ({
      value: policy.value,
      label: `${policy.label}${policy.value === current ? " ✓" : ""}`,
      description: policy.description,
      policy: { delivery: policy.delivery, triggerTurn: policy.triggerTurn },
    }));
    const startIndex = this.items.findIndex((item) => item.value === current);
    this.selectedIndex = startIndex >= 0 ? startIndex : 0;
    const longest = Math.max(...this.items.map((item) => visibleWidth(item.label)));
    this.primaryWidth = Math.min(
      MAX_PRIMARY_COLUMN_WIDTH,
      Math.max(MIN_PRIMARY_COLUMN_WIDTH, longest),
    );
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    for (const event of keyEvents(data)) {
      if (event.kind === "release") continue;
      if (kb.matches(event, "tui.select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(event, "tui.select.down")) {
        this.selectedIndex =
          this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (kb.matches(event, "tui.select.confirm")) {
        const item = this.items[this.selectedIndex];
        if (item) this.onSelectCallback(item.policy);
      } else if (kb.matches(event, "tui.select.cancel")) {
        this.onCancelCallback();
      }
    }
  }

  render(width: number): string[] {
    const rows = [truncate(this.theme.fg("muted", this.headerText), width, ""), ""];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const selected = index === this.selectedIndex;
      const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      const padding = " ".repeat(Math.max(0, this.primaryWidth - visibleWidth(item.label)));
      const description = item.description
        ? ` ${this.theme.fg("muted", item.description)}`
        : "";
      rows.push(truncate(`${marker}${label}${padding}${description}`, width, ""));
    }
    rows.push("");
    return rows;
  }
}
