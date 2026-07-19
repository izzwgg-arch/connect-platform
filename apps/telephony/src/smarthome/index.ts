// Smart-home IVR module — wires config + FastAGI server + IVR flow together.
// Enabled only when SMARTHOME_IVR_ENABLED=true; the rest of the telephony
// service is unaffected when the flag is off.

import { childLogger } from "../logging/logger";
import {
  smarthomeCallsTotal,
  smarthomeAuthFailuresTotal,
  smarthomeHaActionsTotal,
} from "../metrics";
import { AgiServer } from "./agi/AgiServer";
import { loadSmartHomeConfig } from "./config";
import { HomeAssistantClient } from "./HomeAssistantClient";
import { PinLockout } from "./pinLockout";
import { SmartHomeIvr } from "./SmartHomeIvr";

const log = childLogger("SmartHomeModule");

export interface SmartHomeModuleOptions {
  configPath: string;
  agiPort: number;
  agiBind: string;
  /** Peer IPs allowed to open AGI sessions (normally just the PBX). */
  allowedPeers: string[];
  haTimeoutMs: number;
}

export interface SmartHomeModule {
  start(): Promise<void>;
  stop(): void;
}

export function createSmartHomeModule(opts: SmartHomeModuleOptions): SmartHomeModule {
  const config = loadSmartHomeConfig(opts.configPath);
  log.info(
    { accounts: config.accounts.length, configPath: opts.configPath },
    "Smart-home IVR config loaded",
  );

  const ivr = new SmartHomeIvr({
    config,
    ha: new HomeAssistantClient({ timeoutMs: opts.haTimeoutMs }),
    lockout: new PinLockout(),
    onEvent: (event, fields) => {
      if (event === "call_started") smarthomeCallsTotal.inc();
      if (event === "auth_failed" || event === "auth_locked_out") smarthomeAuthFailuresTotal.inc();
      if (event === "ha_action_ok") smarthomeHaActionsTotal.inc({ outcome: "ok" });
      if (event === "ha_action_failed") smarthomeHaActionsTotal.inc({ outcome: "failed" });
      log.debug({ event, ...fields }, "smarthome_ivr_event");
    },
  });

  const server = new AgiServer(
    { port: opts.agiPort, bindAddress: opts.agiBind, allowedPeers: opts.allowedPeers },
    (channel) => ivr.handleCall(channel),
  );

  return {
    start: () => server.start(),
    stop: () => server.stop(),
  };
}
