/**
 * The one interface every device maker's cloud is driven through.
 *
 * ⛔⛔ THE WIZARD NEVER BRANCHES ON A BRAND. It asks the registry for the provider that
 * matches what was DISCOVERED and calls these methods; Grandstream, Yealink, Fanvil and
 * Poly differences live inside the adapters and inside `capabilitiesFor`.
 *
 * ⛔ A provider reports only what its vendor API really does AND what this deployment has
 * credentials for. An unsupported action is an honest refusal, never a stub that says yes.
 * ⛔ An accepted vendor call is never "online" — only the phone system saying the device
 * registered is. `ActionResult.outcome` says exactly how much is known: "accepted" (the
 * vendor took the request), "verified" (read back from the vendor), "already_done".
 * ⛔ No failure carries a vendor body; every message is written here.
 */
import {
  capabilitiesFor,
  manufacturerFromText,
  normalizeMac,
  UNCHECKED_CLOUD_STATE,
  type CloudDeviceState,
  type CloudPlatform,
  type DeviceCapabilities,
  type DeviceType,
  type PreparationPlan,
  type PreparationStep,
  type ProviderReadiness,
  type SupportedManufacturer,
} from "@connect/shared";
import { DeviceError } from "./yealinkRps";

export type CloudDeviceFacts = {
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  name: string | null;
};

export type ProviderFailure = {
  ok: false;
  code: string;
  /** Safe for the customer's screen. */
  message: string;
  /** For Loopcom staff only — may name the platform or the account. */
  staffMessage: string;
  retryable: boolean;
  /** The vendor refused in a way that MAY mean another account holds the device. Never proof. */
  possibleOwnershipConflict?: boolean;
};

export type LookupResult = { ok: true; state: CloudDeviceState; device: CloudDeviceFacts | null } | ProviderFailure;

export type ActionResult =
  | { ok: true; outcome: "accepted" | "verified" | "already_done"; taskId: string | null; message: string }
  | ProviderFailure;

/** The person's approval to wipe THIS device, checked by the route before it gets here. */
export type ResetAuthorization = { runId: string; phoneId: string; approvedAtMs: number };

/**
 * Where the caller hangs its safety and its record-keeping on the ONE execution loop:
 * `beforeStep` can refuse a step (ownership lock, reset in flight) without the vendor
 * being called; `afterStep` persists and audits what happened.
 */
export type PrepareHooks = {
  beforeStep?: (step: PreparationStep) => Promise<ProviderFailure | null>;
  afterStep?: (step: PreparationStep, result: ActionResult) => Promise<void>;
};

export type PrepareResult = {
  ran: Array<{ step: PreparationStep; result: ActionResult }>;
  /** The step that failed, so nothing after it ran. */
  stoppedAt: PreparationStep | null;
  /** Steps that belong to the network path or the phone system, not the maker's cloud. */
  leftForOthers: PreparationStep[];
};

export interface DeviceProvider {
  readonly manufacturer: SupportedManufacturer;
  readonly platform: CloudPlatform;
  readiness(): Promise<ProviderReadiness>;
  detect(input: { manufacturer: string | null; model: string | null }): boolean;
  lookup(mac: string): Promise<LookupResult>;
  claim(input: { mac: string; serialNumber: string | null; deviceName?: string | null }): Promise<ActionResult>;
  prepare(input: {
    mac: string;
    serialNumber: string | null;
    deviceName?: string | null;
    plan: PreparationPlan;
    resetAuthorization: ResetAuthorization | null;
    hooks?: PrepareHooks;
  }): Promise<PrepareResult>;
  reset(input: { mac: string; authorization: ResetAuthorization | null }): Promise<ActionResult>;
  reboot(mac: string): Promise<ActionResult>;
  reprovision(mac: string): Promise<ActionResult>;
  assignSip(mac: string): Promise<ActionResult>;
  /** Deliver a rendered gs_provision config to the device over the maker cloud. */
  pushConfig(input: { mac: string; xml: string }): Promise<ActionResult>;
  firmwareUpdate(mac: string): Promise<ActionResult>;
  getStatus(mac: string): Promise<LookupResult>;
  getCapabilities(input: { model: string | null; deviceType: DeviceType; cloud?: CloudDeviceState | null }): Promise<DeviceCapabilities>;
}

