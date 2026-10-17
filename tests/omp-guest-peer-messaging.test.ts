import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "../src/core/action-registry.js";
import { hostAgentIdentity, OmpToolsProvider } from "../src/providers/omp-tools-provider.js";

const SESSION_ID = "fabric-guest-irc-session";
const HOST_ID = "FabricGuestIrcHost";
const PEER_ID = "FabricGuestIrcPeer";

const hostContext = (sessionId = SESSION_ID) =>
  ({
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    agent: { kind: "main", id: HOST_ID, name: "main", depth: 0 },
  }) as unknown as ExtensionContext;

const registerHost = (settings = Settings.isolated()) =>
  AgentRegistry.global().register({
    id: HOST_ID,
    displayName: HOST_ID,
    kind: "main",
    status: "running",
    session: {
      sessionManager: { getSessionId: () => SESSION_ID },
      getAgentId: () => HOST_ID,
      settings,
    } as unknown as AgentSession,
  });

const registerPeer = () => {
  const deliverIrcMessage = vi.fn(async () => "injected" as const);
  AgentRegistry.global().register({
    id: PEER_ID,
    displayName: PEER_ID,
    kind: "sub",
    parentId: HOST_ID,
    status: "running",
    session: {
      sessionManager: { getSessionId: () => "fabric-guest-irc-peer-session" },
      getAgentId: () => PEER_ID,
      deliverIrcMessage,
    } as unknown as AgentSession,
  });
  return deliverIrcMessage;
};

const guestWrite = (context: ExtensionContext, content: string) => {
  const registry = new ActionRegistry();
  registry.register(
    new OmpToolsProvider(process.cwd(), undefined, undefined, undefined, {
      getSessionId: () => context.sessionManager.getSessionId(),
      ...hostAgentIdentity(context),
    }),
  );
  return registry.invoke(
    "omp.write",
    { path: `agent://${PEER_ID}`, content },
    {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      parentToolCallId: "parent",
      nestedToolCallId: "fabric_guest-irc",
      extensionContext: context,
      update: vi.fn(),
      approve: vi.fn(async () => {}),
      audits: [],
      maxResultChars: 100_000,
    },
  ) as Promise<{ ok: boolean; output: string }>;
};

afterEach(() => {
  AgentRegistry.global().unregister(PEER_ID);
  AgentRegistry.global().unregister(HOST_ID);
});

describe("guest agent:// messaging", () => {
  it("delivers a guest write to a live peer through the host registry", async () => {
    registerHost();
    const deliverIrcMessage = registerPeer();

    const result = await guestWrite(hostContext(), "ping from guest");

    expect(result.output).toContain(`Delivered to ${PEER_ID}`);
    expect(deliverIrcMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: HOST_ID, to: PEER_ID, body: "ping from guest" }),
    );
  });

  it("keeps messaging unavailable when the host session is not in the registry", async () => {
    const deliverIrcMessage = registerPeer();

    await expect(guestWrite(hostContext(), "ping")).rejects.toThrow("Peer messaging is unavailable in this session.");
    expect(deliverIrcMessage).not.toHaveBeenCalled();
  });

  it("keeps messaging unavailable when the registered agent belongs to another session", async () => {
    registerHost();
    const deliverIrcMessage = registerPeer();

    await expect(guestWrite(hostContext("other-session"), "ping")).rejects.toThrow(
      "Peer messaging is unavailable in this session.",
    );
    expect(deliverIrcMessage).not.toHaveBeenCalled();
  });

  it("keeps messaging unavailable when host settings forbid spawning at the top level", async () => {
    registerHost(Settings.isolated({ "task.maxRecursionDepth": 0 }));
    const deliverIrcMessage = registerPeer();

    await expect(guestWrite(hostContext(), "ping")).rejects.toThrow("Peer messaging is unavailable in this session.");
    expect(deliverIrcMessage).not.toHaveBeenCalled();
  });
});
