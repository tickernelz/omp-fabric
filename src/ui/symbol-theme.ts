import type { SymbolTheme } from "@oh-my-pi/pi-tui";

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

export const ompSymbolTheme: SymbolTheme = {
  cursor: "›",
  inputCursor: "│",
  boxRound: box,
  boxSharp: {
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
  table: box,
  quoteBorder: "│",
  hrChar: "─",
  colorSwatch: "■",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