type Wording = { customer: (maker: string) => string; staff: (maker: string) => string; retryable: boolean };

const WORDING: Record<string, Wording> = {
  invalid_mac: {
    customer: () => "This device's hardware address could not be read.",
    staff: () => "The MAC address is not a valid device address.",
    retryable: false,
  },
  cloud_not_configured: {
    customer: (m) => `Setting this ${m} device up through ${m}'s cloud isn't available yet. It can still be set up over your network.`,
    staff: (m) => `${m}'s device cloud has no credentials configured in Loopcom.`,
    retryable: false,
  },
  not_supported: {
    customer: () => "That isn't available for this device yet.",
    staff: (m) => `This action is not implemented or not documented for ${m}'s cloud.`,
    retryable: false,
  },
  assign_sip_via_phone_system: {
    customer: () => "This device gets its phone account from Loopcom's phone system, not from the maker.",
    staff: () => "SIP accounts are delivered by the PBX provisioning record; no vendor cloud assigns them.",
    retryable: false,
  },
  serial_number_required: {
    customer: () => "The maker needs this device's serial number. Scan the barcode on the label underneath it.",
    staff: (m) => `${m} requires the serial number to add a device.`,
    retryable: false,
  },
  reset_authorization_required: {
    customer: () => "This device has to be cleared before it can join Loopcom. Approve clearing it to continue.",
    staff: () => "A factory reset was requested without the person's authorization for this device.",
    retryable: false,
  },
  device_not_managed: {
    customer: (m) => `This device isn't registered with ${m} for Loopcom yet.`,
    staff: (m) => `The device is not in Loopcom's ${m} account, so the cloud cannot act on it.`,
    retryable: false,
  },
  device_offline: {
    customer: (m) => `${m} says this device is offline. Check it has power and a network cable, then try again.`,
    staff: (m) => `${m} reports the device offline; a cloud task would never reach it.`,
    retryable: true,
  },
  claim_not_verified: {
    customer: (m) => `${m} didn't confirm the device was added. Loopcom Support has been told.`,
    staff: (m) => `${m} answered the add request but the device is not in the account on read-back.`,
    retryable: true,
  },
  gdms_no_site: {
    customer: () => "Registering this device with its maker isn't available right now. Loopcom Support has been told.",
    staff: () => "The GDMS account has no site to add devices to.",
    retryable: false,
  },
  gdms_credentials_required: {
    customer: (m) => `Setting this ${m} device up through ${m}'s cloud isn't available yet.`,
    staff: () => "GDMS credentials are incomplete.",
    retryable: false,
  },
  gdms_region_invalid: {
    customer: () => "Registering this device with its maker isn't available right now.",
    staff: () => "The stored GDMS region is not US or EU.",
    retryable: false,
  },
  gdms_authentication_failed: {
    customer: () => "Registering this device with its maker isn't available right now. Loopcom Support has been told.",
    staff: () => "GDMS refused Loopcom's sign-in. Check the API ID, Secret Key, username and password.",
    retryable: false,
  },
  gdms_rate_limited_retry_later: {
    customer: (m) => `${m} asked us to slow down. Try again in a minute.`,
    staff: () => "GDMS rate limited the request (429).",
    retryable: true,
  },
  gdms_unreachable_retry_later: {
    customer: (m) => `${m}'s device cloud isn't answering right now. Try again shortly.`,
    staff: () => "GDMS could not be reached (network error or timeout).",
    retryable: true,
  },
  gdms_service_unavailable: {
    customer: (m) => `${m}'s device cloud isn't answering right now. Try again shortly.`,
    staff: () => "GDMS answered with a server error.",
    retryable: true,
  },
  gdms_write_uncertain_check_again: {
    customer: (m) => `${m} didn't confirm the change in time. Check its status before trying again.`,
    staff: () => "A GDMS write timed out or failed after sending; it may have landed. Re-read before retrying.",
    retryable: false,
  },
  gdms_request_rejected: {
    customer: (m) => `${m} refused. The device may belong to another account, or the serial number may not match its label.`,
    staff: () => "GDMS refused this request with an error code (another account, a serial mismatch, or a bad field).",
    retryable: false,
  },
  serial_for_different_device: {
    customer: () => "That serial number belongs to a different phone. Turn over the phone you're setting up: the MAC on its sticker must match the MAC shown for this phone here, and its serial number is printed right next to it.",
    staff: (m) => `${m} refused the MAC+serial pair, and the serial's embedded MAC tail names a different handset — the customer read another phone's label.`,
    retryable: false,
  },
  gdms_invalid_response: {
    customer: (m) => `${m} sent an answer Loopcom couldn't read. Loopcom Support has been told.`,
    staff: () => "GDMS returned a body that is not the documented envelope.",
    retryable: false,
  },
  gdms_mock_not_allowed_in_runtime: {
    customer: () => "Registering this device with its maker isn't available right now.",
    staff: () => "GDMS_MODE is set to a simulator mode, which production refuses.",
    retryable: false,
  },
  device_ownership_conflict: {
    customer: () => "This device is registered to another account. Loopcom Support needs to release it before it can be set up.",
    staff: () => "Another Loopcom customer already manages, or is registering, this hardware address.",
    retryable: false,
  },
  claim_in_progress: {
    customer: (m) => `This device is already being registered with ${m}. Give it a moment, then check again.`,
    staff: () => "A claim for this hardware address is already in flight.",
    retryable: false,
  },
  reset_already_used: {
    customer: () => "This device has already been cleared once during this setup. Loopcom Support can finish it.",
    staff: () => "The one reset allowed for this phone in this run is spent.",
    retryable: false,
  },
  reset_in_flight: {
    customer: () => "Clearing this device is already under way.",
    staff: () => "Another reset request won the atomic claim on this phone.",
    retryable: false,
  },
  reset_not_allowed: {
    customer: () => "This device can't be cleared from here. Loopcom Support can finish it.",
    staff: () => "decideReset refused (terminal state or attempts exhausted).",
    retryable: false,
  },
  needs_assignment: {
    customer: () => "Choose who uses this device first, then try again.",
    staff: () => "Restarting or clearing a device before it is assigned an extension accomplishes nothing.",
    retryable: false,
  },
  rps_authentication_failed: {
    customer: () => "Checking this device with its maker isn't available right now.",
    staff: () => "Yealink RPS refused Loopcom's credentials.",
    retryable: false,
  },
  rps_rate_limited_retry_later: {
    customer: (m) => `${m} asked us to slow down. Try again in a minute.`,
    staff: () => "Yealink RPS rate limited the request.",
    retryable: true,
  },
  rps_unreachable_retry_to_reconcile: {
    customer: (m) => `${m}'s device service isn't answering right now. Try again shortly.`,
    staff: () => "Yealink RPS could not be reached.",
    retryable: true,
  },
  rps_service_unavailable: {
    customer: (m) => `${m}'s device service isn't answering right now. Try again shortly.`,
    staff: () => "Yealink RPS answered with a server error.",
    retryable: true,
  },
};

