/**
 * Diagnostic engine — driven against the faults this platform has really seen.
 *
 * ⛔ The most important tests here are the NEGATIVE ones: that the engine refuses
 * to name a cause it cannot evidence, and that it does not blame the customer's
 * network when the customer's network was never measured. That exact failure has
 * already reached a real customer once (Trimpro, 2026-08-26).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { measured, countMeasurements, type DiagnosticSignals } from "./signals";
import { diagnose, remediationsFor, clampConfidence, THRESHOLDS } from "./rules";

const src = "test";
const m = <T>(v: T) => measured(v, src);

/* ═════════════════ the "no evidence, no verdict" rule ════════════ */

test("REFUSES a verdict when almost nothing could be measured", () => {
  const r = diagnose({ network: { packetLossPercent: m(40) } }, "audio_quality");
  assert.equal(r.inconclusive, true);
  assert.equal(r.findings.length, 0);
  assert.match(r.inconclusiveReason, /Not enough checks/i);
});

test("REFUSES to blame the network when the network was never measured", () => {
  // ⛔ The Trimpro failure, as a test. Plenty of signals, none of them network.
  const s: DiagnosticSignals = {
    loopcom: { sipRegistered: m(true), apiReachable: m(true), appVersion: m("0.1.16"), updateAvailable: m(false) },
    audio: { microphonePresent: m(true), microphoneWorking: m(true), speakerPresent: m(true) },
  };
  const r = diagnose(s, "audio_quality");
  const blamesNetwork = r.findings.some((f) => f.id === "network_packet_loss" || f.id === "vpn_interference");
  assert.equal(blamesNetwork, false, "must not invent a network cause from no network data");
});

test("everything healthy reads as inconclusive, not as a cause", () => {
  const s: DiagnosticSignals = {
    network: { packetLossPercent: m(0.2), jitterMs: m(6), vpnActive: m(false), dnsResolves: m(true), latencyMs: m(38) },
    loopcom: { sipRegistered: m(true), apiReachable: m(true), turnReachable: m(true), updateAvailable: m(false), sipRegistrationCount: m(2) },
    audio: { microphonePresent: m(true), microphoneWorking: m(true), deviceMismatch: m(false) },
    system: { cpuLoadPercent: m(22), memoryPressurePercent: m(48), firewallRuleOk: m(true) },
  };
  const r = diagnose(s, "audio_quality");
  assert.equal(r.inconclusive, true);
  assert.match(r.inconclusiveReason, /not on this computer/i);
});

/* ═════════════════════ the real fault scenarios ═════════════════ */

test("VPN interference is identified, and never auto-remediated", () => {
  const s: DiagnosticSignals = {
    network: { vpnActive: m(true), packetLossPercent: m(8.4), jitterMs: m(63), dnsResolves: m(true), interfaceKind: m("vpn") },
    loopcom: { sipRegistered: m(true), apiReachable: m(true) },
    audio: { microphonePresent: m(true), microphoneWorking: m(true) },
  };
  const r = diagnose(s, "audio_quality");
  assert.equal(r.inconclusive, false);
  assert.equal(r.findings[0].id, "vpn_interference");
  assert.ok(r.findings[0].confidence >= 70, `confidence was ${r.findings[0].confidence}`);
  // ⛔ Switching off somebody's VPN is never ours to do.
  assert.equal(r.findings[0].safeRemediation, null);
  assert.equal(remediationsFor(r).length, 0);
});

test("plain packet loss is reported when there is no VPN, and not double-reported when there is", () => {
  const base: DiagnosticSignals = {
    network: { packetLossPercent: m(12), jitterMs: m(40), interfaceKind: m("wifi"), wifiSignalPercent: m(28) },
    loopcom: { sipRegistered: m(true) },
    audio: { microphonePresent: m(true) },
  };
  const noVpn = diagnose({ ...base, network: { ...base.network, vpnActive: m(false) } }, "audio_quality");
  assert.ok(noVpn.findings.some((f) => f.id === "network_packet_loss"));

  const withVpn = diagnose({ ...base, network: { ...base.network, vpnActive: m(true) } }, "audio_quality");
  const ids = withVpn.findings.map((f) => f.id);
  assert.ok(ids.includes("vpn_interference"));
  assert.ok(!ids.includes("network_packet_loss"), "the same loss must not be reported twice");
});

