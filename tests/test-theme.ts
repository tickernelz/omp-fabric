import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";

type ThemeOverrides = Partial<Theme> & { bold?: (text: string) => string };

export const testTheme = (overrides: ThemeOverrides = {}): ExtensionTheme => {
  const { bold, ...rest } = overrides;
  const plain = (text: string): string => text;
  return {
    ...PLAIN_THEME,
    ...(bold
      ? { style: (tokens: string | undefined, text: string) => (tokens?.split(" ").includes("strong") ? bold(text) : PLAIN_THEME.style(tokens, text)) }
      : {}),
    ...rest,
    bold: bold ?? plain,
    italic: plain,
    underline: plain,
    strikethrough: plain,
    inverse: plain,
  };
};
