import { type Mock, vi } from "vitest";
import type { FabricViewHost } from "../src/ui/tui/view.js";

export const viewHost = (rows = 28, columns = 120): FabricViewHost & { requestRender: Mock<() => void> } => ({
  requestRender: vi.fn<() => void>(),
  size: () => ({ columns, rows }),
});
