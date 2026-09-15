/**
 * Plain-language status + error text for managed (zero-touch) desk phones.
 *
 * ⛔ Kept apart from ManagedPhonePanel.tsx so it is testable without React, and so
 * the four very different facts are never collapsed into "Provisioning complete":
 * configuration generated → RPS assignment → configuration DELIVERED → phone ONLINE.
 */
export type ManagedDeviceStatusInput = {
  retiredAt: string | null;
  registrationState: string;
  lastSeenAt: string | null;
  servedVersion: number | null;
  configVersion: number;
  rpsState: string;
};

const RPS_MESSAGES: Record<string, string> = {
  pending_credentials: "Configuration ready · Yealink zero-touch assignment pending",
  assigned: "Ready for zero-touch setup · Waiting for the phone to connect",
  conflict: "This phone is registered to another provider. Loopcom Support needs to release it first.",
  failed: "Zero-touch assignment did not go through. Try again, or contact Loopcom Support.",
  released: "Zero-touch assignment released",
};

export function managedPhoneStatus(d: ManagedDeviceStatusInput): string {
  if (d.retiredAt) return "Removed";
  if (d.registrationState === "online") return "Online";
  if (d.registrationState === "offline" && d.lastSeenAt) return "Offline";
  if (d.registrationState === "endpoint_registered_device_unverified") return "Extension registered · Confirm this phone makes calls";
  if (d.servedVersion === d.configVersion) return "Configuration downloaded · Waiting for the phone to register";
  if (d.lastSeenAt) return "Phone connected · Downloading configuration";
  return RPS_MESSAGES[d.rpsState] || "Preparing phone";
}

const ERROR_TEXT: Record<string, string> = {
  invalid_mac: "That MAC address isn't valid. It is 12 characters, printed on the sticker under the phone.",
  unsupported_model: "That phone model isn't supported for zero-touch setup yet.",
  extension_not_found: "That extension couldn't be found on this account.",
  device_ownership_conflict: "This phone is already set up on another account. Contact Loopcom Support.",
  device_exists_use_management: "This phone is already on this account. Use Edit / move extension below instead.",
  invalid_replacement: "The replacement must be a different phone on the same extension.",
  serial_number_required: "Yealink needs the phone's serial number for zero-touch setup. It is on the sticker under the phone and on the box.",
  device_not_found: "That phone couldn't be found.",
  device_retired: "That phone has been removed.",
  release_rps_before_removing_phone: "Release the zero-touch assignment before removing this phone.",
  rps_credentials_required: "Yealink zero-touch access isn't connected yet, so nothing can be released there.",
  replacement_not_verified_old_phone_preserved: "The new phone hasn't registered yet, so the old phone was kept working.",
  replacement_not_pending: "There is no replacement in progress for this phone.",
  tenant_pbx_link_missing: "This account isn't linked to a phone system yet.",
  tenant_sip_domain_missing: "This account has no phone-system address configured. Contact Loopcom Support.",
  desk_endpoint_credentials_unavailable: "This extension has no desk-phone line on the phone system. Contact Loopcom Support.",
  desk_sip_listener_configuration_required: "Zero-touch setup isn't fully configured on the server yet. Contact Loopcom Support.",
  provisioning_https_url_required: "Zero-touch setup isn't fully configured on the server yet. Contact Loopcom Support.",
  pbx_read_unavailable: "The phone system couldn't be reached. Try again in a minute.",
  managed_provisioning_not_enabled: "Zero-touch phone setup isn't turned on for Loopcom yet.",
  invalid_phone_settings: "Some settings aren't valid. Check the fields and try again.",
  phone_service_unavailable_retry_to_reconcile: "The phone service didn't answer. Try again — nothing will be duplicated.",
  forbidden: "You don't have permission to set up desk phones.",
};

/** ⛔ ApiError exposes the server JSON as `.body`, never `.payload`. */
export function managedPhoneErrorText(e: unknown): string {
  const code = (e as { body?: { error?: unknown } } | null)?.body?.error;
  if (typeof code === "string") {
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (code.startsWith("rps_")) return "Yealink's zero-touch service had a problem. The phone record is safe — try again later.";
  }
  return "Something went wrong talking to the phone service. Try again.";
}
