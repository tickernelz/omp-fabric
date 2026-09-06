import type { ExtensionRunner, RegisteredTool, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

// Local mirror of wrapRegisteredTool/wrapToolDefinition (OMP host,
// core/extensions/wrapper.js and core/tools/tool-definition-wrapper.js).
// Captured tools must execute with exactly the host wrapper semantics —
// extension runner context injection and post-execution addedToolNames merge —
// without importing the host package during extension load.

type WrappedExecute = (
  toolCallId: unknown,
  params: unknown,
  signal: unknown,
  onUpdate: (update: any) => void,
  ctx?: unknown,
) => Promise<any>;

export interface WrappedRegisteredTool {
  name: string;
  label: string | undefined;
  description: string | undefined;
  parameters: unknown;
  constrainedSampling: unknown;
  prepareArguments: ((args: Record<string, unknown>) => unknown) | undefined;
  executionMode: unknown;
  execute: WrappedExecute;
}

const wrapToolDefinition = (
  definition: ToolDefinition<any, any>,
  ctxFactory: () => unknown,
): WrappedRegisteredTool => {
  const execute = definition.execute as unknown as WrappedExecute;
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    constrainedSampling: undefined,
    prepareArguments: undefined,
    executionMode: undefined,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      execute(toolCallId, params, signal, onUpdate, ctx ?? ctxFactory()),
  };
};

export const wrapRegisteredToolForCapture = (
  registeredTool: RegisteredTool,
  runner: ExtensionRunner,
): WrappedRegisteredTool => {
  const tool = wrapToolDefinition(
    registeredTool.definition as ToolDefinition<any, any>,
    () => runner.createContext(),
  );
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx): Promise<any> => {
      const getActiveTools = (runner as unknown as { getActiveTools?: () => string[] }).getActiveTools;
      const activeBefore = getActiveTools?.() ?? [];
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      const activeAfter = getActiveTools?.() ?? activeBefore;
      if (!activeBefore.every((name) => activeAfter.includes(name))) {
        return result;
      }
      const beforeNames = new Set(activeBefore);
      const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
      if (addedToolNames.length === 0) {
        return result;
      }
      const previous = ((result as { addedToolNames?: string[] } | undefined)?.addedToolNames) ?? [];
      return {
        ...(result as Record<string, unknown>),
        addedToolNames: [...new Set([...previous, ...addedToolNames])],
      };
    },
  };
};