test("filtered internet is recognised from reconnection churn", () => {
  const s: DiagnosticSignals = {
    network: { proxyConfigured: m(true), interfaceChanges: m(0), dnsResolves: m(true) },
    loopcom: { sipRegistrationCount: m(128), registrationAgeSec: m(33), sipRegistered: m(true) },
    audio: { microphonePresent: m(true) },
  };
  const r = diagnose(s, "calls_not_ringing");
  assert.equal(r.findings[0].id, "filtered_internet");
  assert.match(r.findings[0].recommendation, /filter|firewall/i);
});

test("an expired sign-in is named plainly, not as a network fault", () => {
  const s: DiagnosticSignals = {
    loopcom: { sipRegistered: m(false), authValid: m(false), apiReachable: m(true), turnReachable: m(true) },
    network: { dnsResolves: m(true), packetLossPercent: m(0.1) },
    audio: { microphonePresent: m(true) },
  };
  const r = diagnose(s, "cannot_make_calls");
  const top = r.findings[0];
  assert.equal(top.id, "not_registered");
  assert.match(top.title, /signed out/i);
  assert.equal(top.safeRemediation, null, "signing a user back in is not automatic");
});

test("a blocked transport is distinguished from an expired sign-in", () => {
  const s: DiagnosticSignals = {
    loopcom: { sipRegistered: m(false), authValid: m(true), sipTransportReachable: m(false), apiReachable: m(false) },
    network: { dnsResolves: m(true) },
    audio: { microphonePresent: m(true) },
    system: { firewallRuleOk: m(false) },
  };
  const r = diagnose(s, "cannot_make_calls");
  const top = r.findings[0];
  assert.equal(top.id, "not_registered");
  assert.doesNotMatch(top.title, /signed out/i);
});

test("a reachable API CONTRADICTS a connection fault and lowers confidence", () => {
  const blocked: DiagnosticSignals = {
    loopcom: { sipRegistered: m(false), sipTransportReachable: m(false), apiReachable: m(false), authValid: m(true) },
    network: { dnsResolves: m(true) }, audio: { microphonePresent: m(true) },
  };
  const contradicted: DiagnosticSignals = {
    loopcom: { sipRegistered: m(false), sipTransportReachable: m(false), apiReachable: m(true), authValid: m(true) },
    network: { dnsResolves: m(true) }, audio: { microphonePresent: m(true) },
  };
  const a = diagnose(blocked).findings.find((f) => f.id === "not_registered")!;
  const b = diagnose(contradicted).findings.find((f) => f.id === "not_registered")!;
  assert.ok(b.confidence < a.confidence, "contradicting evidence must reduce confidence");
});

test("a missing microphone is caught and is not confused with the network", () => {
  const s: DiagnosticSignals = {
    audio: { microphonePresent: m(false), speakerPresent: m(true) },
    loopcom: { sipRegistered: m(true), apiReachable: m(true) },
    network: { packetLossPercent: m(0.3), dnsResolves: m(true) },
  };
  const r = diagnose(s, "one_way_audio");
  assert.equal(r.findings[0].id, "audio_device");
  assert.match(r.findings[0].title, /microphone/i);
});

test("a device mismatch offers a safe automatic fix; a missing device does not", () => {
  const mismatch = diagnose({
    audio: { microphonePresent: m(true), microphoneWorking: m(true), deviceMismatch: m(true), defaultCommsDevice: m("Jabra"), loopcomSelectedDevice: m("Realtek") },
    loopcom: { sipRegistered: m(true) }, network: { dnsResolves: m(true) }, system: { cpuLoadPercent: m(20) },
  }, "one_way_audio");
  assert.equal(mismatch.findings[0].safeRemediation, "match_audio_device");

  const missing = diagnose({
    audio: { microphonePresent: m(false), deviceMismatch: m(true) },
    loopcom: { sipRegistered: m(true) }, network: { dnsResolves: m(true) }, system: { cpuLoadPercent: m(20) },
  }, "one_way_audio");
  assert.equal(missing.findings[0].safeRemediation, null, "we cannot plug a headset back in");
});

