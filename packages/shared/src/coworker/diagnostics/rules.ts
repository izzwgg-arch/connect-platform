/**
 * The evidence-based diagnostic engine.
 *
 * ⛔⛔ THE RULE THIS FILE EXISTS TO ENFORCE: NEVER NAME A ROOT CAUSE WITHOUT THE
 * MEASUREMENTS THAT SUPPORT IT.
 *
 * This is not a theoretical concern here. This platform has already shipped a
 * confident, wrong diagnosis to a customer: an escalation report blamed a router's
 * SIP ALG and told the customer their internet was filtered, when the customer's
 * line was clean and a DIFFERENT extension was losing 37% of its packets. It
 * reasoned from call durations because it did not know `rtpStats` existed. The
 * customer denied the filtering claim and the registration history proved them
 * right. (docs/ai-context/AGENT_HANDOFF_TRIMPRO_105_AUDIO_2026-08-26.md)
 *
 * So every rule below states which measurements it REQUIRES. If they were not
 * taken, the rule cannot fire — it does not get to guess from the ones that were.
 * `diagnose()` returns `insufficient_evidence` rather than a plausible story, and
 * the test suite asserts that for every rule, in both directions.
 *
 * ⛔ Confidence is DERIVED from how many of a rule's supporting signals actually
 * agreed — never a number somebody typed because it felt right.
 */

import {
  countMeasurements, hasValue, type DiagnosticSignals, type Measured, type Symptom,
} from "./signals";

export type EvidenceItem = {
  label: string;
  /** Rendered value, already safe to show. */
  detail: string;
  /** Does this support the finding, or argue against it? */
  weight: "supports" | "contradicts" | "context";
  source: string;
};

export type Finding = {
  /** Stable id for the UI, the audit log and the support case. */
  id: string;
  /** Plain English, for a non-technical person. */
  title: string;
  /** 0–100, derived from agreeing evidence. */
  confidence: number;
  evidence: EvidenceItem[];
  /** What to do about it, in plain words. */
  recommendation: string;
  /**
   * A remediation the coworker could perform, if the user permits it.
   * ⛔ null means "there is nothing safe to automate here" — most causes.
   */
  safeRemediation: string | null;
};

export type DiagnosticResult = {
  symptom: Symptom;
  /** Ordered most-likely first. EMPTY when nothing could be established. */
  findings: Finding[];
  /** Checks that ran and what they said, for the report. */
  testsRun: number;
  /** ⛔ True when we could not responsibly name a cause. */
  inconclusive: boolean;
  /** Why it was inconclusive, or "" when it was not. */
  inconclusiveReason: string;
  /** Measurements a person should go and take next. */
  unanswered: string[];
};

/** Below this many successful measurements, no verdict is responsible. */
const MIN_MEASUREMENTS = 4;
/** A finding below this confidence is reported as a possibility, not a cause. */
const MIN_REPORTABLE_CONFIDENCE = 55;

/* ─────────────────────────── thresholds ────────────────────────── */

/**
 * ⛔ Thresholds are named constants, not inline numbers, because support staff
 * will ask "why did it say that" and the answer has to be quotable. Values are the
 * ones this platform's own investigations used.
 */
export const THRESHOLDS = {
  /** Above this, audio is audibly damaged. */
  packetLossBad: 5,
  packetLossSevere: 15,
  /** Above this, audio is choppy even at low loss. */
  jitterBad: 30,
  jitterSevere: 60,
  latencyBad: 250,
  /** More registrations than this in the window means the stack is rebuilding. */
  registrationChurn: 20,
  /** Below this, Wi-Fi is too weak for reliable call audio. */
  wifiWeak: 40,
  cpuPressure: 85,
  memoryPressure: 90,
  diskLow: 5,
} as const;

type RuleContext = {
  s: DiagnosticSignals;
  symptom: Symptom;
};

type Rule = {
  id: string;
  /**
   * ⛔ THE GATE. Every signal named here must have been measured or the rule is
   * skipped entirely. This is what makes "no evidence, no verdict" structural
   * rather than a habit.
   */
  requires: (s: DiagnosticSignals) => boolean;
  evaluate: (ctx: RuleContext) => Finding | null;
};

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}
function ev(label: string, detail: string, weight: EvidenceItem["weight"], m?: Measured<unknown>): EvidenceItem {
  return { label, detail, weight, source: m?.source ?? "diagnostic" };
}

