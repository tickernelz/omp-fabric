import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { FABRIC_ACTOR_HOST_EVENTS } from "../actors/types.js";
import type { FabricActorHostEvent } from "../actors/types.js";
import { keyEvents } from "./keys.js";
import type { FabricRows } from "./render-types.js";

const COMMON_HOST_EVENTS: readonly FabricActorHostEvent[] = [
  "input",
  "turn_end",
  "agent_end",
  "tool_error",
  "session_compact",
];
const commonHostEvents = new Set<FabricActorHostEvent>(COMMON_HOST_EVENTS);
const MAX_VISIBLE_HOST_EVENTS = 12;
const HOST_EVENT_ORDER: readonly FabricActorHostEvent[] = [
  ...COMMON_HOST_EVENTS,
  ...FABRIC_ACTOR_HOST_EVENTS.filter((event) => !commonHostEvents.has(event)),
];

const EVENT_LABELS: Partial<Record<FabricActorHostEvent, string>> = {
  input: "raw user or extension input",
  turn_end: "each completed LLM turn",
  agent_end: "a low-level agent run ended",
  tool_error: "synthetic notification for a failed tool",
  session_compact: "context was compacted",
  resources_discover: "skills, prompts, and themes are discovered",
  session_start: "a session starts, reloads, or is restored",
  session_switch: "the active session changed",
  session_before_switch: "before a new or resumed session replaces this one",
  session_before_branch: "before a session branch",
  session_branch: "after a session branch",
  session_before_compact: "before context compaction",
  "session.compacting": "context compaction is being prepared",
  session_shutdown: "before this session runtime shuts down",
  session_before_tree: "before session-tree navigation",
  session_tree: "after session-tree navigation",
  goal_updated: "the active goal changed",
  before_agent_start: "expanded prompt and system context before the agent loop",
  agent_start: "a low-level agent run started",
  session_stop: "the main session is settling",
  turn_start: "an LLM turn started",
  message_start: "a user, assistant, or tool message started",
  message_update: "an assistant streaming update",
  message_end: "a user, assistant, or tool message completed",
  context: "assembled messages before an LLM request",
  before_provider_request: "provider payload assembled before sending",
  after_provider_response: "provider response received",
  tool_execution_start: "tool execution started",
  tool_call: "validated tool call before execution",
  tool_execution_update: "streaming tool progress",
  tool_result: "final tool result before message persistence",
  tool_execution_end: "tool execution completed",
  user_bash: "a user ! or !! shell command was submitted",
};

export interface FabricHostEventSelectorOptions {
  theme: Theme;
  /** Currently enabled host events for the actor. */
  currentValue: FabricActorHostEvent[];
  onSelect: (events: FabricActorHostEvent[]) => void;
  onCancel: () => void;
  headerText?: string;
}

/**
 * A compact multi-select picker for an actor's host-event subscriptions. The
 * supported host events are shown with a [x]/[ ] checkbox; space toggles the
 * row under the cursor, Enter applies the selection, and Esc cancels.
 */
export class FabricHostEventSelector implements FabricRows {
  private readonly theme: Theme;
  private readonly onSelectCallback: (events: FabricActorHostEvent[]) => void;
  private readonly onCancelCallback: () => void;
  private readonly headerText: string;
  private enabled: Set<FabricActorHostEvent>;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricHostEventSelectorOptions) {
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.headerText = options.headerText ?? "Toggle the host events this actor subscribes to.";
    this.enabled = new Set(options.currentValue);
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    for (const event of keyEvents(keyData)) {
      if (event.kind === "release") continue;
      if (kb.matches(event, "tui.select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? HOST_EVENT_ORDER.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(event, "tui.select.down")) {
        this.selectedIndex =
          this.selectedIndex === HOST_EVENT_ORDER.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (event.id === "space" || event.text === " ") {
        const hostEvent = HOST_EVENT_ORDER[this.selectedIndex];
        if (hostEvent) {
          if (this.enabled.has(hostEvent)) this.enabled.delete(hostEvent);
          else this.enabled.add(hostEvent);
        }
      } else if (kb.matches(event, "tui.select.confirm")) {
        this.onSelectCallback(HOST_EVENT_ORDER.filter((hostEvent) => this.enabled.has(hostEvent)));
      } else if (kb.matches(event, "tui.select.cancel")) {
        this.onCancelCallback();
      }
    }
  }

  render(width: number): string[] {
    const rows = [truncate(this.theme.fg("muted", this.headerText), width, ""), ""];
    const total = HOST_EVENT_ORDER.length;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE_HOST_EVENTS / 2),
        total - MAX_VISIBLE_HOST_EVENTS,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE_HOST_EVENTS, total);
    if (startIndex > 0) {
      rows.push(truncate(this.theme.fg("dim", `  ↑ ${startIndex} earlier events`), width, ""));
    }
    for (let index = startIndex; index < endIndex; index++) {
      const hostEvent = HOST_EVENT_ORDER[index]!;
      const selected = index === this.selectedIndex;
      const checked = this.enabled.has(hostEvent);
      const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = `${box} ${hostEvent} · ${this.theme.fg("muted", EVENT_LABELS[hostEvent] ?? hostEvent)}`;
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", label)}`
        : `  ${label}`;
      rows.push(truncate(line, width, ""));
    }
    if (endIndex < total) {
      rows.push(
        truncate(this.theme.fg("dim", `  ↓ ${total - endIndex} later events`), width, ""),
      );
    }
    rows.push("");
    rows.push(
      truncate(this.theme.fg("muted", "  space toggle · enter apply · esc cancel"), width, ""),
    );
    return rows;
  }
}
