import { createRequire } from "node:module";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bold, inverse, italic, strikethrough, underline } from "@oh-my-pi/pi-tui/theme/theme";
import type { FabricTheme } from "../../src/ui/render-types.js";

interface NativeTranscriptComponents {
  UserMessage: (props: { model: Record<string, unknown> }) => JSXNode;
  AssistantMessageBlock: (props: { model: Record<string, unknown> }) => JSXNode;
}

const load = createRequire(import.meta.url);
const userMessageModule = load("./native-user-message.tsx") as {
  UserMessage: (props: { model: Record<string, unknown> }) => JSXNode;
};
const assistantMessageModule = load("./native-assistant-message.tsx") as {
  AssistantMessageBlock: (props: { model: Record<string, unknown> }) => JSXNode;
};

export const UserMessage = userMessageModule.UserMessage;
export const AssistantMessageBlock = assistantMessageModule.AssistantMessageBlock;

const textStyles = { bold, inverse, italic, strikethrough, underline };
export const nativeTestTheme = (): FabricTheme => new Proxy(currentTheme(), {
  get(target, key) {
    if (Object.hasOwn(textStyles, key)) return textStyles[key as keyof typeof textStyles];
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as unknown as FabricTheme;

export type { AssistantMessage, NativeTranscriptComponents };
