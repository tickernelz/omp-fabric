export const FABRIC_CONVERSATION_SHORTCUT = "ctrl+shift+a";

export const conversationHint = (shortcut: string): string => {
  const trimmed = shortcut.trim();
  if (!trimmed) return "/fabric chat";
  const label = trimmed
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
  return `${label} chat`;
};
