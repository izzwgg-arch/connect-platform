/**
 * Yealink, Fanvil and Poly behind the same interface — honest about how little each cloud
 * can do for Loopcom today.
 *
 * - Yealink RPS: live only when YEALINK_RPS_* is configured; then it can tell whether a
 *   MAC is in Loopcom's RPS account or another one. RPS redirects factory-fresh phones and
 *   manages nothing, and ASSIGNING a phone stays with the existing managed-phone service
 *   (one RPS writer, not two). YMCS is not integrated.
 * - Fanvil FDPS/FDMS: Fanvil issues those accounts on request; none exists yet.
 * - Poly zero touch needs an HP partner agreement; Poly Lens is not connected.
 *
 * ⛔ Nothing here fabricates a capability. Every unsupported action is a refusal.
 */
import { normalizeMac, UNCHECKED_CLOUD_STATE, type ProviderReadiness } from "@connect/shared";
import { BaseDeviceProvider, failureFromError, providerFailure, type LookupResult } from "./deviceProvider";
import { configuredRps, type RpsAdapter } from "./yealinkRps";

type LiveRps = RpsAdapter & { checkMac(mac: string): Promise<{ existed: boolean; self: boolean | null }> };

function isLiveRps(a: RpsAdapter | null): a is LiveRps {
  return Boolean(a && a.mode === "live" && typeof (a as any).checkMac === "function");
}

export class YealinkDeviceProvider extends BaseDeviceProvider {
  readonly manufacturer = "yealink" as const;
  readonly platform = "yealink_rps" as const;
  protected readonly makerName = "Yealink";

  constructor(private readonly deps: { rps?: () => RpsAdapter; env?: NodeJS.ProcessEnv } = {}) {
    super();
  }

  private adapter(): RpsAdapter | null {
    try {
      return this.deps.rps ? this.deps.rps() : configuredRps(this.deps.env ?? process.env);
    } catch {
      return null;
    }
  }

  /**
   * ⛔⛔ Izzy, 2026-09-17: "integrated with both databases" — a Yealink the office wizard
   * knows (MAC + serial off the sticker) can now really be CLAIMED into Loopcom's RPS
   * account, so `supportedActions` says so once RPS is live. That is honest about the
   * MAKER: RPS really can register the device. It is NOT honest about what THIS class
   * does with it — `claim()` below still refuses, deliberately.
   *
   * ⛔⛔ TRACED BEFORE SHIPPING (the blast-radius check Izzy's third standing rule
   * demands): `capabilitiesFor` turns `supportedActions.includes("claim")` into
   * `canClaim`, which `planDevicePreparation` turns into a "claim" step with
   * `via: "vendor_cloud"` whenever `cloud.managedByUs !== true` — and the wizard's
   * `/prepare` route (`deviceCloudRoutes.ts`) runs that step through THIS class's
   * `claim()`. The ONLY caller of `/prepare` is `setupDriver.ts`'s `askMakerCloud`,
   * gated on `decision.via === "vendor_cloud"` for reset/restart — and
   * `deviceMechanismsFor` never sets that for Yealink because `redirectOnly: true`
   * stays true (see below), so `/prepare` is never invoked for a Yealink phone by
   * the driver. Nothing else in the portal reads `canClaim`. So advertising "claim"
   * here changes only: `GET /desk-phones/providers`' `canRegisterDevices` flag (an
   * honest "yes, RPS can" for staff/customers to read) and the identification
   * view's capability flags — never a live network call through this path.
   * ⛔ The REAL claim writer for the office wizard is `ManagedPhoneService.
   * claimForOfficeWizard`, called from `yealinkRedirectClaim.ts` at the moments the
   * wizard already writes the PBX record — "one RPS writer", not this interface.
   * If `/prepare` or `/claim` ever actually reaches `claim()` below (it should not,
   * traced above), refusing with `not_supported` is the correct, safe answer: it
   * must never attempt a SECOND, competing RPS write of its own.
   */
  async readiness(): Promise<ProviderReadiness> {
    const live = isLiveRps(this.adapter());
    return {
      manufacturer: "yealink",
      platform: "yealink_rps",
      cloudConfigured: live,
      supportedActions: live ? ["lookup", "claim"] : [],
      claimRequiresSerial: live,
      // ⛔⛔ MUST STAY true. `deviceMechanismsFor` only lets a maker cloud reset or
      // restart a phone when `!redirectOnly` — RPS redirects a factory-fresh phone
      // and manages nothing else, so a Yealink must keep clearing and restarting
      // over the LAN (see deviceMechanisms.test.ts's "claim, still no cloud reset").
      redirectOnly: true,
      note: live
        ? "Yealink's redirection service can register a phone to Loopcom and tell whether one already is. It only redirects brand-new phones; it cannot restart or reset one."
        : "Yealink's redirection service isn't connected to Loopcom yet, so Yealink phones are set up over your network.",
    };
  }

  async lookup(mac: string): Promise<LookupResult> {
    const n = normalizeMac(mac);
    if (!n) return providerFailure("invalid_mac", this.makerName);
    const a = this.adapter();
    if (!isLiveRps(a)) return { ok: true, state: UNCHECKED_CLOUD_STATE, device: null };
    try {
      const check = await a.checkMac(n);
      if (!check || typeof check.existed !== "boolean") return providerFailure("rps_invalid_response", this.makerName);
      if (!check.existed) {
        return { ok: true, state: { checked: true, found: false, managedByUs: false, ownedElsewhere: false, online: null }, device: null };
      }
      const ours = check.self === true;
      return {
        ok: true,
        state: { checked: true, found: true, managedByUs: ours, ownedElsewhere: check.self === false, online: null },
        device: null,
      };
    } catch (err) {
      return failureFromError(err, this.makerName);
    }
  }
}

export class FanvilDeviceProvider extends BaseDeviceProvider {
  readonly manufacturer = "fanvil" as const;
  readonly platform = "fanvil_fdps" as const;
  protected readonly makerName = "Fanvil";

  async readiness(): Promise<ProviderReadiness> {
    return {
      manufacturer: "fanvil",
      platform: "fanvil_fdps",
      cloudConfigured: false,
      supportedActions: [],
      claimRequiresSerial: null,
      redirectOnly: false,
      note: "Fanvil's provisioning cloud isn't connected to Loopcom — Fanvil issues those accounts on request and none has been issued yet. Fanvil devices are set up over your network.",
    };
  }
}

export class PolyDeviceProvider extends BaseDeviceProvider {
  readonly manufacturer = "poly" as const;
  readonly platform = "poly_zero_touch" as const;
  protected readonly makerName = "Poly";

  async readiness(): Promise<ProviderReadiness> {
    return {
      manufacturer: "poly",
      platform: "poly_zero_touch",
      cloudConfigured: false,
      supportedActions: [],
      claimRequiresSerial: null,
      redirectOnly: false,
      note: "Poly's zero-touch service needs an HP partner agreement and Poly Lens isn't connected to Loopcom yet. Poly devices are set up over your network.",
    };
  }
}
