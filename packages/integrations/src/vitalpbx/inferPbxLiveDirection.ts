/**
 * Classify live call direction from Asterisk dialplan position (VitalPBX patterns).
 * Delegates to callDirectionPolicy for parity with ConnectCdr ingest.
 */

import { classifyCallDirectionByEvidence } from "./callDirectionPolicy";

export function inferPbxLiveDirection(
  context: string,
  exten: string,
  callerIdNum: string,
): "incoming" | "outgoing" | "internal" {
  const c = classifyCallDirectionByEvidence({
    dcontexts: context.trim() ? [context.trim()] : [],
    channelNames: [],
    fromNumber: callerIdNum,
    toNumber: exten,
    telephonyDirectionHint: null,
  });
  if (c === "incoming") return "incoming";
  if (c === "outgoing") return "outgoing";
  if (c === "internal") return "internal";
  return "incoming";
}
