import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";

const box = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeDown: "┬",
  teeUp: "┴",
  teeLeft: "┤",
  teeRight: "├",
  cross: "┼",
};

export const ompSymbolTheme: SymbolSet = {
  preset: "unicode",
  box,
  sharp: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
  },
  symbol: () => "",
  icon: () => "",
  langIcon: () => "",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  activityFrames: [],
  ellipsis: "…",
};
