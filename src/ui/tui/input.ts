import type { KeyEvent } from "@oh-my-pi/pi-tui";
import type { WidgetAction } from "@oh-my-pi/pi-tui/term/keymap";
import { hostTerm } from "./host-term.js";

type TerminalInput =
  | { readonly type: "key"; readonly key: KeyEvent }
  | { readonly type: "paste"; readonly text: string };

const MODIFIED = /^(?:ctrl|alt|super)\+/;
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

const DEFAULT_KEYS: Readonly<Record<WidgetAction, readonly string[]>> = {
  "select.up": ["up"],
  "select.down": ["down"],
  "select.pageUp": ["pageUp"],
  "select.pageDown": ["pageDown"],
  "select.confirm": ["enter"],
  "select.cancel": ["escape"],
  "editor.selectAll": ["super+a"],
  "editor.cursorUp": ["up"],
  "editor.cursorDown": ["down"],
  "editor.cursorLeft": ["left", "ctrl+b"],
  "editor.cursorRight": ["right", "ctrl+f"],
  "editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "editor.cursorLineStart": ["home", "ctrl+a"],
  "editor.cursorLineEnd": ["end", "ctrl+e"],
  "editor.pageUp": ["pageUp"],
  "editor.pageDown": ["pageDown"],
  "editor.deleteCharBackward": ["backspace"],
  "editor.deleteCharForward": ["delete", "ctrl+d"],
  "editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace", "alt+super+backspace"],
  "editor.deleteWordForward": ["alt+delete", "alt+d", "ctrl+delete", "alt+super+delete", "alt+super+d"],
  "editor.deleteToLineStart": ["ctrl+u"],
  "editor.deleteToLineEnd": ["ctrl+k"],
  "editor.yank": ["ctrl+y"],
  "editor.yankPop": ["alt+y"],
  "editor.undo": ["ctrl+-", "ctrl+_"],
  "editor.newLine": ["shift+enter", "ctrl+j"],
};

let lastHostKey: KeyEvent | undefined;

export const rememberHostKey = (key: KeyEvent): void => {
  lastHostKey = key;
};

const decodeWithoutHost = (data: string): TerminalInput[] => {
  if (lastHostKey?.raw === data) return [{ type: "key", key: lastHostKey }];
  const paste = BRACKETED_PASTE.exec(data);
  return paste ? [{ type: "paste", text: paste[1]! }] : [];
};

export const decodeTerminalInput = (data: string): TerminalInput[] => {
  const decoder = hostTerm().decoder;
  if (!decoder) return decodeWithoutHost(data);
  const result: TerminalInput[] = [];
  for (const event of decoder.decodeInput(data)) {
    if (event.type === "key" && event.key.kind !== "release") result.push({ type: "key", key: event.key });
    else if (event.type === "paste") result.push({ type: "paste", text: event.paste.text });
  }
  return result;
};

export const keyMatches = (key: KeyEvent, action: WidgetAction): boolean => {
  const keymap = hostTerm().keymap;
  if (keymap) return keymap.widgetKeyMatches(key, action);
  return key.kind !== "release" && DEFAULT_KEYS[action].includes(key.id);
};

export const actionOf = <A extends WidgetAction>(id: string, actions: readonly A[]): A | undefined => {
  const keymap = hostTerm().keymap;
  if (keymap) return keymap.widgetActionOf(id, actions);
  return actions.find((action) => DEFAULT_KEYS[action].includes(id));
};

export const keyOf = (data: string): KeyEvent | undefined => {
  const events = decodeTerminalInput(data);
  const first = events[0];
  return events.length === 1 && first?.type === "key" ? first.key : undefined;
};

export const isKey = (data: string, id: string): boolean => keyOf(data)?.id === id;

export const isAction = (data: string, action: WidgetAction): boolean => {
  const key = keyOf(data);
  return key !== undefined && keyMatches(key, action);
};

export const typedText = (key: KeyEvent): string | undefined =>
  key.text !== undefined && key.text !== "" && !MODIFIED.test(key.id) ? key.text : undefined;
