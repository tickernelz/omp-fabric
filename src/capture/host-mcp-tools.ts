import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

interface HostMcpModules {
  instance: () => { getTools(): unknown[] } | undefined;
  toDefinition: (tool: never) => ToolDefinition<any, any>;
}

export interface HostMcpToolSource {
  load(): Promise<void>;
  tools(): readonly ToolDefinition<any, any>[];
  signature(): string;
}

export const createHostMcpToolSource = (): HostMcpToolSource => {
  let modules: HostMcpModules | undefined;
  let cachedFrom: readonly unknown[] | undefined;
  let cached: readonly ToolDefinition<any, any>[] = [];
  const current = (): readonly unknown[] => {
    try {
      return modules?.instance()?.getTools() ?? [];
    } catch {
      return [];
    }
  };
  return {
    async load() {
      if (modules) return;
      try {
        const [mcp, sdk] = await Promise.all([
          import("@oh-my-pi/pi-coding-agent/mcp"),
          import("@oh-my-pi/pi-coding-agent"),
        ]);
        const manager = (mcp as { MCPManager?: { instance?: () => { getTools(): unknown[] } | undefined } }).MCPManager;
        const toDefinition = (sdk as { customToolToDefinition?: (tool: never) => ToolDefinition<any, any> }).customToolToDefinition;
        if (typeof manager?.instance === "function" && typeof toDefinition === "function") {
          modules = { instance: () => manager.instance?.(), toDefinition };
        }
      } catch {
        modules = undefined;
      }
    },
    tools() {
      const raw = current();
      if (raw === cachedFrom) return cached;
      cachedFrom = raw;
      cached = modules ? raw.map((tool) => modules!.toDefinition(tool as never)) : [];
      return cached;
    },
    signature() {
      return current().map((tool) => (tool as { name?: string }).name ?? "").join("\u0000");
    },
  };
};
