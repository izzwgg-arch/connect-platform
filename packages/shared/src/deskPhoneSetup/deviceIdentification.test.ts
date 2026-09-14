/**
 * The identification pipeline and the capability rules behind the desk phone wizard.
 *
 * ⛔ Written through the editor, never a heredoc: control characters in test data are
 * built with String.fromCharCode so this file stays text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVISIONING_STATUSES,
  canonicalModel,
  capabilitiesFor,
  classifyDeviceType,
  cleanDeviceText,
  cleanSerialNumber,
  describeProvisioningStatus,
  deviceKindForType,
  identifyDevice,
  manufacturerFromModel,
  manufacturerFromOui,
  manufacturerFromText,
  mergeDiscoveryRecords,
  parseDeviceLabel,
  parseMacAddress,
  planDevicePreparation,
  provisioningStatusFor,
  type CloudDeviceState,
  type ProviderReadiness,
} from "./deviceIdentification";

const GRANDSTREAM_MAC = "c074ad8c605f";
const YEALINK_MAC = "805e0c4d796d";
const POLY_MAC = "0004f2aabbcc";
const FANVIL_OR_ATTIMO_MAC = "0c383e112233";

const gdmsReady: ProviderReadiness = {
  manufacturer: "grandstream",
  platform: "gdms",
  cloudConfigured: true,
  supportedActions: ["lookup", "claim", "reboot", "factory_reset", "reprovision", "status"],
  claimRequiresSerial: true,
  redirectOnly: false,
  note: "Grandstream cloud connected.",
};
const gdmsNotConfigured: ProviderReadiness = { ...gdmsReady, cloudConfigured: false, note: "Grandstream cloud is not connected yet." };
const managed: CloudDeviceState = { checked: true, found: true, managedByUs: true, ownedElsewhere: false, online: true };
const unclaimed: CloudDeviceState = { checked: true, found: false, managedByUs: false, ownedElsewhere: false, online: null };
const elsewhere: CloudDeviceState = { checked: true, found: true, managedByUs: false, ownedElsewhere: true, online: true };

/* ── hardware addresses ── */

test("every written form of one hardware address normalises to the same identity", () => {
  for (const form of ["C0:74:AD:8C:60:5F", "c0-74-ad-8c-60-5f", "c074ad8c605f", "C074AD8C605F", "c074.ad8c.605f", "  c0:74:ad:8c:60:5f "]) {
    const parsed = parseMacAddress(form);
    assert.ok(parsed, form);
    assert.equal(parsed.normalized, GRANDSTREAM_MAC, form);
    assert.equal(parsed.formatted, "C0:74:AD:8C:60:5F", form);
  }
});

test("typed text that merely contains hex is not a hardware address", () => {
  for (const junk of ["PHONE AB12 CD34 EF56", "c0:74-ad:8c:60:5f", "c074ad8c605", "ffffffffffff", "000000000000", "01005e000001", "", null, undefined, 42]) {
    assert.equal(parseMacAddress(junk), null, String(junk));
  }
});

/* ── manufacturer ── */

test("the MAC block names the manufacturer and nothing more", () => {
  assert.equal(manufacturerFromOui(GRANDSTREAM_MAC).manufacturer, "grandstream");
  assert.equal(manufacturerFromOui(YEALINK_MAC).manufacturer, "yealink");
  assert.equal(manufacturerFromOui(POLY_MAC).manufacturer, "poly");
  const shared = manufacturerFromOui(FANVIL_OR_ATTIMO_MAC);
  assert.equal(shared.manufacturer, "unknown", "a block claimed by two makers names neither");
  assert.ok(shared.candidates.length >= 2);
  const id = identifyDevice({ mac: GRANDSTREAM_MAC });
  assert.equal(id.manufacturer, "grandstream");
  assert.equal(id.model, null, "OUI must never produce a model");
  assert.equal(id.deviceType, "unknown");
  assert.equal(id.needsIdentifying, true);
  assert.equal(id.confidence, "low");
});

