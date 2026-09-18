/**
 * Grandstream through GDMS — the deepest cloud integration, because it is the only maker
 * cloud Loopcom has an account on today.
 *
 * Implemented, from the documented GDMS Open API: look a device up in Loopcom's account
 * (model, serial, firmware, online), add a device (needs its serial number), restart it,
 * factory reset it. ⛔ NOT implemented, so NOT claimed: config push, firmware update,
 * diagnostics, SIP assignment (SIP rides the phone system's own record).
 *
 * ⛔ GDMS only lists devices in OUR account. "Not found" never means "nobody owns it";
 * ownership elsewhere stays unknown (null) until an add is refused.
 * ⛔ A claim is proven by READING THE DEVICE BACK, not by the add call answering.
 */
import { createHash } from "node:crypto";
import { assertRedirectConfigSafe, type RedirectDelivery } from "./gdmsRedirect";
import {
  cleanSerialNumber,
  formatMac,
  normalizeMac,
  UNCHECKED_CLOUD_STATE,
  type ProviderReadiness,
} from "@connect/shared";
import {
  BaseDeviceProvider,
  failureFromError,
  isResetAuthorization,
  providerFailure,
  type ActionResult,
  type LookupResult,
  type ResetAuthorization,
} from "./deviceProvider";
import { assertGdmsRuntimeMode, GdmsClient, type GdmsCredentials } from "./gdmsClient";
import { DeviceError } from "./yealinkRps";

export const GRANDSTREAM_SUPPORTED_ACTIONS = ["lookup", "claim", "reboot", "factory_reset", "status"] as const;

export type GrandstreamProviderDeps = {
  resolveCredentials: () => Promise<GdmsCredentials | null>;
  request?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** GDMS site new devices are added to; the account's first site when absent. */
  siteId?: string | null;
};

export class GrandstreamProvider extends BaseDeviceProvider {
  readonly manufacturer = "grandstream" as const;
  readonly platform = "gdms" as const;
  protected readonly makerName = "Grandstream";
  private cached: { fingerprint: string; client: GdmsClient } | null = null;

  constructor(private readonly deps: GrandstreamProviderDeps) {
    super();
  }