/**
 * Derive a confidence from agreeing vs contradicting evidence.
 *
 * ⛔ Contradicting evidence REDUCES confidence rather than being dropped. A rule
 * that only counts what agrees with it is how you get 91%-confident nonsense.
 */
function confidenceFrom(evidence: EvidenceItem[], base: number): number {
  const supports = evidence.filter((e) => e.weight === "supports").length;
  const contradicts = evidence.filter((e) => e.weight === "contradicts").length;
  return clampConfidence(base + supports * 8 - contradicts * 22);
}

/**
 * ⛔ NOTHING IS EVER 100% CERTAIN, and a diagnostic that says so is lying. The
 * ceiling is what stops a rule with many agreeing signals rendering as absolute
 * fact to a customer.
 *
 * ⛔ Exported so it can be tested at its boundaries directly. It is deliberately
 * unreachable from today's rules (the most any of them can reach is 86) — which
 * means a test driving only `diagnose()` cannot exercise it, and a mutation that
 * deletes the clamp would survive unnoticed. That is exactly the kind of guard
 * that rots. Test the contract, not just the paths that happen to hit it.
 */
export function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 5;
  return Math.max(5, Math.min(96, Math.round(raw)));
}

/* ───────────────────────────── rules ───────────────────────────── */

const RULES: Rule[] = [
  /* ── VPN interference ── */
  {
    id: "vpn_interference",
    requires: (s) =>
      hasValue(s.network?.vpnActive) &&
      (hasValue(s.network?.packetLossPercent) || hasValue(s.network?.jitterMs)),
    evaluate: ({ s }) => {
      const net = s.network!;
      if (!net.vpnActive!.value) return null;

      const loss = net.packetLossPercent?.value ?? 0;
      const jitter = net.jitterMs?.value ?? 0;
      if (loss < THRESHOLDS.packetLossBad && jitter < THRESHOLDS.jitterBad) return null;

      const evidence: EvidenceItem[] = [
        ev("VPN", "A VPN is carrying your network traffic", "supports", net.vpnActive),
      ];
      if (hasValue(net.packetLossPercent) && loss >= THRESHOLDS.packetLossBad) {
        evidence.push(ev("Packet loss", pct(loss), "supports", net.packetLossPercent));
      }
      if (hasValue(net.jitterMs) && jitter >= THRESHOLDS.jitterBad) {
        evidence.push(ev("Jitter", `${Math.round(jitter)} ms`, "supports", net.jitterMs));
      }
      // ⛔ A healthy registration ARGUES FOR this cause, not against it: the signalling
      // is fine and only the media is damaged, which is what a VPN does.
      if (hasValue(s.loopcom?.sipRegistered) && s.loopcom!.sipRegistered!.value) {
        evidence.push(ev("Loopcom registration", "healthy", "context", s.loopcom!.sipRegistered));
      }

      return {
        id: "vpn_interference",
        title: "Your VPN is degrading call audio",
        confidence: confidenceFrom(evidence, 62),
        evidence,
        recommendation:
          "Try a call with the VPN switched off. If it clears up, ask whoever manages the VPN to let Loopcom traffic bypass it.",
        safeRemediation: null, // ⛔ never disable somebody's VPN automatically
      };
    },
  },

  /* ── plain network loss, no VPN ── */
  {
    id: "network_packet_loss",
    requires: (s) => hasValue(s.network?.packetLossPercent),
    evaluate: ({ s }) => {
      const net = s.network!;
      const loss = net.packetLossPercent!.value;
      if (loss < THRESHOLDS.packetLossBad) return null;
      // The VPN rule owns this case; do not double-report.
      if (hasValue(net.vpnActive) && net.vpnActive.value) return null;

      const evidence: EvidenceItem[] = [
        ev("Packet loss", pct(loss), "supports", net.packetLossPercent),
      ];
      if (hasValue(net.jitterMs) && net.jitterMs.value >= THRESHOLDS.jitterBad) {
        evidence.push(ev("Jitter", `${Math.round(net.jitterMs.value)} ms`, "supports", net.jitterMs));
      }
      if (hasValue(net.interfaceKind)) {
        const kind = net.interfaceKind.value;
        evidence.push(ev("Connection", kind, kind === "wifi" || kind === "cellular" ? "supports" : "context", net.interfaceKind));
      }
      if (hasValue(net.wifiSignalPercent) && net.wifiSignalPercent.value < THRESHOLDS.wifiWeak) {
        evidence.push(ev("Wi-Fi signal", pct(net.wifiSignalPercent.value), "supports", net.wifiSignalPercent));
      }

      const severe = loss >= THRESHOLDS.packetLossSevere;
      return {
        id: "network_packet_loss",
        title: severe ? "Your internet connection is losing a lot of call audio" : "Your internet connection is losing call audio",
        confidence: confidenceFrom(evidence, severe ? 70 : 58),
        evidence,
        recommendation:
          hasValue(net.interfaceKind) && net.interfaceKind.value === "wifi"
            ? "Try a wired connection, or move closer to the Wi-Fi access point, and test again."
            : "Test again on a different network. If it follows you, the connection itself needs attention.",
        safeRemediation: null,
      };
    },
  },

  /* ── filtered / proxied internet ── */
  {
    id: "filtered_internet",
    requires: (s) => hasValue(s.loopcom?.sipRegistrationCount),
    evaluate: ({ s }) => {
      const lc = s.loopcom!;
      const churn = lc.sipRegistrationCount!.value;
      if (churn < THRESHOLDS.registrationChurn) return null;

      const evidence: EvidenceItem[] = [
        ev("Reconnections", `${churn} in the last hour`, "supports", lc.sipRegistrationCount),
      ];
      if (hasValue(s.network?.proxyConfigured) && s.network!.proxyConfigured!.value) {
        evidence.push(ev("Proxy", "a network proxy is configured", "supports", s.network!.proxyConfigured));
      }
      if (hasValue(lc.registrationAgeSec) && lc.registrationAgeSec.value < 120) {
        evidence.push(ev("Current connection age", `${Math.round(lc.registrationAgeSec.value)}s`, "supports", lc.registrationAgeSec));
      }
      // ⛔ Contradiction: a stable interface means this is not roaming.
      if (hasValue(s.network?.interfaceChanges) && s.network!.interfaceChanges!.value === 0) {
        evidence.push(ev("Network changes", "none — the connection is not moving", "context", s.network!.interfaceChanges));
      }

      return {
        id: "filtered_internet",
        title: "Something on your network keeps dropping Loopcom's connection",
        confidence: confidenceFrom(evidence, 60),
        evidence,
        recommendation:
          "This usually means a content filter or firewall is closing the connection. Ask whoever manages the network to allow Loopcom through, and we can switch you to the port-443 route in the meantime.",
        safeRemediation: null,
      };
    },
  },

  /* ── not registered at all ── */
  {
    id: "not_registered",
    requires: (s) => hasValue(s.loopcom?.sipRegistered),
    evaluate: ({ s }) => {
      const lc = s.loopcom!;
      if (lc.sipRegistered!.value) return null;

      const evidence: EvidenceItem[] = [
        ev("Loopcom registration", "not registered", "supports", lc.sipRegistered),
      ];
      if (hasValue(lc.authValid) && !lc.authValid.value) {
        evidence.push(ev("Sign-in", "expired", "supports", lc.authValid));
      }
      if (hasValue(lc.sipTransportReachable) && !lc.sipTransportReachable.value) {
        evidence.push(ev("Connection to Loopcom", "blocked", "supports", lc.sipTransportReachable));
      }
      if (hasValue(s.network?.dnsResolves) && !s.network!.dnsResolves!.value) {
        evidence.push(ev("DNS", "not resolving", "supports", s.network!.dnsResolves));
      }
      // ⛔ Contradiction: if the API is reachable, the network is not the problem.
      if (hasValue(lc.apiReachable) && lc.apiReachable.value) {
        evidence.push(ev("Loopcom servers", "reachable", "contradicts", lc.apiReachable));
      }

      const authExpired = hasValue(lc.authValid) && !lc.authValid.value;
      return {
        id: "not_registered",
        title: authExpired ? "You are signed out of Loopcom" : "Loopcom cannot connect to the phone system",
        confidence: confidenceFrom(evidence, 72),
        evidence,
        recommendation: authExpired
          ? "Sign in again and calls will start working."
          : "Check the internet connection, then restart Loopcom. If it persists, a firewall is likely blocking it.",
        safeRemediation: authExpired ? null : "restart_loopcom_connection",
      };
    },
  },

  /* ── audio device wrong/missing ── */
  {
    id: "audio_device",
    requires: (s) => hasValue(s.audio?.microphonePresent) || hasValue(s.audio?.deviceMismatch),
    evaluate: ({ s }) => {
      const a = s.audio!;
      const missingMic = hasValue(a.microphonePresent) && !a.microphonePresent.value;
      const brokenMic = hasValue(a.microphoneWorking) && !a.microphoneWorking.value;
      const mismatch = hasValue(a.deviceMismatch) && a.deviceMismatch.value;
      if (!missingMic && !brokenMic && !mismatch) return null;

      const evidence: EvidenceItem[] = [];
      if (missingMic) evidence.push(ev("Microphone", "not found", "supports", a.microphonePresent));
      if (brokenMic) evidence.push(ev("Microphone", "found but not picking up sound", "supports", a.microphoneWorking));
      if (mismatch) {
        evidence.push(ev(
          "Audio device",
          `Windows is using ${a.defaultCommsDevice?.value ?? "a different device"}, Loopcom is set to ${a.loopcomSelectedDevice?.value ?? "another"}`,
          "supports", a.deviceMismatch,
        ));
      }

      return {
        id: "audio_device",
        title: missingMic || brokenMic ? "Your microphone is not working" : "Loopcom and Windows are using different audio devices",
        confidence: confidenceFrom(evidence, 74),
        evidence,
        recommendation: missingMic
          ? "Plug the headset back in, then pick it in Loopcom's audio settings."
          : "Pick the same device in Loopcom that Windows is using for calls.",
        safeRemediation: mismatch && !missingMic ? "match_audio_device" : null,
      };
    },
  },

  /* ── TURN / media relay unreachable ── */
  {
    id: "turn_unreachable",
    requires: (s) => hasValue(s.loopcom?.turnReachable),
    evaluate: ({ s }) => {
      const lc = s.loopcom!;
      if (lc.turnReachable!.value) return null;

      const evidence: EvidenceItem[] = [
        ev("Media relay", "cannot be reached", "supports", lc.turnReachable),
      ];
      if (hasValue(lc.iceOutcome) && lc.iceOutcome.value === "failed") {
        evidence.push(ev("Call media path", "failed to establish", "supports", lc.iceOutcome));
      }
      if (hasValue(s.system?.firewallRuleOk) && !s.system!.firewallRuleOk!.value) {
        evidence.push(ev("Windows Firewall", "Loopcom is not allowed through", "supports", s.system!.firewallRuleOk));
      }
      if (hasValue(lc.sipRegistered) && lc.sipRegistered.value) {
        evidence.push(ev("Loopcom registration", "healthy — signalling is fine", "context", lc.sipRegistered));
      }

      return {
        id: "turn_unreachable",
        title: "Call audio cannot get through this network",
        confidence: confidenceFrom(evidence, 66),
        evidence,
        recommendation:
          "Calls can connect but the audio has no route. A firewall is usually blocking it — the network's administrator needs to allow Loopcom's media traffic.",
        safeRemediation: hasValue(s.system?.firewallRuleOk) && !s.system!.firewallRuleOk!.value
          ? "repair_loopcom_firewall_rule"
          : null,
      };
    },
  },

  /* ── machine under pressure ── */
  {
    id: "system_pressure",
    requires: (s) => hasValue(s.system?.cpuLoadPercent) || hasValue(s.system?.memoryPressurePercent),
    evaluate: ({ s }) => {
      const sys = s.system!;
      const cpu = sys.cpuLoadPercent?.value ?? 0;
      const mem = sys.memoryPressurePercent?.value ?? 0;
      if (cpu < THRESHOLDS.cpuPressure && mem < THRESHOLDS.memoryPressure) return null;

      const evidence: EvidenceItem[] = [];
      if (cpu >= THRESHOLDS.cpuPressure) evidence.push(ev("Processor load", pct(cpu), "supports", sys.cpuLoadPercent));
      if (mem >= THRESHOLDS.memoryPressure) evidence.push(ev("Memory in use", pct(mem), "supports", sys.memoryPressurePercent));
      if (hasValue(sys.uptimeHours) && sys.uptimeHours.value > 240) {
        evidence.push(ev("Time since restart", `${Math.round(sys.uptimeHours.value / 24)} days`, "supports", sys.uptimeHours));
      }
      // ⛔ Contradiction: a clean network makes this the likelier explanation, but a
      // damaged one means we are probably looking at the wrong thing.
      if (hasValue(s.network?.packetLossPercent) && s.network!.packetLossPercent!.value >= THRESHOLDS.packetLossBad) {
        evidence.push(ev("Packet loss", pct(s.network!.packetLossPercent!.value), "contradicts", s.network!.packetLossPercent));
      }

      return {
        id: "system_pressure",
        title: "This computer is too busy to handle call audio smoothly",
        confidence: confidenceFrom(evidence, 58),
        evidence,
        recommendation: "Close what you are not using and restart the computer, then test a call.",
        safeRemediation: null,
      };
    },
  },

  /* ── outdated client ── */
  {
    id: "outdated_client",
    requires: (s) => hasValue(s.loopcom?.updateAvailable),
    evaluate: ({ s }) => {
      const lc = s.loopcom!;
      if (!lc.updateAvailable!.value) return null;
      const evidence: EvidenceItem[] = [
        ev("Loopcom version", `${lc.appVersion?.value ?? "older build"} — an update is available`, "supports", lc.updateAvailable),
      ];
      return {
        id: "outdated_client",
        title: "Loopcom is out of date on this computer",
        // ⛔ Deliberately LOW. An available update is rarely THE cause, and reporting
        // it confidently sends people to install an update that changes nothing.
        confidence: confidenceFrom(evidence, 32),
        evidence,
        recommendation: "Install the update — several call-quality fixes ship in newer builds — then test again.",
        safeRemediation: "install_loopcom_update",
      };
    },
  },
];