test("vendor text maps to our four manufacturers, other, or unknown — never a guess", () => {
  assert.equal(manufacturerFromText("Polycom"), "poly");
  assert.equal(manufacturerFromText("Poly"), "poly");
  assert.equal(manufacturerFromText("Grandstream Networks"), "grandstream");
  assert.equal(manufacturerFromText("Yealink"), "yealink");
  assert.equal(manufacturerFromText("Fanvil"), "fanvil");
  assert.equal(manufacturerFromText("snom technology AG"), "other");
  assert.equal(manufacturerFromText("Panasonic"), "other");
  assert.equal(manufacturerFromText("unknown"), "unknown");
  assert.equal(manufacturerFromText("Acme Widgets"), "unknown");
  assert.equal(manufacturerFromText(null), "unknown");
});

test("only a distinctive model prefix may name the manufacturer by itself", () => {
  assert.equal(manufacturerFromModel("GXP2170"), "grandstream");
  assert.equal(manufacturerFromModel("VVX 450"), "poly");
  assert.equal(manufacturerFromModel("Edge E350"), "poly");
  assert.equal(manufacturerFromModel("GDS3710"), "grandstream");
  assert.equal(manufacturerFromModel("T54W"), null, "a bare T-number is not distinctive");
  assert.equal(manufacturerFromModel("X4U"), null);
});

test("model strings are compared as one canonical token", () => {
  assert.equal(canonicalModel("Yealink SIP-T54W"), "T54W");
  assert.equal(canonicalModel("sip t46g"), "T46G");
  assert.equal(canonicalModel("Poly Edge E350"), "EDGEE350");
  assert.equal(canonicalModel("Grandstream GXP-2170"), "GXP2170");
  assert.equal(canonicalModel(""), null);
});

/* ── device types ── */

test("device types follow each maker's product families", () => {
  const cases: Array<[string, string, string]> = [
    ["grandstream", "GXP2170", "desk_phone"],
    ["grandstream", "GRP2612P", "desk_phone"],
    ["grandstream", "GXV3380", "video_phone"],
    ["grandstream", "HT812", "ata"],
    ["grandstream", "GDS3710", "door_phone"],
    ["grandstream", "GSC3510", "intercom"],
    ["grandstream", "GSC3505", "paging_device"],
    ["grandstream", "GAC2500", "conference_phone"],
    ["grandstream", "DP750", "cordless_base"],
    ["grandstream", "GXW4216", "gateway"],
    ["yealink", "SIP-T54W", "desk_phone"],
    ["yealink", "VP59", "video_phone"],
    ["yealink", "CP960", "conference_phone"],
    ["yealink", "W60B", "cordless_base"],
    ["fanvil", "X4U", "desk_phone"],
    ["fanvil", "i16SV", "intercom"],
    ["fanvil", "i64", "door_phone"],
    ["fanvil", "PA2", "paging_device"],
    ["poly", "VVX 450", "desk_phone"],
    ["poly", "CCX 600", "desk_phone"],
    ["poly", "Edge E350", "desk_phone"],
    ["poly", "Trio 8800", "conference_phone"],
    ["poly", "OBi300", "ata"],
    ["poly", "ATA 402", "ata"],
    ["poly", "VVX D230", "cordless_base"],
    ["poly", "VVX 1500", "video_phone"],
  ];
  for (const [maker, model, type] of cases) {
    assert.equal(classifyDeviceType(maker as never, model), type, `${maker} ${model}`);
  }
});

test("a model nobody recognises is unknown, never guessed", () => {
  assert.equal(classifyDeviceType("grandstream", "ZZ9000"), "unknown");
  assert.equal(classifyDeviceType("unknown", null), "unknown");
  assert.equal(classifyDeviceType("unknown", "GXV3380"), "video_phone", "a distinctive family still classifies");
});

