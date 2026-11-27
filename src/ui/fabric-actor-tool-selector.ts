import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { decodeTerminalInput, keyMatches } from "./tui/input.js";
import { TextBlock } from "./tui/rows.js";
import type { FabricView } from "./tui/view.js";

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

export class FabricActorToolSelector implements FabricView {
  private readonly theme: Theme;
  private readonly onSelectCallback: (tools: string[]) => void;
  private readonly onCancelCallback: () => void;
  private readonly header: TextBlock;
  private enabled: Set<string>;
  private selectedIndex = 0;

  constructor(options: FabricActorToolSelectorOptions) {
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.enabled = new Set(options.currentValue);
    this.header = new TextBlock(
      this.theme.fg("muted", options.headerText ?? "Select the optional tools available to this actor."),
    );
  }

  handleInput(keyData: string): void {
    for (const event of decodeTerminalInput(keyData)) {
      if (event.type !== "key") continue;
      const key = event.key;
      if (keyMatches(key, "select.up")) {
        this.selectedIndex =
          this.selectedIndex === 0 ? ACTOR_TOOL_ORDER.length - 1 : this.selectedIndex - 1;
      } else if (keyMatches(key, "select.down")) {
        this.selectedIndex =
          this.selectedIndex === ACTOR_TOOL_ORDER.length - 1 ? 0 : this.selectedIndex + 1;
      } else if (key.id === "space") {
        const tool = ACTOR_TOOL_ORDER[this.selectedIndex];
        if (tool) {
          if (this.enabled.has(tool)) this.enabled.delete(tool);
          else this.enabled.add(tool);
        }
      } else if (keyMatches(key, "select.confirm")) {
        const selected = ACTOR_TOOL_ORDER.filter((tool) => this.enabled.has(tool));
        const custom = [...this.enabled].filter(
          (tool) => !ACTOR_TOOL_ORDER.includes(tool as (typeof ACTOR_TOOL_ORDER)[number]),
        );
        this.onSelectCallback([...selected, ...custom]);
      } else if (keyMatches(key, "select.cancel")) {
        this.onCancelCallback();
      }
    }
  }

  render(width: number): string[] {
    const rows = [...this.header.render(width), ""];
    for (let index = 0; index < ACTOR_TOOL_ORDER.length; index++) {
      const tool = ACTOR_TOOL_ORDER[index]!;
      const selected = index === this.selectedIndex;
      const checked = this.enabled.has(tool);
      const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = `${box} ${tool} · ${this.theme.fg("muted", TOOL_LABELS[tool])}`;
      rows.push(...new TextBlock(selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", label)}`
        : `  ${label}`).render(width));
    }
    rows.push("", ...new TextBlock(this.theme.fg("muted", "  space toggle · enter apply · esc cancel")).render(width), "");
    return rows;
  }
}