test("an unreachable media relay explains audio failing while calls still connect", () => {
  const s: DiagnosticSignals = {
    loopcom: { sipRegistered: m(true), turnReachable: m(false), iceOutcome: m("failed"), apiReachable: m(true) },
    system: { firewallRuleOk: m(false) },
    network: { dnsResolves: m(true) },
  };
  const r = diagnose(s, "one_way_audio");
  const top = r.findings[0];
  assert.equal(top.id, "turn_unreachable");
  assert.equal(top.safeRemediation, "repair_loopcom_firewall_rule");
});

test("system pressure is reported, but a damaged network outranks it", () => {
  const busyOnly = diagnose({
    system: { cpuLoadPercent: m(96), memoryPressurePercent: m(94), uptimeHours: m(500) },
    network: { packetLossPercent: m(0.2), dnsResolves: m(true) },
    loopcom: { sipRegistered: m(true) },
  }, "audio_quality");
  assert.ok(busyOnly.findings.some((f) => f.id === "system_pressure"));

  const busyAndLossy = diagnose({
    system: { cpuLoadPercent: m(96), memoryPressurePercent: m(94) },
    network: { packetLossPercent: m(14), jitterMs: m(50), vpnActive: m(false), dnsResolves: m(true) },
    loopcom: { sipRegistered: m(true) },
  }, "audio_quality");
  const net = busyAndLossy.findings.find((f) => f.id === "network_packet_loss")!;
  const sys = busyAndLossy.findings.find((f) => f.id === "system_pressure")!;
  assert.ok(net.confidence > sys.confidence, "contradicted system-pressure must rank below the real network fault");
});

test("an available update is a low-confidence footnote, never the headline", () => {
  const s: DiagnosticSignals = {
    loopcom: { updateAvailable: m(true), appVersion: m("0.1.3"), sipRegistered: m(true), apiReachable: m(true) },
    network: { packetLossPercent: m(0.4), dnsResolves: m(true), vpnActive: m(false) },
    audio: { microphonePresent: m(true) },
  };
  const r = diagnose(s, "audio_quality");
  const upd = r.findings.find((f) => f.id === "outdated_client");
  assert.ok(upd, "the update should still be surfaced");
  assert.ok(upd!.confidence < 55, `an update alone must not read as the cause (was ${upd!.confidence})`);
  assert.equal(r.inconclusive, true, "an update alone is not a diagnosis");
});

/* ═══════════════════════ remediation gate ═══════════════════════ */

test("REMEDIATION: nothing is auto-repaired on an inconclusive diagnosis", () => {
  const s: DiagnosticSignals = {
    loopcom: { updateAvailable: m(true), sipRegistered: m(true), apiReachable: m(true) },
    network: { dnsResolves: m(true), packetLossPercent: m(0.1) },
    audio: { microphonePresent: m(true) },
  };
  const r = diagnose(s, "audio_quality");
  assert.equal(r.inconclusive, true);
  assert.deepEqual(remediationsFor(r), [], "a guess must never trigger a repair");
});

test("REMEDIATION: the inconclusive guard holds even for a high-confidence finding", () => {
  // ⛔ Drives the CONTRACT, not a path diagnose() happens to produce. Today the
  // confidence floor makes this unreachable through diagnose(), so a test that only
  // called diagnose() would pass with the guard deleted — proven by mutation.
  const handBuilt = {
    symptom: "audio_quality" as const,
    findings: [{
      id: "fabricated", title: "x", confidence: 95, evidence: [],
      recommendation: "y", safeRemediation: "restart_loopcom_connection",
    }],
    testsRun: 9,
    inconclusive: true,
    inconclusiveReason: "deliberately inconclusive",
    unanswered: [],
  };
  assert.deepEqual(remediationsFor(handBuilt), [], "inconclusive must veto repairs outright");
});

test("REMEDIATION: a low-confidence finding is not repaired even when the diagnosis IS conclusive", () => {
  // VPN (86, no repair) + outdated client (40, has a repair). The result is
  // conclusive, so only the confidence floor stands between us and installing an
  // update because of a diagnosis that did not implicate it.
  const r = diagnose({
    network: { vpnActive: m(true), packetLossPercent: m(11), jitterMs: m(70), dnsResolves: m(true) },
    loopcom: { sipRegistered: m(true), updateAvailable: m(true), appVersion: m("0.1.1"), apiReachable: m(true) },
    audio: { microphonePresent: m(true) },
  }, "audio_quality");

  assert.equal(r.inconclusive, false, "scenario must be conclusive or it tests the wrong guard");
  const low = r.findings.find((f) => f.id === "outdated_client")!;
  assert.ok(low.confidence < 70, `precondition: outdated_client must be low (was ${low.confidence})`);
  assert.ok(
    !remediationsFor(r).includes("install_loopcom_update"),
    "a low-confidence finding must not trigger its repair",
  );
});

