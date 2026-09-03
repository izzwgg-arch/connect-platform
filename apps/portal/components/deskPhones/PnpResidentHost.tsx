"use client";
/**
 * The office computer's STANDING answer to "where are my settings?".
 *
 * ⛔⛔ WHY (2026-09-02, A plus center): the wizard used to listen for a phone's
 * boot-time question only inside a 90-second window around a restart command —
 * and a factory-reset phone would not accept the restart, so the whole hand-off
 * depended on a person unplugging the phone inside a window somebody else had
 * started. Not automation. Now, whenever the Loopcom DESKTOP app is open on a
 * computer in the office, it keeps the customer's provisioning folder and the
 * hardware addresses of THEIR phones (as the PBX records them) armed in the
 * desktop's resident responder. Any of those phones that boots on that network
 * is told its folder — wizard or no wizard. A reset phone is provisioned the
 * moment it is plugged in.
 *
 * ⛔ Desktop FULL window only (the mini and the coworker windows are proxies),
 * and only when the bridge really has `phoneSetup`. A browser tab renders nothing
 * and asks nothing — there is no listener to arm.
 *
 * ⛔ The config comes from `/desk-phones/pnp-config`, which is gated on
 * `can_setup_desk_phones` server-side. A 403 means this login does not hold the
 * key: stop asking for the rest of the session (never an hourly 403 stream —
 * the 2026-08-17 auto-ban lesson). Never poll signed out.
 *
 * ⛔ The URL is fenced AGAIN inside the desktop (`isLoopcomProvisioningUrl`); this
 * component is a courier, not an authority.
 */
import { useEffect } from "react";
import { apiGet, hasBrowserAuthToken } from "../../services/apiClient";

export const PNP_CONFIG_PATH = "/desk-phones/pnp-config";
/** Re-read the customer's phone list this often — a phone added today is armed today. */
export const PNP_REFRESH_MS = 60 * 60_000;

type PnpConfig = { ok: boolean; url: string | null; macs: string[] };

export function PnpResidentHost() {
  useEffect(() => {
    const bridge = (window as any).connectDesktop;
    const run: ((req: Record<string, unknown>) => Promise<any>) | undefined = bridge?.phoneSetup?.run;
    if (typeof run !== "function" || bridge?.windowKind !== "full") return;
    let dead = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { dead = true; if (timer) { clearInterval(timer); timer = null; } };
    const arm = async () => {
      if (dead || !hasBrowserAuthToken()) return;
      try {
        const cfg = await apiGet<PnpConfig>(PNP_CONFIG_PATH);
        if (!cfg?.url || !Array.isArray(cfg.macs) || cfg.macs.length === 0) return;
        await run({ op: "arm_pnp", url: cfg.url, macs: cfg.macs });
      } catch (e: any) {
        if (Number(e?.status) === 403) stop();
      }
    };
    void arm();
    timer = setInterval(() => void arm(), PNP_REFRESH_MS);
    const onExpired = () => { stop(); void run({ op: "disarm_pnp" }).catch(() => null); };
    window.addEventListener("cc-session-expired", onExpired);
    return () => { stop(); window.removeEventListener("cc-session-expired", onExpired); };
  }, []);
  return null;
}