test("every new type maps onto the older kinds the house rules speak", () => {
  assert.equal(deviceKindForType("video_phone"), "desk_phone");
  assert.equal(deviceKindForType("gateway"), "ata");
  assert.equal(deviceKindForType("intercom"), "doorbell");
  assert.equal(deviceKindForType("paging_device"), "pager");
  assert.equal(deviceKindForType("other_supported_endpoint"), "unknown");
});

/* ── the pipeline ── */

test("stronger evidence names the model; agreement raises confidence", () => {
  const sipOnly = identifyDevice({
    mac: GRANDSTREAM_MAC,
    ip: "192.168.6.172",
    evidence: [{ source: "sip_user_agent", manufacturer: "Grandstream", model: "GXP2170", firmware: "1.0.11.64" }],
  });
  assert.equal(sipOnly.model, "GXP2170");
  assert.equal(sipOnly.deviceType, "desk_phone");
  assert.equal(sipOnly.firmware, "1.0.11.64");
  assert.equal(sipOnly.ip, "192.168.6.172");
  assert.equal(sipOnly.confidence, "high");
  assert.ok(sipOnly.identificationSources.some((s) => s.source === "mac_oui"));
  assert.ok(sipOnly.identificationSources.some((s) => s.source === "sip_user_agent" && s.contributed.includes("model")));

  const twoSources = identifyDevice({
    mac: GRANDSTREAM_MAC,
    evidence: [
      { source: "sip_user_agent", model: "GXP2170" },
      { source: "http_device_api", model: "GXP2170" },
    ],
  });
  assert.equal(twoSources.confidence, "confirmed");
  assert.equal(twoSources.confidenceScore, 100);
});

test("disagreeing sources are recorded as conflicts and lower confidence", () => {
  const id = identifyDevice({
    mac: GRANDSTREAM_MAC,
    evidence: [
      { source: "sip_user_agent", manufacturer: "Grandstream", model: "GXP2170" },
      { source: "pbx_provisioning_record", manufacturer: "Yealink", model: "T46U" },
    ],
  });
  assert.equal(id.manufacturer, "grandstream");
  assert.equal(id.model, "GXP2170", "the device's own words beat a stale record");
  assert.ok(id.conflicts.some((c) => c.code === "manufacturer_disagrees"));
  assert.ok(id.conflicts.some((c) => c.code === "model_disagrees"));
  assert.equal(id.confidence, "medium");
});

test("evidence about a DIFFERENT hardware address is refused, never applied", () => {
  const id = identifyDevice({
    mac: GRANDSTREAM_MAC,
    evidence: [{ source: "barcode_label", mac: YEALINK_MAC, model: "T54W", manufacturer: "Yealink", serialNumber: "ABCDE12345" }],
  });
  assert.equal(id.model, null);
  assert.equal(id.serialNumber, null);
  assert.equal(id.manufacturer, "grandstream");
  assert.ok(id.conflicts.some((c) => c.code === "evidence_for_different_mac"));
});

test("a caller cannot inject its own OUI claim", () => {
  const id = identifyDevice({ mac: GRANDSTREAM_MAC, evidence: [{ source: "mac_oui", manufacturer: "Yealink" }] });
  assert.equal(id.manufacturer, "grandstream");
  assert.equal(id.identificationSources.filter((s) => s.source === "mac_oui").length, 1);
});

test("an unreadable hardware address yields an invalid identification", () => {
  const id = identifyDevice({ mac: "not-a-mac", evidence: [{ source: "sip_user_agent", model: "GXP2170" }] });
  assert.equal(id.valid, false);
  assert.equal(id.mac, null);
  assert.equal(id.model, null);
});

test("device-supplied text is bounded and scrubbed of control and bidi characters", () => {
  const nul = String.fromCharCode(0);
  const rlo = String.fromCharCode(0x202e);
  const cr = String.fromCharCode(13);
  const dirty = `GXP${nul}2170${rlo}${cr}` + "x".repeat(200);
  const clean = cleanDeviceText(dirty, 40) ?? "";
  assert.ok(clean.length <= 40);
  for (const ch of clean) assert.ok(ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 0x202e);
  assert.equal(cleanSerialNumber("20ez115n308c605f"), "20EZ115N308C605F");
  assert.equal(cleanSerialNumber("ab"), null);
  assert.equal(cleanSerialNumber("bad serial!"), null);
});

