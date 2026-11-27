type PaintApi = Pick<typeof import("@oh-my-pi/pi-tui/term/paint"), "defineRolePainter">;
type WidgetsApi = Pick<typeof import("@oh-my-pi/pi-tui/term/widgets"), "defineRoleWidget">;
type RenderApi = Pick<typeof import("@oh-my-pi/pi-tui/term/render"), "renderBlock">;
type KeymapApi = Pick<typeof import("@oh-my-pi/pi-tui/term/keymap"), "widgetKeyMatches" | "widgetActionOf">;
type DecoderApi = Pick<typeof import("@oh-my-pi/pi-tui/driver/input/decoder"), "decodeInput">;

interface HostTerm {
  readonly paint?: PaintApi;
  readonly widgets?: WidgetsApi;
  readonly render?: RenderApi;
  readonly keymap?: KeymapApi;
  readonly decoder?: DecoderApi;
}

interface HostTermModule {
  readonly key: keyof HostTerm;
  readonly id: string;
  readonly exports: readonly string[];
  readonly loses: string;
  readonly load: () => Promise<unknown>;
}

const MODULES: readonly HostTermModule[] = [
  {
    key: "paint",
    id: "@oh-my-pi/pi-tui/term/paint",
    exports: ["defineRolePainter"],
    loses: "mouse wheel scrolling",
    load: () => import("@oh-my-pi/pi-tui/term/paint"),
  },
  {
    key: "widgets",
    id: "@oh-my-pi/pi-tui/term/widgets",
    exports: ["defineRoleWidget"],
    loses: "mouse wheel scrolling",
    load: () => import("@oh-my-pi/pi-tui/term/widgets"),
  },
  {
    key: "render",
    id: "@oh-my-pi/pi-tui/term/render",
    exports: ["renderBlock"],
    loses: "previews drawn by host tool renderers",
    load: () => import("@oh-my-pi/pi-tui/term/render"),
  },
  {
    key: "keymap",
    id: "@oh-my-pi/pi-tui/term/keymap",
    exports: ["widgetKeyMatches", "widgetActionOf"],
    loses: "rebound widget keys (the default keys still work)",
    load: () => import("@oh-my-pi/pi-tui/term/keymap"),
  },
  {
    key: "decoder",
    id: "@oh-my-pi/pi-tui/driver/input/decoder",
    exports: ["decodeInput"],
    loses: "input that does not arrive as a host key event",
    load: () => import("@oh-my-pi/pi-tui/driver/input/decoder"),
  },
];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const loadHostTerm = async (): Promise<{ term: HostTerm; missing: string[]; losses: string[] }> => {
  const term: Record<string, unknown> = {};
  const missing: string[] = [];
  const losses = new Set<string>();
  await Promise.all(
    MODULES.map(async (module) => {
      try {
        const loaded = (await module.load()) as Record<string, unknown>;
        const absent = module.exports.filter((name) => typeof loaded[name] !== "function");
        if (absent.length === 0) {
          term[module.key] = loaded;
          return;
        }
        missing.push(`${module.id} (no export ${absent.join(", ")})`);
      } catch (error) {
        missing.push(`${module.id} (${errorText(error)})`);
      }
      losses.add(module.loses);
    }),
  );
  return { term: term as HostTerm, missing: missing.sort(), losses: [...losses] };
};

const loaded = await loadHostTerm();

export const hostTerm = (): HostTerm => loaded.term;

export const hostTermDiagnostic = (): string | undefined =>
  loaded.missing.length === 0
    ? undefined
    : `Fabric UI is running without host pi-tui internals: ${loaded.missing.join("; ")}. Views render as plain rows; unavailable: ${loaded.losses.join(", ")}.`;
