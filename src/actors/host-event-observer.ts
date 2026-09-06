import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
  FABRIC_ACTOR_OMP_HOST_EVENTS,
  type FabricActorOmpHostEvent,
} from "./types.js";

export type FabricActorHostEventObserver = (
  eventName: typeof FABRIC_ACTOR_OMP_HOST_EVENTS[number],
  event: ExtensionEvent,
  context: ExtensionContext,
) => void;

interface ObservableExtensionApi {
  on(
    event: typeof FABRIC_ACTOR_OMP_HOST_EVENTS[number],
    handler: (event: ExtensionEvent, context: ExtensionContext) => void,
  ): void;
}

export const registerFabricActorHostEventObservers = (
  omp: ExtensionAPI,
  observer: FabricActorHostEventObserver,
): void => {
  const observable = omp as unknown as ObservableExtensionApi;
  for (const eventName of FABRIC_ACTOR_OMP_HOST_EVENTS) {
    observable.on(eventName, (event, context) => observer(eventName, event, context));
  }
};