/* ── capabilities ── */

test("cloud capabilities are true only when the provider is configured and holds the device", () => {
  const caps = capabilitiesFor({ manufacturer: "grandstream", model: "GXP2170", deviceType: "desk_phone", readiness: gdmsReady, cloud: managed });
  assert.equal(caps.canClaim, true);
  assert.equal(caps.canCloudManage, true);
  assert.equal(caps.canReboot, true);
  assert.equal(caps.canFactoryReset, true);
  // Both paths: the maker cloud AND the local Grandstream reset executor (login → RESET).
  assert.deepEqual(caps.paths.canFactoryReset, ["vendor_cloud", "local_http"]);
  assert.equal(caps.requiresSerialToClaim, true);
  assert.equal(caps.supportsZeroTouch, true);
  assert.equal(caps.canAssignSip, true, "GXP2170 has a PBX settings profile");
  assert.equal(caps.canPushConfig, false, "push_config was not in the provider's action list");
  assert.equal(caps.canUpdateFirmware, false);
});

test("an unconfigured CLOUD grants no cloud powers, but the local Grandstream executor still can", () => {
  const caps = capabilitiesFor({ manufacturer: "grandstream", model: "GXP2170", deviceType: "desk_phone", readiness: gdmsNotConfigured, cloud: managed });
  // The maker cloud is off, so nothing cloud-shaped is granted…
  assert.equal(caps.canClaim, false);
  assert.equal(caps.canCloudManage, false);
  assert.ok(!caps.paths.canReboot?.includes("vendor_cloud"));
  assert.ok(!caps.paths.canFactoryReset?.includes("vendor_cloud"));
  // …but restart and reset still work over the LAN with the customer's password.
  assert.equal(caps.canReboot, true);
  assert.deepEqual(caps.paths.canReboot, ["local_http"]);
  assert.equal(caps.canFactoryReset, true);
  assert.deepEqual(caps.paths.canFactoryReset, ["local_http"]);
  assert.ok(caps.notes.includes(gdmsNotConfigured.note));
});

test("a device held by another cloud account can never be claimed", () => {
  const caps = capabilitiesFor({ manufacturer: "grandstream", model: "GXP2170", deviceType: "desk_phone", readiness: gdmsReady, cloud: elsewhere });
  assert.equal(caps.canClaim, false);
  assert.equal(caps.canCloudManage, false);
});

test("readiness for a different manufacturer is ignored", () => {
  const caps = capabilitiesFor({ manufacturer: "yealink", model: "T54W", deviceType: "desk_phone", readiness: gdmsReady, cloud: managed });
  assert.equal(caps.canClaim, false);
  assert.equal(caps.canCloudManage, false);
  assert.equal(caps.canReboot, true, "Yealink still has the local executor");
  assert.deepEqual(caps.paths.canReboot, ["local_http"]);
  assert.equal(caps.requiresLocalAuth, true);
});

test("a redirect-only service never counts as managing the device", () => {
  const rps: ProviderReadiness = {
    manufacturer: "yealink", platform: "yealink_rps", cloudConfigured: true,
    supportedActions: ["lookup", "claim"], claimRequiresSerial: false, redirectOnly: true, note: "RPS",
  };
  const caps = capabilitiesFor({ manufacturer: "yealink", model: "T54W", deviceType: "desk_phone", readiness: rps, cloud: managed });
  assert.equal(caps.canClaim, true);
  assert.equal(caps.canCloudManage, false);
  assert.equal(caps.requiresSerialToClaim, false);
});

test("an unidentified device gets no speaking capability and no SIP profile", () => {
  const caps = capabilitiesFor({ manufacturer: "unknown", model: null, deviceType: "unknown" });
  assert.equal(caps.canReboot, false);
  assert.equal(caps.canFactoryReset, false);
  assert.equal(caps.canAssignSip, false);
  assert.equal(caps.canClaim, false);
});

