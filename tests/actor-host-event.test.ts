import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { prepareFabricActorHostPayload } from "../src/actors/host-event-payload.js";
import { registerFabricActorHostEventObservers } from "../src/actors/host-event-observer.js";
import {
  FABRIC_ACTOR_HOST_EVENTS,
  FABRIC_ACTOR_OMP_HOST_EVENTS,
} from "../src/actors/types.js";

describe("Fabric actor host events", () => {
  it("covers every session-bound public OMP extension event plus tool_error", () => {
    expect(FABRIC_ACTOR_OMP_HOST_EVENTS).toEqual([
      "resources_discover",
      "session_start",
      "session_before_switch",
      "session_switch",
      "session_before_branch",
      "session_branch",
      "session_before_compact",
      "session.compacting",
      "session_compact",
      "session_shutdown",
      "session_before_tree",
      "session_tree",
      "goal_updated",
      "input",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "session_stop",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "context",
      "before_provider_request",
      "after_provider_response",
      "tool_execution_start",
      "tool_call",
      "tool_execution_update",
      "tool_result",
      "tool_execution_end",
      "user_bash",
    ]);
    expect(FABRIC_ACTOR_HOST_EVENTS).toEqual([
      ...FABRIC_ACTOR_OMP_HOST_EVENTS,
      "tool_error",
    ]);
    expect(FABRIC_ACTOR_HOST_EVENTS).not.toContain("project_trust");
  });

  it("registers one asynchronous observer for every supported OMP event", () => {
    const handlers = new Map<string, (event: ExtensionEvent, context: ExtensionContext) => void>();
    const omp = {
      on: vi.fn((event: string, handler: (event: ExtensionEvent, context: ExtensionContext) => void) => {
        handlers.set(event, handler);
      }),
    } as unknown as ExtensionAPI;
    const observer = vi.fn();
    registerFabricActorHostEventObservers(omp, observer);

    expect([...handlers.keys()]).toEqual(FABRIC_ACTOR_OMP_HOST_EVENTS);
    const event = { type: "input", text: "inspect", source: "interactive" } as ExtensionEvent;
    const context = {} as ExtensionContext;
    handlers.get("input")?.(event, context);
    expect(observer).toHaveBeenCalledWith("input", event, context);
  });

  it("extracts and deduplicates images while redacting persisted media and secrets", () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const circular: Record<string, unknown> = { label: "loop" };
    circular.self = circular;
    const prepared = prepareFabricActorHostPayload(
      {
        type: "input",
        text: "Bearer secret-token-value",
        images: [image, { ...image }],
        headers: {
          Authorization: "Bearer should-not-persist",
          "X-Api-Key": "key-should-not-persist",
          "Content-Type": "application/json",
        },
        circular,
      },
      40_000,
    );

    expect(prepared.images).toEqual([image]);
    expect(prepared.media).toHaveLength(1);
    expect(prepared.media[0]).toMatchObject({
      type: "image",
      mediaIndex: 0,
      mimeType: "image/png",
    });
    const persisted = JSON.stringify(prepared.payload);
    expect(persisted).toContain('"mediaIndex":0');
    expect(persisted).toContain('"redacted":true');
    expect(persisted).toContain("Content-Type");
    expect(persisted).not.toContain(image.data);
    expect(persisted).not.toContain("should-not-persist");
    expect(persisted).not.toContain("secret-token-value");
    expect(persisted).toContain("[circular or repeated reference]");
  });
});
