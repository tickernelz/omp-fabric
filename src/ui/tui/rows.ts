import { padTo, replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Rows } from "./view.js";

export class TextBlock implements Rows {
  constructor(
    private text = "",
    private readonly paddingX = 0,
    private readonly paddingY = 0,
  ) {}

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    if (this.text.trim() === "") return [];
    const margin = " ".repeat(this.paddingX);
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const content = replaceTabs(this.text)
      .split("\n")
      .flatMap((line) => (line === "" ? [""] : wrap(line, contentWidth)))
      .map((line) => padTo(`${margin}${line}${margin}`, width));
    const blank = Array.from({ length: this.paddingY }, () => " ".repeat(Math.max(0, width)));
    return [...blank, ...content, ...blank];
  }
}

export class BlankRows implements Rows {
  constructor(private readonly count = 1) {}

  render(): string[] {
    return Array.from({ length: this.count }, () => "");
  }
}

export class Stack implements Rows {
  readonly children: Rows[] = [];

  add(child: Rows): void {
    this.children.push(child);
  }

  remove(child: Rows): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  clear(): void {
    this.children.length = 0;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => [...child.render(width)]);
  }
}