/* ── status words ── */

test("the thirteen provisioning statuses are distinct and all have plain words", () => {
  assert.equal(PROVISIONING_STATUSES.length, 13);
  assert.equal(new Set(PROVISIONING_STATUSES).size, 13);
  const words = PROVISIONING_STATUSES.map(describeProvisioningStatus);
  assert.equal(new Set(words).size, 13);
  for (const w of words) assert.ok(w.length > 0);
});

test("online comes only from registration", () => {
  assert.equal(provisioningStatusFor({ phoneState: "REGISTERED" }), "online");
  assert.equal(provisioningStatusFor({ phoneState: "WAITING_FOR_REGISTRATION", vendorCloudState: "managed" }), "registering");
  assert.equal(provisioningStatusFor({ phoneState: "PROVISIONING" }), "provisioning");
  assert.equal(provisioningStatusFor({ phoneState: "WAITING_FOR_REBOOT" }), "rebooting");
  assert.equal(provisioningStatusFor({ phoneState: "REDISCOVERED" }), "waiting_for_device");
  assert.equal(provisioningStatusFor({ phoneState: "PREPARING" }), "preparing");
  assert.equal(provisioningStatusFor({ phoneState: "FAILED" }), "failed");
  assert.equal(provisioningStatusFor({ phoneState: "NEEDS_ATTENTION" }), "manual_action_required");
  assert.equal(provisioningStatusFor({ phoneState: "NEEDS_ATTENTION", vendorCloudState: "conflict" }), "conflict");
  assert.equal(provisioningStatusFor({ phoneState: "ASSIGNED", vendorCloudState: "claiming" }), "claiming");
  assert.equal(provisioningStatusFor({ phoneState: "ASSIGNED", vendorCloudState: "managed" }), "managed");
  assert.equal(provisioningStatusFor({ phoneState: "DISCOVERED" }), "discovered");
  assert.equal(provisioningStatusFor({ phoneState: "IDENTIFIED", identityConfidence: "high" }), "identified");
});

/* ── duplicates ── */

test("one device per hardware address, newest address wins, earlier ones kept", () => {
  const merged = mergeDiscoveryRecords([
    { mac: "C0:74:AD:8C:60:5F", ip: "192.168.6.172", seenAt: 1, evidence: [{ source: "http_banner", model: "GXP2170" }] },
    { mac: "c074ad8c605f", ip: "192.168.6.190", seenAt: 2, evidence: [{ source: "http_banner", model: "GXP2170" }, { source: "sip_user_agent", model: "GXP2170" }] },
    { mac: YEALINK_MAC, ip: "192.168.6.170", seenAt: 1 },
    { mac: "garbage", ip: "192.168.6.1" },
  ]);
  assert.equal(merged.length, 2);
  const gs = merged.find((m) => m.mac === GRANDSTREAM_MAC);
  assert.ok(gs);
  assert.equal(gs.ip, "192.168.6.190");
  assert.deepEqual(gs.previousIps, ["192.168.6.172"]);
  assert.equal(gs.evidence.length, 2, "duplicate evidence is folded");
});

/* ── labels ── */

test("a scanned label yields the address, serial and model that are really on it", () => {
  const label = parseDeviceLabel("Grandstream GXP2170 MAC: C0:74:AD:8C:60:5F S/N: 20EZ115N308C605F");
  assert.equal(label.mac, GRANDSTREAM_MAC);
  assert.equal(label.serialNumber, "20EZ115N308C605F");
  assert.equal(label.model, "GXP2170");
  assert.equal(label.manufacturer, "grandstream");

  const bare = parseDeviceLabel("805E0C4D796D");
  assert.equal(bare.mac, YEALINK_MAC);
  assert.equal(bare.serialNumber, null);
  assert.equal(bare.model, null);

  const unreadable = parseDeviceLabel("PHONE AB12 CD34 EF56");
  assert.equal(unreadable.mac, null);
  assert.equal(unreadable.manufacturer, "unknown");
});

