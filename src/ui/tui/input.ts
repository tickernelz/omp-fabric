import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { type WidgetAction, widgetKeyMatches } from "@oh-my-pi/pi-tui/term/keymap";

type TerminalInput =
  | { readonly type: "key"; readonly key: KeyEvent }
  | { readonly type: "paste"; readonly text: string };

const MODIFIED = /^(?:ctrl|alt|super)\+/;

export const decodeTerminalInput = (data: string): TerminalInput[] => {
  const result: TerminalInput[] = [];
  for (const event of decodeInput(data)) {
    if (event.type === "key" && event.key.kind !== "release") result.push({ type: "key", key: event.key });
    else if (event.type === "paste") result.push({ type: "paste", text: event.paste.text });
  }
  return result;
};

export const keyOf = (data: string): KeyEvent | undefined => {
  const events = decodeTerminalInput(data);
  const first = events[0];
  return events.length === 1 && first?.type === "key" ? first.key : undefined;
};

export const isKey = (data: string, id: string): boolean => keyOf(data)?.id === id;

export const isAction = (data: string, action: WidgetAction): boolean => {
  const key = keyOf(data);
  return key !== undefined && widgetKeyMatches(key, action);
};

export const typedText = (key: KeyEvent): string | undefined =>
  key.text !== undefined && key.text !== "" && !MODIFIED.test(key.id) ? key.text : undefined;
