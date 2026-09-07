import { describe, expect, it } from "vitest";
import { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "t",
  nestedToolCallId: "n",
  extensionContext: {} as never,
  update() {},
  activity() {},
} as unknown as FabricInvocationContext;

const propertiesOf = async (action: string): Promise<string[]> => {
  const provider = new OmpToolsProvider(process.cwd());
  const descriptor = await provider.describe(action, context);
  const schema = descriptor?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {}).sort();
};

describe("omp tool descriptors advertise their filters", () => {
  it("grep publishes gitignore and skip", async () => {
    const props = await propertiesOf("grep");
    expect(props).toContain("gitignore");
    expect(props).toContain("skip");
  });
  it("find publishes gitignore and hidden", async () => {
    const props = await propertiesOf("find");
    expect(props).toContain("gitignore");
    expect(props).toContain("hidden");
  });
});