/* ── preparation ── */

function gsIdentification(serial: string | null, cloud: CloudDeviceState) {
  return identifyDevice({
    mac: GRANDSTREAM_MAC,
    evidence: [{ source: "sip_user_agent", model: "GXP2170", serialNumber: serial }],
    readiness: [gdmsReady],
    cloud,
  });
}

test("a device already registered to us is left alone", () => {
  const plan = planDevicePreparation({
    identification: gsIdentification("20EZ115N308C605F", managed), cloud: managed,
    ownership: "ours", registeredToUs: true, lockedByOtherProvider: true, resetAuthorized: true, resetAlreadyDone: false,
  });
  assert.equal(plan.status, "online");
  assert.deepEqual(plan.steps.map((s) => s.step), ["verify_registration"]);
});

test("a device another account holds is a conflict, never a claim", () => {
  const plan = planDevicePreparation({
    identification: gsIdentification("20EZ115N308C605F", elsewhere), cloud: elsewhere,
    ownership: "unknown", registeredToUs: false, lockedByOtherProvider: true, resetAuthorized: true, resetAlreadyDone: false,
  });
  assert.equal(plan.status, "conflict");
  assert.equal(plan.manualAction?.code, "device_ownership_conflict");
  assert.ok(!plan.steps.some((s) => s.step === "claim" || s.step === "factory_reset"));
});

test("a claim that needs a serial stops and asks for the label", () => {
  const plan = planDevicePreparation({
    identification: gsIdentification(null, unclaimed), cloud: unclaimed,
    ownership: "unclaimed", registeredToUs: false, lockedByOtherProvider: false, resetAuthorized: false, resetAlreadyDone: false,
  });
  assert.equal(plan.status, "manual_action_required");
  assert.equal(plan.manualAction?.code, "serial_required");
});

test("RESET FIRST: a ticked phone is cleared before it is re-pointed, even one the cloud already manages", () => {
  for (const lockedByOtherProvider of [true, false, null]) {
    const plan = planDevicePreparation({
      identification: gsIdentification("20EZ115N308C605F", managed), cloud: managed,
      ownership: "ours", registeredToUs: false, lockedByOtherProvider, resetAuthorized: true, resetAlreadyDone: false,
    });
    const order = plan.steps.map((s) => s.step);
    assert.equal(plan.resetNeeded, true);
    assert.ok(order.includes("factory_reset"), JSON.stringify(order));
    assert.ok(order.indexOf("factory_reset") < order.indexOf("reprovision"), JSON.stringify(order));
    assert.ok(order.indexOf("factory_reset") < order.indexOf("assign_sip"), JSON.stringify(order));
  }
});

test("once its one reset is spent, the phone is re-pointed and restarted, never cleared again", () => {
  const plan = planDevicePreparation({
    identification: gsIdentification("20EZ115N308C605F", managed), cloud: managed,
    ownership: "ours", registeredToUs: false, lockedByOtherProvider: true, resetAuthorized: true, resetAlreadyDone: true,
  });
  assert.equal(plan.resetNeeded, false);
  assert.ok(!plan.steps.some((s) => s.step === "factory_reset"));
  assert.ok(plan.steps.some((s) => s.step === "reprovision" && s.via === "vendor_cloud"));
  assert.ok(plan.steps.some((s) => s.step === "verify_registration"));
});

test("a Yealink is reset only once it is ticked, locked or not", () => {
  const id = identifyDevice({ mac: YEALINK_MAC, evidence: [{ source: "sip_user_agent", model: "T54W" }] });
  for (const lockedByOtherProvider of [true, false]) {
    const waiting = planDevicePreparation({
      identification: id, ownership: "unclaimed", registeredToUs: false, lockedByOtherProvider, resetAuthorized: false, resetAlreadyDone: false,
    });
    assert.equal(waiting.manualAction?.code, "reset_authorization_required");
    assert.equal(waiting.resetNeeded, true);
    assert.ok(!waiting.steps.some((s) => s.step === "factory_reset"));

    const approved = planDevicePreparation({
      identification: id, ownership: "unclaimed", registeredToUs: false, lockedByOtherProvider, resetAuthorized: true, resetAlreadyDone: false,
    });
    assert.ok(approved.steps.some((s) => s.step === "factory_reset" && s.via === "local_http"));
  }
});