/* ─────────────────────────── the engine ────────────────────────── */

/**
 * Run every rule whose evidence exists, and rank what survives.
 *
 * ⛔ RETURNS `inconclusive` RATHER THAN A STORY. Three separate ways to end up
 * there, all of them deliberate:
 *   - too few measurements succeeded at all
 *   - no rule's required signals were present
 *   - rules fired but none reached a reportable confidence
 * A support engineer reading "we could not establish this, here is what to measure
 * next" is far better served than one reading a confident guess.
 */
export function diagnose(signals: DiagnosticSignals, symptom: Symptom = "unknown"): DiagnosticResult {
  const measurements = countMeasurements(signals);
  const unanswered: string[] = [];

  if (measurements < MIN_MEASUREMENTS) {
    return {
      symptom,
      findings: [],
      testsRun: measurements,
      inconclusive: true,
      inconclusiveReason:
        "Not enough checks completed to say anything responsibly. Run the diagnostic again with Loopcom open.",
      unanswered: ["network quality", "Loopcom registration", "audio devices"],
    };
  }

  const findings: Finding[] = [];
  let rulesEligible = 0;

  for (const rule of RULES) {
    if (!rule.requires(signals)) {
      unanswered.push(rule.id);
      continue;
    }
    rulesEligible++;
    const f = rule.evaluate({ s: signals, symptom });
    if (f) findings.push(f);
  }

  findings.sort((a, b) => b.confidence - a.confidence);

  const reportable = findings.filter((f) => f.confidence >= MIN_REPORTABLE_CONFIDENCE);

  if (rulesEligible === 0) {
    return {
      symptom, findings: [], testsRun: measurements, inconclusive: true,
      inconclusiveReason: "None of the checks that could explain this were able to run.",
      unanswered,
    };
  }

  if (reportable.length === 0) {
    return {
      symptom,
      // ⛔ Low-confidence findings are still RETURNED — as possibilities, clearly
      // below the reportable bar — because throwing them away loses the only leads
      // there are. `inconclusive` is what stops the UI presenting one as the answer.
      findings,
      testsRun: measurements,
      inconclusive: true,
      inconclusiveReason:
        findings.length > 0
          ? "Nothing measured strongly enough to name a cause. The possibilities below are worth checking, but none is established."
          : "Everything checked came back healthy, so the cause is not on this computer.",
      unanswered,
    };
  }

  return {
    symptom,
    findings,
    testsRun: measurements,
    inconclusive: false,
    inconclusiveReason: "",
    unanswered,
  };
}

/**
 * ⛔ The remediation gate. A finding may SUGGEST an automatic repair; this decides
 * whether it may actually run. Two hard rules:
 *   - never repair on an inconclusive diagnosis (you would be fixing a guess)
 *   - never repair below high confidence
 * Everything else is the ordinary permission system's job.
 */
export function remediationsFor(result: DiagnosticResult): string[] {
  if (result.inconclusive) return [];
  return result.findings
    .filter((f) => f.confidence >= 70 && f.safeRemediation)
    .map((f) => f.safeRemediation as string);
}
