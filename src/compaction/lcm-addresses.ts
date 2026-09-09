import { utf8Bytes } from "./bounds.js";

export interface LcmAddressSource {
  sessionId: string;
  entryId: string;
  revision: number;
}

const SOURCES_LABEL = "sources: ";
const CHILDREN_LABEL = "children: ";

const renderAddressList = (label: string, addresses: readonly string[], budget: number): string => {
  if (budget <= 0 || addresses.length === 0) return "";
  const markerReserve = utf8Bytes(`, +${addresses.length} more`);
  const kept: string[] = [];
  let used = utf8Bytes(label);
  for (const address of addresses) {
    const cost = utf8Bytes(kept.length === 0 ? address : `, ${address}`);
    const reserve = kept.length + 1 < addresses.length ? markerReserve : 0;
    if (used + cost + reserve > budget) break;
    used += cost;
    kept.push(address);
  }
  if (kept.length === 0) return "";
  const omitted = addresses.length - kept.length;
  return `${label}${kept.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`;
};

export const lcmRawAddress = (source: LcmAddressSource): string =>
  `lcm.raw:${source.sessionId}:${source.entryId}:${source.revision}`;

export const lcmSummaryAddress = (nodeId: string): string => `lcm.summary:${nodeId}`;

export const renderLcmSourceAddresses = (
  sources: readonly LcmAddressSource[],
  budget: number,
): string => renderAddressList(SOURCES_LABEL, sources.map(lcmRawAddress), budget);

export const renderLcmChildAddresses = (
  nodeIds: readonly string[],
  budget: number,
): string => renderAddressList(CHILDREN_LABEL, nodeIds.map(lcmSummaryAddress), budget);
