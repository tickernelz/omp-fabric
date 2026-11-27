import { isUiNode, signal, type KeyEvent, type PasteEvent, UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { hostTerm } from "./host-term.js";
import { rememberHostKey } from "./input.js";

export interface Rows {
  render(width: number): readonly string[];
  invalidate?(): void;
}

export interface FabricView extends Rows {
  handleInput?(data: string): void;
  handleWheel?(rows: number): void;
  dispose?(): void;
}

export interface FabricViewHost {
  requestRender(): void;
  size(): { readonly columns: number; readonly rows: number };
}

const VIEW_ROLE = "fabric.view";
const WHEEL_ROWS = 3;
const mounted = new WeakMap<UiNode, { view: FabricView; paint: (width: number) => string[]; wheel: (rows: number) => void }>();
let roleRegistered = false;

const registerRole = (): boolean => {
  if (roleRegistered) return true;
  const { paint, widgets } = hostTerm();
  if (!paint || !widgets) return false;
  roleRegistered = true;
  paint.defineRolePainter("canvas", VIEW_ROLE, (node, cx) => {
    const rows = mounted.get(node)?.paint(cx.width) ?? [];
    return { rows, hits: rows.length > 0 ? [{ row: 0, col: 0, width: cx.width, height: rows.length, node }] : [] };
  });
  widgets.defineRoleWidget("canvas", VIEW_ROLE, {
    mouse(node, mouse) {
      const entry = mounted.get(node);
      if (!entry?.view.handleWheel || mouse.action !== "press") return false;
      if (mouse.button === "wheel-up") entry.wheel(-WHEEL_ROWS);
      else if (mouse.button === "wheel-down") entry.wheel(WHEEL_ROWS);
      else return false;
      return true;
    },
  });
  return true;
};

export const mountedView = (node: unknown): FabricView | undefined =>
  isUiNode(node) ? mounted.get(node)?.view : undefined;

const EMPTY_ROWS: Rows = { render: () => [] };
const HOST_PREVIEW_UNAVAILABLE = "Preview unavailable: this OMP host does not provide pi-tui term/render.";

export const isRows = (value: unknown): value is Rows =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isUiNode(value) &&
  "render" in value &&
  typeof value.render === "function";

export const asRows = (output: unknown, theme: Theme): Rows => {
  if (output === undefined || output === null || output === false || output === "") return EMPTY_ROWS;
  if (isRows(output)) return output;
  const render = hostTerm().render;
  if (!render) return { render: (width) => [truncate(HOST_PREVIEW_UNAVAILABLE, width)] };
  const node = isUiNode(output) ? output : new UiNode("col", { children: output });
  return { render: (width) => render.renderBlock(node, width, { theme }).rows };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const mountView = <V extends FabricView>(
  size: FabricViewHost["size"],
  build: (host: FabricViewHost) => V,
  onError?: (error: unknown) => void,
): { node: UiNode; view: V } => {
  const role = registerRole();
  const revision = signal(0);
  const requestRender = (): void => revision.set(untrack(revision) + 1);
  const view = build({ requestRender, size });
  let paintFailed = false;
  const contain = (action: () => void): true => {
    try {
      action();
    } catch (error) {
      onError?.(error);
    }
    requestRender();
    return true;
  };
  const deliver = (data: string): boolean => contain(() => view.handleInput?.(data));
  const paint = (width: number): string[] => {
    revision();
    try {
      const rows = view.render(width).map((row) => truncate(row, width, ""));
      paintFailed = false;
      return rows;
    } catch (error) {
      if (!paintFailed) onError?.(error);
      paintFailed = true;
      return [truncate(`⚠ Fabric view failed to render: ${errorText(error)}`, width)];
    }
  };
  const node = new UiNode("canvas", {
    paint,
    ...(role ? { term: { role: VIEW_ROLE } } : {}),
    onKey: (key: KeyEvent) => {
      if (key.kind === "release") return false;
      rememberHostKey(key);
      return deliver(key.raw);
    },
    onPaste: (paste: PasteEvent) => deliver(`\x1b[200~${paste.text}\x1b[201~`),
  });
  mounted.set(node, { view, paint, wheel: (rows) => contain(() => view.handleWheel?.(rows)) });
  return { node, view };
};
