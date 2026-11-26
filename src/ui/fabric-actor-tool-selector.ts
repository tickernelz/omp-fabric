import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { keyEvents } from "./keys.js";
import type { FabricRows } from "./render-types.js";

const ACTOR_TOOL_ORDER = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

const TOOL_LABELS: Record<(typeof ACTOR_TOOL_ORDER)[number], string> = {
  read: "read files",
  grep: "search file contents",
  find: "find files by name",
  ls: "list directories",
  bash: "execute shell commands",
  edit: "edit existing files",
  write: "write files",
};

export interface FabricActorToolSelectorOptions {
  theme: Theme;
  currentValue: string[];
  onSelect: (tools: string[]) => void;
  onCancel: () => void;
  headerText?: string;
}

export class FabricActorToolSelector implements FabricRows {
  private readonly theme: Theme;
  private readonly onSelectCallback: (tools: string[]) => void;
  private readonly onCancelCallback: () => void;
  private readonly headerText: string;
  private enabled: Set<string>;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricActorToolSelectorOptions) {
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.headerText =
      options.headerText ?? "Select the optional tools available to this actor.";
    this.enabled = new Set(options.currentValue);
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    for (const event of keyEvents(keyData)) {
      if (event.kind === "release") continue;
      if (kb.matches(event, "tui.select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? ACTOR_TOOL_ORDER.length - 1 : this.selectedIndex - 1;
      } else if (kb.matches(event, "tui.select.down")) {
        this.selectedIndex =
          this.selectedIndex === ACTOR_TOOL_ORDER.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (event.id === "space" || event.text === " ") {
        const tool = ACTOR_TOOL_ORDER[this.selectedIndex];
        if (tool) {
          if (this.enabled.has(tool)) this.enabled.delete(tool);
          else this.enabled.add(tool);
        }
      } else if (kb.matches(event, "tui.select.confirm")) {
        const selected = ACTOR_TOOL_ORDER.filter((tool) => this.enabled.has(tool));
        const custom = [...this.enabled].filter(
          (tool) => !ACTOR_TOOL_ORDER.includes(tool as (typeof ACTOR_TOOL_ORDER)[number]),
        );
        this.onSelectCallback([...selected, ...custom]);
      } else if (kb.matches(event, "tui.select.cancel")) {
        this.onCancelCallback();
      }
    }
  }

  render(width: number): string[] {
    const rows = [truncate(this.theme.fg("muted", this.headerText), width, ""), ""];
    for (let index = 0; index < ACTOR_TOOL_ORDER.length; index++) {
      const tool = ACTOR_TOOL_ORDER[index]!;
      const selected = index === this.selectedIndex;
      const checked = this.enabled.has(tool);
      const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = `${box} ${tool} · ${this.theme.fg("muted", TOOL_LABELS[tool])}`;
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", label)}`
        : `  ${label}`;
      rows.push(truncate(line, width, ""));
    }
    rows.push("");
    rows.push(
      truncate(this.theme.fg("muted", "  space toggle · enter apply · esc cancel"), width, ""),
    );
    return rows;
  }
}
