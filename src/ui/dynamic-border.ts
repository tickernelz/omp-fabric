// Local mirror of the host's DynamicBorder component (OMP host). Fabric only
// constructs it with an explicit color function, so the host's global-theme
// default (unreliable across module realms) is replaced with a pass-through
// fallback that guards the no-color case.

export type DynamicBorderColor = (text: string) => string;

export class DynamicBorder {
  readonly #color: DynamicBorderColor;

  constructor(color: DynamicBorderColor = (str: string) => str) {
    this.#color = color;
  }

  invalidate(): void {
    // No cached state to invalidate.
  }

  render(width: number): string[] {
    return [this.#color("─".repeat(Math.max(1, width)))];
  }
}
