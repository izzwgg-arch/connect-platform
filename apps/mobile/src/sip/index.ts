import { JsSipClient } from "./jssip";
import { SimulatedSipClient } from "./simulated";
import type { SipClient } from "./types";

export function createSipClient(): SipClient {
  const simulate = (process.env.EXPO_PUBLIC_VOICE_SIMULATE || "false").toLowerCase() === "true";
  return simulate ? new SimulatedSipClient() : new JsSipClient();
}
