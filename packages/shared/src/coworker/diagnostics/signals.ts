/**
 * What a Loopcom diagnostic MEASURES. Shapes only — no collection logic.
 *
 * ⛔⛔ EVERY FIELD IS OPTIONAL, AND THAT IS THE DESIGN. A diagnostic runs on a
 * customer's machine where any single probe can fail: no microphone, a firewall
 * that eats ICMP, an interface that vanished mid-run. A collector that must return
 * everything returns nothing the first time one probe throws.
 *
 * So a missing measurement is a first-class value here — `undefined` means "we did
 * not learn this", NOT "this was fine". The rules engine treats the two completely
 * differently, and that distinction is the whole reason this platform's previous
 * escalation reports were able to blame a customer's router without ever measuring
 * it (see the Trimpro handoff: "there is no per-call quality data" while 14 of 48
 * calls carried rtpStats).
 */

/** A measurement plus how it was obtained, so the report can cite its source. */
export type Measured<T> = {
  value: T;
  /** Where this came from — shown in the evidence list. */
  source: string;
  /** ms epoch. Stale evidence is weaker evidence. */
  at?: number;
};

export function measured<T>(value: T, source: string, at?: number): Measured<T> {
  return { value, source, at };
}

/** Network path quality, as seen from this machine. */
export type NetworkSignals = {
  /** 0–100. */
  packetLossPercent?: Measured<number>;
  /** ms. */
  jitterMs?: Measured<number>;
  /** ms round trip to the Loopcom edge. */
  latencyMs?: Measured<number>;
  /** Interface actually carrying the default route. */
  activeInterface?: Measured<string>;
  interfaceKind?: Measured<"ethernet" | "wifi" | "cellular" | "vpn" | "unknown">;
  /** True when a VPN adapter holds the default route. */
  vpnActive?: Measured<boolean>;
  /** True when a system proxy is configured for HTTP(S). */
  proxyConfigured?: Measured<boolean>;
  dnsResolves?: Measured<boolean>;
  /** Wi-Fi signal, 0–100. */
  wifiSignalPercent?: Measured<number>;
  /** How many times the default route changed during the observation window. */
  interfaceChanges?: Measured<number>;
};

/** Loopcom's own health on this machine. */
export type LoopcomSignals = {
  appVersion?: Measured<string>;
  /** True when a newer build is published. */
  updateAvailable?: Measured<boolean>;
  processRunning?: Measured<boolean>;
  /** SIP registration state as the PBX sees it, not as the client believes. */
  sipRegistered?: Measured<boolean>;
  /** Registrations observed in the window. High = churn. */
  sipRegistrationCount?: Measured<number>;
  /** Seconds the current registration has held. */
  registrationAgeSec?: Measured<number>;
  authValid?: Measured<boolean>;
  /** Can the client reach the Loopcom API at all. */
  apiReachable?: Measured<boolean>;
  /** Can the client reach a TURN relay. */
  turnReachable?: Measured<boolean>;
  /** Can the client open the SIP transport (ws/wss). */
  sipTransportReachable?: Measured<boolean>;
  /** ICE ended up relayed / direct / failed. */
  iceOutcome?: Measured<"direct" | "relay" | "failed">;
};

/** The audio subsystem. */
export type AudioSignals = {
  microphonePresent?: Measured<boolean>;
  microphoneWorking?: Measured<boolean>;
  speakerPresent?: Measured<boolean>;
  /** True when the OS default comms device differs from Loopcom's selection. */
  deviceMismatch?: Measured<boolean>;
  defaultCommsDevice?: Measured<string>;
  loopcomSelectedDevice?: Measured<string>;
};

/** Windows-side pressure that can starve real-time audio. */
export type SystemSignals = {
  osBuild?: Measured<string>;
  uptimeHours?: Measured<number>;
  cpuLoadPercent?: Measured<number>;
  memoryPressurePercent?: Measured<number>;
  diskFreePercent?: Measured<number>;
  /** True when Loopcom is excluded/allowed through the firewall as expected. */
  firewallRuleOk?: Measured<boolean>;
};

export type DiagnosticSignals = {
  network?: NetworkSignals;
  loopcom?: LoopcomSignals;
  audio?: AudioSignals;
  system?: SystemSignals;
};

/** The complaint that started this, in the user's own words. */
export type Symptom =
  | "audio_quality"      // "calls sound terrible", robotic, breaking up
  | "one_way_audio"
  | "calls_not_ringing"
  | "cannot_make_calls"
  | "dropped_calls"
  | "app_slow"
  | "unknown";

export function hasValue<T>(m: Measured<T> | undefined): m is Measured<T> {
  return m !== undefined && m.value !== undefined && m.value !== null;
}

/**
 * ⛔ Count how much we actually learned. The rules engine refuses to name a cause
 * when this is too low — "we ran two checks and both failed" must never render as
 * a confident verdict.
 */
export function countMeasurements(signals: DiagnosticSignals): number {
  let n = 0;
  for (const group of [signals.network, signals.loopcom, signals.audio, signals.system]) {
    if (!group) continue;
    for (const v of Object.values(group)) {
      if (hasValue(v as Measured<unknown>)) n++;
    }
  }
  return n;
}
