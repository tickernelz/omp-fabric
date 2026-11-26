import type { ExtensionRows, ExtensionTheme } from "@oh-my-pi/pi-coding-agent";

export type FabricRows = ExtensionRows & { invalidate?(): void };
export type FabricTheme = ExtensionTheme;
