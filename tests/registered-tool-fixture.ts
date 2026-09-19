import type { RegisteredTool, SourceInfo } from "@oh-my-pi/pi-coding-agent";

export const fixtureSourceInfo = (extensionPath: string): SourceInfo => ({
  path: extensionPath,
  source: "extension",
  scope: "user",
  origin: "top-level",
});

export const fixtureRegisteredTool = (
  definition: RegisteredTool["definition"],
  extensionPath: string,
): RegisteredTool => ({
  definition,
  extensionPath,
  sourceInfo: fixtureSourceInfo(extensionPath),
});
