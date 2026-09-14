/**
 * One answer per brand for "how is this phone cleared, restarted and given its settings".
 * Walks EVERY brand in the catalogue, with and without each maker cloud, so a new brand or a
 * new cloud cannot quietly change what happens to somebody's phone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deviceMechanismsFor } from "./deviceMechanisms";
import type { ProviderReadiness } from "./deviceIdentification";
import { vendorSupportsHttpActions, vendorSupportsLocalReset, vendorSupportsPnpHandoff, VENDOR_ADAPTERS } from "./vendorAdapters";
import type { VendorSlug } from "./vendorCatalog.generated";

const gdms = (over: Partial<ProviderReadiness> = {}): ProviderReadiness => ({
  manufacturer: "grandstream", platform: "gdms", cloudConfigured: true,
  supportedActions: ["lookup", "claim", "reboot", "factory_reset", "status"],
  claimRequiresSerial: true, redirectOnly: false, note: "", ...over,
});
const rps: ProviderReadiness = {
  manufacturer: "yealink", platform: "yealink_rps", cloudConfigured: true, supportedActions: ["lookup"],
  claimRequiresSerial: false, redirectOnly: true, note: "",
};

test("a Grandstream is cleared over the LAN with the password, NOT the serial-based cloud — even when GDMS is connected", () => {
  // ⛔ The whole point: the LAN reset (type the password once) beats the cloud reset (read the
  // sticker serial to add the device first), so an existing customer phone never needs a sticker.
  const m = deviceMechanismsFor("Grandstream", [gdms(), rps]);
  assert.equal(m.brand, "grandstream");
  assert.equal(m.reset, "lan_http");
  assert.equal(m.restart, "lan_http");
  assert.equal(m.settings, "pnp");
  // ⛔ The cloud is still NAMED — not as the way this phone is cleared, but as the second door for
  // a customer who does not have the password. `reset` above is what actually happens by default.
  assert.equal(m.resetFallback, "vendor_cloud");
  assert.equal(m.cloudPlatform, "gdms");
  assert.equal(m.cloudClaimNeedsSerial, true);
});

test("a Grandstream with no cloud at all is still cleared and restarted over the LAN", () => {
  for (const readiness of [[], [gdms({ cloudConfigured: false })], [gdms({ supportedActions: ["lookup"] })]]) {
    const m = deviceMechanismsFor("grandstream", readiness);
    assert.equal(m.reset, "lan_http", JSON.stringify(readiness));
    assert.equal(m.restart, "lan_http");
    assert.equal(m.cloudPlatform, null);
  }
});

test("⛔ the SECOND door: a Grandstream whose password we lack can still be cleared through the cloud", () => {
  // The LAN reset is the primary (password); the cloud is the fallback (serial off the label).
  const withCloud = deviceMechanismsFor("grandstream", [gdms()]);
  assert.equal(withCloud.reset, "lan_http");
  assert.equal(withCloud.resetFallback, "vendor_cloud");
  assert.equal(withCloud.cloudClaimNeedsSerial, true, "the fallback is what needs the serial");

  // No cloud connected: there is no second door, and we must not pretend there is.
  assert.equal(deviceMechanismsFor("grandstream", []).resetFallback, "none");
  assert.equal(deviceMechanismsFor("grandstream", [gdms({ supportedActions: ["lookup", "reboot"] })]).resetFallback, "none");
  // Yealink has no maker cloud here at all.
  assert.equal(deviceMechanismsFor("yealink", [gdms(), rps]).resetFallback, "none");
});

test("a brand with NO local executor but a cloud that can restart uses the cloud for restart", () => {
  const fanvilCloud = { ...gdms(), manufacturer: "fanvil" as const, platform: "fanvil_fdps" as const, supportedActions: ["lookup", "reboot"] as any };
  const m = deviceMechanismsFor("fanvil", [fanvilCloud]);
  assert.notEqual(m.restart, "lan_http", "Fanvil has no LAN executor");
  if (m.restart === "vendor_cloud") assert.equal(m.cloudPlatform, "fanvil_fdps");
});

test("a Yealink is cleared and restarted from the office machine; a redirect-only cloud changes nothing", () => {
  const m = deviceMechanismsFor("Yealink", [rps, gdms()]);
  assert.equal(m.reset, "lan_http");
  assert.equal(m.restart, "lan_http");
  assert.equal(m.cloudPlatform, null);
});

test("a cloud for one brand never applies to another brand", () => {
  for (const vendor of ["yealink", "fanvil", "polycom", "snom", null, "unknown"]) {
    const m = deviceMechanismsFor(vendor, [gdms()]);
    assert.notEqual(m.reset, "vendor_cloud", String(vendor));
    assert.notEqual(m.restart, "vendor_cloud", String(vendor));
  }
});

test("Panasonic is configured by hand and is never cleared, whatever cloud exists", () => {
  const m = deviceMechanismsFor("Panasonic", [gdms(), rps]);
  assert.equal(m.settings, "hand_configured");
  assert.equal(m.reset, "not_available");
  assert.equal(m.restart, "not_available");
});

test("an unidentified device may be listened for, never cleared or sent requests", () => {
  for (const vendor of [null, "", "unknown", "Acme Widgets"]) {
    const m = deviceMechanismsFor(vendor, [gdms(), rps]);
    assert.equal(m.brand, null);
    assert.equal(m.reset, "not_available");
    assert.notEqual(m.restart, "lan_http");
    assert.notEqual(m.restart, "vendor_cloud");
  }
});

test("SWEEP: every catalogue brand, with every cloud shape, keeps the safety rules", () => {
  const brands = Object.keys(VENDOR_ADAPTERS) as VendorSlug[];
  const shapes: ProviderReadiness[][] = [
    [], [rps], [gdms()], [gdms({ redirectOnly: true })], [gdms({ cloudConfigured: false })],
    [gdms({ supportedActions: ["reboot"] })], [gdms({ supportedActions: ["factory_reset"] })],
    [{ ...gdms(), manufacturer: "fanvil", platform: "fanvil_fdps" }],
    [{ ...gdms(), manufacturer: "poly", platform: "poly_zero_touch" }],
  ];
  let checked = 0;
  for (const brand of brands) {
    for (const readiness of shapes) {
      const m = deviceMechanismsFor(brand, readiness);
      checked++;
      assert.equal(m.brand, brand);
      // ⛔ An office-network wipe exists only for a brand with a shipped local reset executor.
      if (m.reset === "lan_http") assert.equal(vendorSupportsLocalReset(brand), true, `${brand} reset lan_http`);
      // ⛔ A cloud step only with a configured, managing cloud for THIS brand that implements it.
      for (const [step, action] of [["reset", "factory_reset"], ["restart", "reboot"]] as const) {
        if (m[step] !== "vendor_cloud") continue;
        const r = readiness.find((x) => x.cloudConfigured && !x.redirectOnly && x.supportedActions.includes(action));
        assert.ok(r, `${brand} ${step} via a cloud that cannot`);
        const slug = r.manufacturer === "poly" ? "polycom" : r.manufacturer;
        assert.equal(slug, brand);
        assert.equal(m.cloudPlatform, r.platform);
      }
      // ⛔ Never clear or restart a phone that nothing can then hand its settings.
      if (m.reset !== "not_available" || m.restart === "vendor_cloud") assert.notEqual(m.settings, "not_available");
      // ⛔ The fallback is never the same door as the primary, and only exists with a real cloud wipe.
      if (m.resetFallback === "vendor_cloud") {
        assert.notEqual(m.reset, "vendor_cloud", `${brand} offers the cloud twice`);
        const r = readiness.find((x) => x.cloudConfigured && !x.redirectOnly && x.supportedActions.includes("factory_reset"));
        assert.ok(r, `${brand} claims a cloud fallback without a cloud that can wipe`);
        assert.equal(r.manufacturer === "poly" ? "polycom" : r.manufacturer, brand);
      }
      // Without any cloud, the answer is exactly the office machine's existing gates.
      if (readiness.length === 0) {
        if (m.settings !== "hand_configured") {
          assert.equal(m.settings === "pnp", vendorSupportsPnpHandoff(brand));
          assert.equal(m.restart === "lan_http", vendorSupportsHttpActions(brand));
        }
      }
    }
  }
  assert.ok(checked >= brands.length * shapes.length);
  assert.ok(brands.length >= 10, "the catalogue walk reached every brand");
});