  /** One session per credential set; changing any credential starts a new one. */
  private async client(): Promise<GdmsClient | null> {
    assertGdmsRuntimeMode(this.deps.env ?? process.env);
    const creds = await this.deps.resolveCredentials();
    if (!creds) return null;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([creds.region, creds.apiId, creds.secretKey, creds.username, creds.password]))
      .digest("hex");
    if (this.cached?.fingerprint !== fingerprint) {
      this.cached = { fingerprint, client: new GdmsClient(creds, this.deps.request ?? fetch, this.deps.now ?? Date.now) };
    }
    return this.cached.client;
  }

  async readiness(): Promise<ProviderReadiness> {
    let configured = false;
    try {
      assertGdmsRuntimeMode(this.deps.env ?? process.env);
      configured = Boolean(await this.deps.resolveCredentials());
    } catch {
      configured = false;
    }
    return {
      manufacturer: "grandstream",
      platform: "gdms",
      cloudConfigured: configured,
      supportedActions: configured ? [...GRANDSTREAM_SUPPORTED_ACTIONS] : [],
      claimRequiresSerial: true,
      redirectOnly: false,
      note: configured
        ? "Grandstream devices are looked up, added and restarted through Loopcom's Grandstream device cloud."
        : "Grandstream's device cloud isn't connected to Loopcom yet, so Grandstream devices are set up over your network.",
    };
  }

  async lookup(mac: string): Promise<LookupResult> {
    const n = normalizeMac(mac);
    if (!n) return providerFailure("invalid_mac", this.makerName);
    try {
      const client = await this.client();
      if (!client) return { ok: true, state: UNCHECKED_CLOUD_STATE, device: null };
      const d = await client.findDevice(n);
      if (!d) {
        return { ok: true, state: { checked: true, found: false, managedByUs: false, ownedElsewhere: null, online: null }, device: null };
      }
      return {
        ok: true,
        state: { checked: true, found: true, managedByUs: true, ownedElsewhere: false, online: d.online },
        device: { model: d.model, serialNumber: d.serialNumber, firmware: d.firmware, name: d.name },
      };
    } catch (err) {
      return failureFromError(err, this.makerName);
    }
  }

  async claim(input: { mac: string; serialNumber: string | null; deviceName?: string | null }): Promise<ActionResult> {
    const n = normalizeMac(input.mac);
    if (!n) return providerFailure("invalid_mac", this.makerName);
    const sn = cleanSerialNumber(input.serialNumber);
    if (!sn) return providerFailure("serial_number_required", this.makerName);
    try {
      const client = await this.client();
      if (!client) return providerFailure("cloud_not_configured", this.makerName);
      if (await client.findDevice(n)) {
        return { ok: true, outcome: "already_done", taskId: null, message: "This device is already registered with Grandstream for Loopcom." };
      }
      const siteId = this.deps.siteId || (await client.sites())[0]?.id;
      if (!siteId) return providerFailure("gdms_no_site", this.makerName);
      let writeError: unknown = null;
      try {
        await client.addDevice({ mac: n, serialNumber: sn, siteId, deviceName: input.deviceName ?? null });
      } catch (err) {
        writeError = err;
      }
      // ⛔ The read-back decides, including after a write that timed out.
      const after = await client.findDevice(n);
      if (after) return { ok: true, outcome: "verified", taskId: null, message: "Registered with Grandstream for Loopcom." };
      if (writeError) return failureFromError(writeError, this.makerName);
      return providerFailure("claim_not_verified", this.makerName);
    } catch (err) {
      return failureFromError(err, this.makerName);
    }
  }

  /**
   * Deliver a rendered config.xml to a claimed device over the GDMS cloud (the wizard's send
   * step). ⛔ The XML must be the PBX's rendered gs_provision config for THIS phone — the caller
   * owns getting a correct one (a clean per-model template, not another tenant's). This method
   * only delivers; it does not judge the config's contents.
   */
  async pushConfig(input: { mac: string; xml: string; allowedHosts?: readonly string[] }): Promise<ActionResult> {
    const n = normalizeMac(input.mac);
    if (!n) return providerFailure("invalid_mac", this.makerName);
    try {
      // ⛔⛔ THE TARGET FENCE, before anything leaves for the cloud. A config whose provisioning
      // server (P237) or SIP server (P47) is a private / VPN / loopback address — the proven
      // 10.8.0.1 bug — or a public host that is not ours is REFUSED here, never pushed. The route
      // passes the Loopcom host allow-list; this always runs the address gate even without it.
      assertRedirectConfigSafe(input.xml, input.allowedHosts ?? []);
      const client = await this.client();
      if (!client) return providerFailure("cloud_not_configured", this.makerName);
      // orgId omitted → GDMS uses the account's default org (where the device was claimed).
      await client.pushDeviceConfigXml({ mac: n, xml: input.xml });
      return { ok: true, outcome: "accepted", taskId: null, message: "Settings sent to the device through Grandstream." };
    } catch (err) {
      return failureFromError(err, this.makerName);
    }
  }

  /** GDMS's view of a claimed device: is it connected (online), and has it taken our config
   *  (synchronized)? Both null when unreadable — never guessed. `found:false` = not in our GDMS. */
  async deviceStatus(mac: string): Promise<{ found: boolean; online: boolean | null; synchronized: boolean | null }> {
    const n = normalizeMac(mac);
    if (!n) return { found: false, online: null, synchronized: null };
    try {
      const client = await this.client();
      if (!client) return { found: false, online: null, synchronized: null };
      const d = await client.findDevice(n);
      if (!d) return { found: false, online: null, synchronized: null };
      return { found: true, online: d.online, synchronized: d.synchronized };
    } catch {
      return { found: false, online: null, synchronized: null };
    }
  }

  /**
   * The full REDIRECT, in one call the wizard can act on honestly. Points a claimed Grandstream
   * at our phoneprov folder over the cloud (fenced), then reads GDMS back to say how far it got:
   * `delivered` (the phone took the config), `sent_applying` (pushed, online, sync not yet
   * confirmed), `queued_offline` (pushed, but the phone has not checked into GDMS — GDMS holds it
   * until it does), `not_claimed`, or `refused`. Never throws.
   */
  async deliverRedirect(input: { mac: string; xml: string; allowedHosts?: readonly string[] }): Promise<RedirectDelivery> {
    const n = normalizeMac(input.mac);
    if (!n) return { state: "refused", code: "invalid_mac" };
    // Fence before any network call — a bad target never reaches the cloud.
    try { assertRedirectConfigSafe(input.xml, input.allowedHosts ?? []); }
    catch (err) { return { state: "refused", code: err instanceof DeviceError ? err.code : "gdms_redirect_target_refused" }; }
    const before = await this.deviceStatus(n);
    if (!before.found) return { state: "not_claimed" };
    const pushed = await this.pushConfig({ mac: n, xml: input.xml, allowedHosts: input.allowedHosts });
    if (!pushed.ok) return { state: "refused", code: pushed.code ?? "gdms_request_rejected" };
    if (before.online === false) return { state: "queued_offline" };
    const after = await this.deviceStatus(n);
    if (after.synchronized === true) return { state: "delivered" };
    if (after.online === false) return { state: "queued_offline" };
    return { state: "sent_applying" };
  }

  private async task(mac: string, type: "reboot" | "factory_reset"): Promise<ActionResult> {
    const n = normalizeMac(mac);
    if (!n) return providerFailure("invalid_mac", this.makerName);
    try {
      const client = await this.client();
      if (!client) return providerFailure("cloud_not_configured", this.makerName);
      const d = await client.findDevice(n);
      if (!d) return providerFailure("device_not_managed", this.makerName);
      if (d.online === false) return providerFailure("device_offline", this.makerName);
      const { taskId } = await client.createTask({
        mac: n,
        type,
        name: `Loopcom ${type === "reboot" ? "restart" : "factory reset"} ${formatMac(n)}`,
      });
      return {
        ok: true,
        outcome: "accepted",
        taskId,
        message: type === "reboot"
          ? "Grandstream accepted the restart. It isn't finished until the device comes back."
          : "Grandstream accepted the reset. It isn't finished until the device comes back.",
      };
    } catch (err) {
      return failureFromError(err, this.makerName);
    }
  }

  async reboot(mac: string): Promise<ActionResult> {
    return this.task(mac, "reboot");
  }

  /** ⛔ Refused without the person's authorization for this device, whatever the caller. */
  async reset(input: { mac: string; authorization: ResetAuthorization | null }): Promise<ActionResult> {
    if (!isResetAuthorization(input.authorization)) return providerFailure("reset_authorization_required", this.makerName);
    return this.task(input.mac, "factory_reset");
  }
}
