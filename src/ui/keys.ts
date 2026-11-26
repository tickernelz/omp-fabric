import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import type { KeyEvent } from "@oh-my-pi/pi-tui";

export const keyEvents = (data: string): readonly KeyEvent[] =>
  decodeInput(data).flatMap((event) => (event.type === "key" ? [event.key] : []));
