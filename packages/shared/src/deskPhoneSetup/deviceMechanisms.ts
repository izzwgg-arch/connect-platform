/**
 * HOW EACH BRAND IS CLEARED, RESTARTED AND GIVEN ITS SETTINGS — one answer, one place.
 *
 * ⛔⛔ Izzy, 2026-09-14: "The system should distinguish between different brand devices, so it
 * knows that, for the future, it would be rock solid for years to come." Until this file the
 * answer was scattered: the server asked `vendorSupportsPbxProvisioning`, the driver asked
 * `vendorSupportsHttpActions` and `vendorSupportsPnpHandoff`, and nothing asked whether the
 * maker's own cloud could do the step. A Grandstream ticked for setup was therefore told
 * "reset over the office network", which no computer can do for that brand, and it sat
 * waiting for a power-cycle nobody asked for — while the Grandstream cloud that CAN reset
 * and restart it was connected and never used.
 *
 * ⛔ The server decides with this and tells the office machine WHICH mechanism to use; the
 * driver never re-derives it. A new brand, or a new maker cloud, is a change here, and the
 * exhaustive test beside this file walks every brand in the catalogue.
 *
 * ⛔ Built ONLY from facts that already gate real actions — the adapters' shipped executors,
 * the PnP catalogue, and a cloud provider's readiness in THIS deployment (configured, not a
 * redirect-only service, the action implemented). Nothing is inferred from marketing.
 */

import type { CloudAction, ProviderReadiness, SupportedManufacturer } from "./deviceIdentification";
import { vendorSupportsPbxProvisioning } from "./deviceKinds";
import type { VendorSlug } from "./vendorCatalog.generated";
import { vendorSlugFor, vendorSupportsHttpActions, vendorSupportsLocalReset, vendorSupportsPnpHandoff } from "./vendorAdapters";

/** How a ticked phone is factory reset before it gets its settings (reset-first). */
export type ResetMechanism =
  /** The maker's cloud (Grandstream GDMS). Needs the device in Loopcom's cloud account. */
  | "vendor_cloud"
  /** An HTTP request from the office machine (Yealink's Action URI). Needs the phone's password. */
  | "lan_http"
  /** Nothing can clear this brand remotely: a person resets it by hand, or it is not cleared. */
  | "not_available";

/** How the phone is made to start up again so it asks for its settings. */
export type RestartMechanism = "vendor_cloud" | "lan_http" | "power_cycle" | "not_available";

/** How the phone learns where its Loopcom settings are. */
export type SettingsMechanism =
  /** The office machine answers the phone's own start-up request (SIP PnP). */
  | "pnp"
  /** The office machine writes the address into the phone's web interface. */
  | "lan_http"
  /** No provisioning template exists for this brand; a person types the SIP account in. */
  | "hand_configured"
  | "not_available";

export type DeviceMechanisms = {
  /** The catalogue brand, or null when the text named no brand we know. */
  brand: VendorSlug | null;
  reset: ResetMechanism;
  /**
   * The SECOND door, when the first one cannot be opened — or "none" when there is only one.
   *
   * ⛔⛔ The cloud reset needs the phone's SERIAL (to add the device to the maker's account) and the
   * LAN reset needs its ADMIN PASSWORD. The serial is the one the wizard asks for, once, on the
   * screen where the person is already looking at that phone — so the cloud is the primary door and
   * this names what is left if it cannot be used.
   */
  resetFallback: "lan_http" | "vendor_cloud" | "none";
  restart: RestartMechanism;
  settings: SettingsMechanism;
  /** Which maker cloud does the cloud steps, when any does. */
  cloudPlatform: ProviderReadiness["platform"] | null;
  /** The maker's cloud will not accept the device without the serial number off its label. */
  cloudClaimNeedsSerial: boolean;
};

/** The catalogue slug a cloud provider's manufacturer id stands for. */
function slugForManufacturer(m: SupportedManufacturer): VendorSlug | null {
  return vendorSlugFor(m === "poly" ? "polycom" : m);
}

export function deviceMechanismsFor(
  vendor: string | null | undefined,
  readiness: readonly ProviderReadiness[] = [],
): DeviceMechanisms {
  const brand = vendorSlugFor(vendor);

  // ⛔ A brand with no provisioning template (Panasonic) is configured by hand. It is never
  // cleared — a wipe erases the only configuration it can ever have.
  if (!vendorSupportsPbxProvisioning(vendor)) {
    return {
      brand, reset: "not_available", resetFallback: "none", restart: "not_available",
      settings: "hand_configured", cloudPlatform: null, cloudClaimNeedsSerial: false,
    };
  }

  const http = vendorSupportsHttpActions(vendor);
  const pnp = vendorSupportsPnpHandoff(vendor);
  const settings: SettingsMechanism = pnp ? "pnp" : http ? "lan_http" : "not_available";

  // ⛔ A cloud only counts when it is configured here, can manage (not redirect-only), and is
  // for THIS brand. And it never clears or restarts a phone nothing can then hand its settings.
  const cloud = brand
    ? readiness.find((r) => r.cloudConfigured && !r.redirectOnly && slugForManufacturer(r.manufacturer) === brand) ?? null
    : null;
  const cloudDoes = (a: CloudAction) => Boolean(cloud && settings !== "not_available" && cloud.supportedActions.includes(a));

  // ⛔⛔ THE MAKER CLOUD WINS, BECAUSE IT DOES NOT ASK FOR A PASSWORD (Izzy, 2026-09-14: "I don't
  // want it to ask for the password"). Both doors clear a phone: the cloud needs the device added
  // to the maker's account, which needs the SERIAL off its label — a thing the customer is now
  // asked for once, up front, on the same screen where they choose who sits at the phone. The LAN
  // reset needs the phone's admin password, which most people do not have and which the wizard
  // used to demand mid-setup. So the cloud is the primary door and the password is only a fallback
  // for a brand with no cloud at all. Both are gated on a settings profile existing, so a phone we
  // cannot configure afterwards is never wiped.
  const cloudWipes = cloudDoes("factory_reset");
  const lanWipes = vendorSupportsLocalReset(vendor) && settings !== "not_available";
  const reset: ResetMechanism = cloudWipes ? "vendor_cloud" : lanWipes ? "lan_http" : "not_available";
  const restart: RestartMechanism = http ? "lan_http"
    : cloudDoes("reboot") ? "vendor_cloud"
      : pnp ? "power_cycle"
        : "not_available";

  // The SECOND door is whichever real mechanism the primary is not. Today that is only ever the
  // password route sitting behind the cloud route; a brand with just one way in reports "none",
  // so nothing can promise a door that does not exist.
  const resetFallback: DeviceMechanisms["resetFallback"] = cloudWipes && lanWipes ? "lan_http" : "none";

  // ⛔ The fallback is deliberately NOT consulted here: today it is only ever the LAN door, so a
  // cloud named through it cannot exist. If a brand ever gains a cloud FALLBACK, add it here too —
  // `cloudPlatform` must name the cloud any offered door would really use.
  const usesCloud = reset === "vendor_cloud" || restart === "vendor_cloud";
  return {
    brand,
    reset,
    resetFallback,
    restart,
    settings,
    cloudPlatform: usesCloud && cloud ? cloud.platform : null,
    cloudClaimNeedsSerial: usesCloud && Boolean(cloud?.claimRequiresSerial),
  };
}
