import type { BridgedActiveResult } from "../ari/ariBridgedActiveCalls";

export type AriBridgedPollOutcome = {
  result: BridgedActiveResult;
  registeredEndpoints: number | null;
  unregisteredEndpoints: number | null;
  totalEndpoints: number | null;
  rawBridgeCount: number;
  rawChannelCount: number;
};

export type AfterAriBridgedPoll = (out: AriBridgedPollOutcome) => Promise<void>;