export function providerFailure(code: string, maker: string, extra: Partial<ProviderFailure> = {}): ProviderFailure {
  const w = WORDING[code];
  return {
    ok: false,
    code,
    message: w ? w.customer(maker) : `Something went wrong talking to ${maker}. Loopcom Support has been told.`,
    staffMessage: w ? w.staff(maker) : `Unmapped provider error code: ${code}`,
    retryable: w ? w.retryable : false,
    ...extra,
  };
}

/** ⛔ Reads only the error CODE. A vendor message or fetch error text never leaves here. */
/**
 * The MAC tail a Grandstream serial carries, when it carries one: its last six characters,
 * if they read as hex. Observed on real GXP2170 labels (serial `…308C605F` ↔ MAC …8c:60:5f);
 * Grandstream does not document the convention, so this is only ever used to EXPLAIN a
 * refusal the maker already made — never to refuse a serial on its own.
 */
export function serialEmbeddedMacTail(serial: string | null | undefined): string | null {
  const s = String(serial ?? "").trim();
  if (s.length < 6) return null;
  const tail = s.slice(-6);
  return /^[0-9a-fA-F]{6}$/.test(tail) ? tail.toLowerCase() : null;
}

export function failureFromError(err: unknown, maker: string): ProviderFailure {
  const code = err instanceof DeviceError ? err.code : "provider_error";
  return providerFailure(code, maker, code === "gdms_request_rejected" ? { possibleOwnershipConflict: true } : {});
}

