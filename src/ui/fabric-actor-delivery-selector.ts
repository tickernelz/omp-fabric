import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { FabricActorDeliveryPolicy } from "../actors/delivery-policy.js";
import { BlankRows, Stack, TextBlock } from "./tui/rows.js";
import { type SelectItem, type SelectListLayout, SelectList } from "./tui/select-list.js";
import type { FabricView } from "./tui/view.js";

const LAYOUT: SelectListLayout = {
  minPrimaryColumnWidth: 18,
  maxPrimaryColumnWidth: 34,
};

const POLICIES: Array<FabricActorDeliveryPolicy & { value: string; label: string; description: string }> = [
  { value: "mailbox", label: "Mailbox only", description: "keep output in actor history", delivery: "mailbox", triggerTurn: false },
  { value: "steer-passive", label: "Steer · passive", description: "deliver now without starting idle Main", delivery: "steer", triggerTurn: false },
  { value: "steer-active", label: "Steer · resume Main", description: "deliver now and start Main when idle", delivery: "steer", triggerTurn: true },
  { value: "followUp-passive", label: "Follow-up · passive", description: "deliver after the run without starting idle Main", delivery: "followUp", triggerTurn: false },
  { value: "followUp-active", label: "Follow-up · resume Main", description: "deliver after the run and start Main when idle", delivery: "followUp", triggerTurn: true },
  { value: "next-turn", label: "Next user turn", description: "defer until the next user prompt", delivery: "nextTurn", triggerTurn: false },
];

export interface FabricActorDeliverySelectorOptions {
  theme: Theme;
  currentValue: FabricActorDeliveryPolicy;
  onSelect: (policy: FabricActorDeliveryPolicy) => void;
  onCancel: () => void;
  headerText?: string;
}

export class FabricActorDeliverySelector extends Stack implements FabricView {
  private readonly selectList: SelectList;

  constructor(options: FabricActorDeliverySelectorOptions) {
    super();
    const current = POLICIES.find(
      (policy) =>
        policy.delivery === options.currentValue.delivery &&
        policy.triggerTurn === options.currentValue.triggerTurn,
    )?.value;
    const items: SelectItem[] = POLICIES.map((policy) => ({
      value: policy.value,
      label: `${policy.label}${policy.value === current ? " ✓" : ""}`,
      description: policy.description,
    }));
    this.add(
      new TextBlock(
        options.theme.fg(
          "muted",
          options.headerText ?? "Choose how actor output enters Main and whether it starts a turn.",
        ),
      ),
    );
    this.add(new BlankRows(1));
    this.selectList = new SelectList(items, items.length, options.theme, LAYOUT);
    const startIndex = items.findIndex((item) => item.value === current);
    if (startIndex >= 0) this.selectList.setSelectedIndex(startIndex);
    this.selectList.onSelect = (item) => {
      const policy = POLICIES.find((candidate) => candidate.value === item.value);
      if (policy) options.onSelect({ delivery: policy.delivery, triggerTurn: policy.triggerTurn });
    };
    this.selectList.onCancel = options.onCancel;
    this.add(this.selectList);
    this.add(new BlankRows(1));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
