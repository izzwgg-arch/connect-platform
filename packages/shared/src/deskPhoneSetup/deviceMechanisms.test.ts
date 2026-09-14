/**
 * One answer per brand for "how is this phone cleared, restarted and given its settings".
 * Walks EVERY brand in the catalogue, with and without each maker cloud, so a new brand or a
 * new cloud cannot quietly change what happens to somebody's phone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deviceMechanismsFor } from "./deviceMechanisms";
import type { ProviderReadiness } from "./deviceIdentification";
import { vendorSupportsHttpActions, vendorSupportsPnpHandoff, VENDOR_ADAPTERS } from "./vendorAdapters";
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

test("a Grandstream with the maker cloud connected is cleared and restarted THROUGH the cloud", () => {
  const m = deviceMechanismsFor("Grandstream", [gdms(), rps]);
  assert.equal(m.brand, "grandstream");
  assert.equal(m.reset, "vendor_cloud");
  assert.equal(m.restart, "vendor_cloud");
  assert.equal(m.settings, "pnp");
  assert.equal(m.cloudPlatform, "gdms");
  assert.equal(m.cloudClaimNeedsSerial, true);
});

test("the same Grandstream without the cloud is honest: no remote clear, a power-cycle restart", () => {
  for (const readiness of [[], [gdms({ cloudConfigured: false })], [gdms({ supportedActions: ["lookup"] })]]) {
    const m = deviceMechanismsFor("grandstream", readiness);
    assert.equal(m.reset, "not_available", JSON.stringify(readiness));
    assert.equal(m.restart, "power_cycle");
    assert.equal(m.cloudPlatform, null);
  }
});

test("a cloud that can restart but not clear restarts through the cloud and clears nothing", () => {
  const m = deviceMechanismsFor("grandstream", [gdms({ supportedActions: ["lookup", "claim", "reboot"] })]);
  assert.equal(m.reset, "not_available");
  assert.equal(m.restart, "vendor_cloud");
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
      // ⛔ An office-network wipe exists for Yealink alone.
      if (m.reset === "lan_http") assert.equal(brand, "yealink");
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