export function isResetAuthorization(value: unknown): value is ResetAuthorization {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === "string" && v.runId.length > 0
    && typeof v.phoneId === "string" && v.phoneId.length > 0
    && typeof v.approvedAtMs === "number" && Number.isFinite(v.approvedAtMs) && v.approvedAtMs > 0;
}

export abstract class BaseDeviceProvider implements DeviceProvider {
  abstract readonly manufacturer: SupportedManufacturer;
  abstract readonly platform: CloudPlatform;
  protected abstract readonly makerName: string;
  abstract readiness(): Promise<ProviderReadiness>;

  detect(input: { manufacturer: string | null; model: string | null }): boolean {
    return manufacturerFromText(input.manufacturer) === this.manufacturer;
  }

  async lookup(mac: string): Promise<LookupResult> {
    if (!normalizeMac(mac)) return providerFailure("invalid_mac", this.makerName);
    return { ok: true, state: UNCHECKED_CLOUD_STATE, device: null };
  }

  async claim(_input: { mac: string; serialNumber: string | null; deviceName?: string | null }): Promise<ActionResult> {
    return this.unsupported();
  }

  async reset(_input: { mac: string; authorization: ResetAuthorization | null }): Promise<ActionResult> {
    return this.unsupported();
  }

  async reboot(_mac: string): Promise<ActionResult> { return this.unsupported(); }
  async reprovision(_mac: string): Promise<ActionResult> { return this.unsupported(); }
  async pushConfig(_input: { mac: string; xml: string }): Promise<ActionResult> { return this.unsupported(); }
  async firmwareUpdate(_mac: string): Promise<ActionResult> { return this.unsupported(); }

  /** ⛔ SIP accounts always ride the phone system's provisioning record. */
  async assignSip(_mac: string): Promise<ActionResult> {
    return providerFailure("assign_sip_via_phone_system", this.makerName);
  }

  async getStatus(mac: string): Promise<LookupResult> { return this.lookup(mac); }

  async getCapabilities(input: { model: string | null; deviceType: DeviceType; cloud?: CloudDeviceState | null }): Promise<DeviceCapabilities> {
    return capabilitiesFor({
      manufacturer: this.manufacturer,
      model: input.model,
      deviceType: input.deviceType,
      readiness: await this.readiness(),
      cloud: input.cloud ?? null,
    });
  }

  /**
   * Runs ONLY the plan's vendor-cloud steps, in order, and stops at the first failure.
   * ⛔ A plan that needs a person runs nothing. A factory reset step still needs the
   * authorization object — the plan saying "reset" is not permission.
   */
  async prepare(input: {
    mac: string;
    serialNumber: string | null;
    deviceName?: string | null;
    plan: PreparationPlan;
    resetAuthorization: ResetAuthorization | null;
    hooks?: PrepareHooks;
  }): Promise<PrepareResult> {
    const out: PrepareResult = { ran: [], stoppedAt: null, leftForOthers: [] };
    if (input.plan.manualAction) return out;
    for (const s of input.plan.steps) {
      if (s.via !== "vendor_cloud") {
        out.leftForOthers.push(s.step);
        continue;
      }
      if (!["claim", "factory_reset", "reboot", "reprovision"].includes(s.step)) {
        out.leftForOthers.push(s.step);
        continue;
      }
      const blocked = input.hooks?.beforeStep ? await input.hooks.beforeStep(s.step) : null;
      if (blocked) {
        out.ran.push({ step: s.step, result: blocked });
        out.stoppedAt = s.step;
        break;
      }
      let result: ActionResult;
      switch (s.step) {
        case "claim":
          result = await this.claim({ mac: input.mac, serialNumber: input.serialNumber, deviceName: input.deviceName });
          break;
        case "factory_reset":
          result = await this.reset({ mac: input.mac, authorization: input.resetAuthorization });
          break;
        case "reboot":
          result = await this.reboot(input.mac);
          break;
        case "reprovision":
          result = await this.reprovision(input.mac);
          break;
        default:
          out.leftForOthers.push(s.step);
          continue;
      }
      out.ran.push({ step: s.step, result });
      if (input.hooks?.afterStep) await input.hooks.afterStep(s.step, result);
      if (!result.ok) {
        out.stoppedAt = s.step;
        break;
      }
    }
    return out;
  }

  protected unsupported(): ProviderFailure {
    return providerFailure("not_supported", this.makerName);
  }
}
