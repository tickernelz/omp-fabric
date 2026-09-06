import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { Container, type Focusable, getKeybindings, Spacer, Text } from "@oh-my-pi/pi-tui";

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

export class FabricActorToolSelector extends Container implements Focusable {
  private readonly theme: Theme;
  private readonly onSelectCallback: (tools: string[]) => void;
  private readonly onCancelCallback: () => void;
  private readonly listContainer = new Container();
  private enabled: Set<string>;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricActorToolSelectorOptions) {
    super();
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.enabled = new Set(options.currentValue);
    this.addChild(
      new Text(
        this.theme.fg("muted", options.headerText ?? "Select the optional tools available to this actor."),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.updateList();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? ACTOR_TOOL_ORDER.length - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === ACTOR_TOOL_ORDER.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (keyData === " ") {
      const tool = ACTOR_TOOL_ORDER[this.selectedIndex];
      if (tool) {
        if (this.enabled.has(tool)) this.enabled.delete(tool);
        else this.enabled.add(tool);
        this.updateList();
      }
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = ACTOR_TOOL_ORDER.filter((tool) => this.enabled.has(tool));
      const custom = [...this.enabled].filter(
        (tool) => !ACTOR_TOOL_ORDER.includes(tool as (typeof ACTOR_TOOL_ORDER)[number]),
      );
      this.onSelectCallback([...selected, ...custom]);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCallback();
    }
  }

  private updateList(): void {
    this.listContainer.clear();
    for (let index = 0; index < ACTOR_TOOL_ORDER.length; index++) {
      const tool = ACTOR_TOOL_ORDER[index]!;
      const selected = index === this.selectedIndex;
      const checked = this.enabled.has(tool);
      const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = `${box} ${tool} · ${this.theme.fg("muted", TOOL_LABELS[tool])}`;
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", label)}`
        : `  ${label}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(
      new Text(this.theme.fg("muted", "  space toggle · enter apply · esc cancel"), 0, 0),
    );
  }
}
