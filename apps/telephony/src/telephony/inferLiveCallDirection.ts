import type { CallDirection } from "./types";
import { classifyCallDirectionByEvidence, connectDirectionToTelephony } from "./pbx/callDirectionPolicy";

/**
 * Live call direction from current Asterisk dialplan position (single channel snapshot).
 * Uses the same policy as ConnectCdr ingest (callDirectionPolicy).
 */
export function inferLiveCallDirection(
  context: string,
  exten: string,
  callerIdNum: string,
): CallDirection {
  const c = classifyCallDirectionByEvidence({
    dcontexts: context.trim() ? [context.trim()] : [],
    channelNames: [],
    fromNumber: callerIdNum,
    toNumber: exten,
    telephonyDirectionHint: null,
  });
  return connectDirectionToTelephony(c);
}
