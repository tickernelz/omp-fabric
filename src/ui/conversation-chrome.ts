import { homedir } from "node:os";
import path from "node:path";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { formatTokens, safeText } from "./format.js";
import type { FabricConversationTarget } from "./conversation.js";

export interface FabricConversationAppearance {
  editorPaddingX: number;
  hideThinkingBlock?: boolean;
}

/** Read OMP appearance settings; cwd and agentDir apply only to trusted project loading. */
export async function readConversationAppearance(cwd: string, agentDir: string, projectTrusted: boolean): Promise<FabricConversationAppearance> {
  const [{ Settings }, { cfgHideThinkingBlock }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/session/settings"),
  ]);
  const settings = projectTrusted
    ? await Settings.loadReadOnly({ cwd, agentDir })
    : Settings.isolated();
  return {
    editorPaddingX: 0,
    hideThinkingBlock: cfgHideThinkingBlock.get(settings) === true,
  };
}

const footerPath = (cwd: string): string => {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

/** Native-shaped footer backed by this participant, never by Main's session stats. */
export function conversationFooter(target: FabricConversationTarget | undefined, theme: Theme, width: number): string[] {
  if (!target || width <= 0) return [];
  const location = target.cwd ? footerPath(target.cwd) : "cwd unavailable";
  const branch = target.branch ? ` (${target.branch})` : "";
  const pwd = safeText(`${location}${branch} • ${target.name}`);
  const stats = [safeText(target.status)];
  if (target.usage) {
    const usage = target.usage;
    // Agent usage is run-scoped; actor values describe the current/last activation.
    stats.push("run", `↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`);
    if (usage.cacheRead > 0) stats.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) stats.push(`W${formatTokens(usage.cacheWrite)}`);
    if (Number.isFinite(usage.cost)) stats.push(`$${usage.cost.toFixed(3)}`);
  } else {
    stats.push("usage unavailable");
  }
  // Cumulative run tokens are not current context occupancy. Do not invent a percentage.
  stats.push(target.contextWindow ? `?/${formatTokens(target.contextWindow)} ctx` : "ctx ?");
  const model = safeText(target.model ?? `${target.runner ?? ""} model unavailable`).trim();
  const thinking = target.thinking ? ` • ${safeText(target.thinking === "off" ? "thinking off" : target.thinking)}` : "";
  const left = truncate(stats.join(" "), width);
  const right = truncate(`${model}${thinking}`, Math.max(0, width - visibleWidth(left) - 2), "");
  const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
  return [
    truncate(theme.fg("dim", pwd), width),
    theme.fg("dim", `${left}${gap}${right}`),
  ];
}