test("a phone nothing can reset over the network is handed to a person to reset once", () => {
  // ⛔ Poly has a settings profile (PnP) but no shipped reset executor and no maker cloud here,
  // so it is the brand that genuinely cannot be cleared from the network. (Grandstream and Yealink
  // both CAN now, over the LAN with the password.)
  const id = identifyDevice({ mac: POLY_MAC, evidence: [{ source: "sip_user_agent", model: "VVX411", manufacturer: "Polycom" }] });
  const plan = planDevicePreparation({
    identification: id, ownership: "unclaimed", registeredToUs: false, lockedByOtherProvider: false, resetAuthorized: true, resetAlreadyDone: false,
  });
  assert.equal(plan.manualAction?.code, "reset_needs_hands_on");
});

test("a Grandstream is now reset over the LAN once ticked, no serial and no maker cloud needed", () => {
  const id = identifyDevice({ mac: GRANDSTREAM_MAC, evidence: [{ source: "sip_user_agent", model: "GXP2170" }] });
  const plan = planDevicePreparation({
    identification: id, ownership: "unclaimed", registeredToUs: false, lockedByOtherProvider: false, resetAuthorized: true, resetAlreadyDone: false,
  });
  assert.ok(plan.steps.some((s) => s.step === "factory_reset" && s.via === "local_http"), JSON.stringify(plan));
});

test("SWEEP: a factory reset is planned only for a ticked, unregistered phone we may touch, never twice, never before a settings profile exists", () => {
  const ownerships = ["ours", "unclaimed", "other_tenant", "other_vendor_account", "unknown"] as const;
  const clouds = [managed, unclaimed, elsewhere, { checked: false, found: null, managedByUs: null, ownedElsewhere: null, online: null }];
  const devices = [
    (c: CloudDeviceState) => gsIdentification("20EZ115N308C605F", c),
    (c: CloudDeviceState) => gsIdentification(null, c),
    () => identifyDevice({ mac: YEALINK_MAC, evidence: [{ source: "sip_user_agent", model: "T54W" }] }),
    () => identifyDevice({ mac: POLY_MAC }),
    () => identifyDevice({ mac: "not-a-mac" }),
  ];
  let checked = 0;
  for (const ownership of ownerships)
    for (const cloud of clouds)
      for (const makeId of devices)
        for (const registeredToUs of [true, false])
          for (const lockedByOtherProvider of [true, false, null])
            for (const resetAuthorized of [true, false])
              for (const resetAlreadyDone of [true, false]) {
                const identification = makeId(cloud);
                const plan = planDevicePreparation({ identification, cloud, ownership, registeredToUs, lockedByOtherProvider, resetAuthorized, resetAlreadyDone });
                const order = plan.steps.map((s) => s.step);
                const resets = order.includes("factory_reset");
                checked++;
                if (!resets) continue;
                assert.equal(resetAuthorized, true);
                assert.equal(resetAlreadyDone, false);
                assert.equal(registeredToUs, false);
                assert.ok(ownership !== "other_tenant" && ownership !== "other_vendor_account");
                assert.notEqual(cloud.ownedElsewhere, true);
                assert.equal(identification.capabilities.canAssignSip, true);
                // Reset FIRST: nothing that hands the phone its settings comes before it.
                for (const later of ["reprovision", "reboot", "assign_sip"] as const) {
                  if (order.includes(later)) assert.ok(order.indexOf("factory_reset") < order.indexOf(later));
                }
              }
  assert.ok(checked > 2000);
});