/* ═══════════════════════ report integrity ═══════════════════════ */

test("every finding cites at least one supporting measurement", () => {
  const scenarios: DiagnosticSignals[] = [
    { network: { vpnActive: m(true), packetLossPercent: m(9), jitterMs: m(40) }, loopcom: { sipRegistered: m(true) }, audio: { microphonePresent: m(true) } },
    { loopcom: { sipRegistered: m(false), authValid: m(false), apiReachable: m(true) }, network: { dnsResolves: m(true) }, audio: { microphonePresent: m(true) } },
    { audio: { microphonePresent: m(false) }, loopcom: { sipRegistered: m(true) }, network: { dnsResolves: m(true) }, system: { cpuLoadPercent: m(10) } },
  ];
  for (const s of scenarios) {
    for (const f of diagnose(s).findings) {
      assert.ok(
        f.evidence.some((e) => e.weight === "supports"),
        `${f.id} produced a finding with no supporting evidence`,
      );
      assert.ok(f.recommendation.length > 0, `${f.id} has no recommendation`);
    }
  }
});

test("findings are ordered most-confident first", () => {
  const s: DiagnosticSignals = {
    network: { vpnActive: m(true), packetLossPercent: m(11), jitterMs: m(70), dnsResolves: m(true) },
    loopcom: { sipRegistered: m(true), updateAvailable: m(true), appVersion: m("0.1.1"), apiReachable: m(true) },
    audio: { microphonePresent: m(true) },
    system: { cpuLoadPercent: m(30) },
  };
  const r = diagnose(s);
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(r.findings[i - 1].confidence >= r.findings[i].confidence, "findings must be ranked");
  }
});

test("clampConfidence holds the ceiling and floor at their boundaries", () => {
  // ⛔ Tested directly: no rule today can reach the ceiling, so driving diagnose()
  // alone would let a deleted clamp survive. Mutation testing caught exactly that.
  assert.equal(clampConfidence(500), 96, "nothing is ever more certain than 96%");
  assert.equal(clampConfidence(97), 96);
  assert.equal(clampConfidence(96), 96);
  assert.equal(clampConfidence(-40), 5, "confidence has a floor too");
  assert.equal(clampConfidence(0), 5);
  assert.equal(clampConfidence(62), 62);
  assert.equal(clampConfidence(NaN), 5, "an unusable number must not become a verdict");
  assert.equal(clampConfidence(Infinity), 5);
});

test("confidence never exceeds a sane ceiling, however much agrees", () => {
  const s: DiagnosticSignals = {
    network: { vpnActive: m(true), packetLossPercent: m(60), jitterMs: m(400), dnsResolves: m(true), interfaceKind: m("vpn"), proxyConfigured: m(true) },
    loopcom: { sipRegistered: m(true), apiReachable: m(true), sipRegistrationCount: m(300), registrationAgeSec: m(5) },
    audio: { microphonePresent: m(true) },
    system: { cpuLoadPercent: m(99), memoryPressurePercent: m(99) },
  };
  for (const f of diagnose(s).findings) {
    assert.ok(f.confidence <= 96, `${f.id} claimed ${f.confidence}% — nothing is that certain`);
  }
});

test("countMeasurements only counts values that were actually taken", () => {
  assert.equal(countMeasurements({}), 0);
  assert.equal(countMeasurements({ network: {} }), 0);
  assert.equal(countMeasurements({ network: { packetLossPercent: m(1), jitterMs: m(2) } }), 2);
});

test("thresholds are exported so support can quote why a verdict was reached", () => {
  assert.equal(typeof THRESHOLDS.packetLossBad, "number");
  assert.ok(THRESHOLDS.packetLossSevere > THRESHOLDS.packetLossBad);
  assert.ok(THRESHOLDS.jitterSevere > THRESHOLDS.jitterBad);
});
