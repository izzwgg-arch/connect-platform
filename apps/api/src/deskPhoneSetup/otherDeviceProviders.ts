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

  async readiness(): Promise<ProviderReadiness> {
    const live = isLiveRps(this.adapter());
    return {
      manufacturer: "yealink",
      platform: "yealink_rps",
      cloudConfigured: live,
      supportedActions: live ? ["lookup"] : [],
      claimRequiresSerial: false,
      redirectOnly: true,
      note: live
        ? "Yealink's redirection service can tell whether a phone is assigned to Loopcom. It only redirects brand-new phones; it cannot restart or reset one."
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
