import type { ExtensionContext, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { streamedToolCallName } from "./stream-tap.js";
import type { FabricSpeculationStreamTap } from "./stream-tap.js";

export interface FabricSpeculationWarmupOptions {
  enabled(): boolean;
  tap(): FabricSpeculationStreamTap | undefined;
  activate(context: ExtensionContext): Promise<void>;
  maxBufferedEvents?: number;
  maxBufferedChars?: number;
}

const DEFAULT_MAX_BUFFERED_EVENTS = 4_096;
const DEFAULT_MAX_BUFFERED_CHARS = 2 * 1024 * 1024;

export class FabricSpeculationWarmup {
  readonly #options: FabricSpeculationWarmupOptions;
  readonly #buffered: MessageUpdateEvent[] = [];
  #bufferedChars = 0;
  #activating = false;
  #overflowed = false;

  constructor(options: FabricSpeculationWarmupOptions) {
    this.#options = options;
  }

  get pending(): number {
    return this.#buffered.length;
  }

  reset(): void {
    this.#buffered.length = 0;
    this.#bufferedChars = 0;
    this.#overflowed = false;
  }

  handleMessageUpdate(event: MessageUpdateEvent, context: ExtensionContext): void {
    try {
      const tap = this.#options.tap();
      if (tap) {
        this.#drain(tap, context);
        tap.handleMessageUpdate(event, context);
        return;
      }
      if (!this.#options.enabled()) return;
      const assistantEvent = event.assistantMessageEvent;
      if (
        assistantEvent.type !== "toolcall_start" &&
        assistantEvent.type !== "toolcall_delta" &&
        assistantEvent.type !== "toolcall_end"
      ) {
        return;
      }
      const name = streamedToolCallName(event);
      if (name !== undefined && name !== "fabric_exec") return;
      this.#buffer(event, assistantEvent.type === "toolcall_delta" ? assistantEvent.delta.length : 0);
      if (this.#activating) return;
      this.#activating = true;
      void this.#options
        .activate(context)
        .then(
          () => {
            const activated = this.#options.tap();
            if (activated) this.#drain(activated, context);
          },
          () => undefined,
        )
        .finally(() => {
          this.#activating = false;
        });
    } catch {
      return;
    }
  }

  #buffer(event: MessageUpdateEvent, chars: number): void {
    if (this.#overflowed) return;
    if (
      this.#buffered.length >= (this.#options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS) ||
      this.#bufferedChars + chars > (this.#options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS)
    ) {
      this.#overflowed = true;
      this.#buffered.length = 0;
      this.#bufferedChars = 0;
      return;
    }
    this.#buffered.push(event);
    this.#bufferedChars += chars;
  }

  #drain(tap: FabricSpeculationStreamTap, context: ExtensionContext): void {
    if (this.#buffered.length === 0) return;
    const replay = this.#buffered.splice(0);
    this.#bufferedChars = 0;
    for (const event of replay) tap.handleMessageUpdate(event, context);
  }
}
