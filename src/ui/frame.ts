import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { padToWidth, safeText } from "./format.js";

export const topBorder = (theme: Theme, width: number, title: string): string => {
  const border = (value: string): string => theme.fg("borderMuted", value);
  const safeTitle = truncateToWidth(safeText(title), Math.max(0, width - 6));
  const styledTitle = ` ${theme.fg("accent", safeTitle)} `;
  const remaining = Math.max(0, width - 2 - visibleWidth(styledTitle));
  const left = Math.floor(remaining / 2);
  return `${border(`╭${"─".repeat(left)}`)}${styledTitle}${border(`${"─".repeat(remaining - left)}╮`)}`;
};

export const middleBorder = (theme: Theme, width: number): string =>
  theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);

export const bottomBorder = (theme: Theme, width: number): string =>
  theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);

export const row = (theme: Theme, width: number, content: string): string => {
  const edge = theme.fg("borderMuted", "│");
  return `${edge}${padToWidth(content, Math.max(0, width - 2))}${edge}`;
};

export const narrowFallback = (width: number, label: string, hint: string): string[] =>
  [safeText(label), hint]
    .map((line) => truncateToWidth(line, width, ""))
    .filter((line) => visibleWidth(line) > 0);
