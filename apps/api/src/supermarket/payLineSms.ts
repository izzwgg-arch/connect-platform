/**
 * The pay line's one-time code by TEXT — sent FROM THE STORE'S OWN NUMBER.
 *
 * Izzy, 2026-09-17: "Should come from their phone number." The text goes out
 * from the tenant's default texting number (Gesheft: (845) 244-9666, the same
 * number the pay line answers on), never from Connect's platform number.
 *
 * Why this is its own sender and not the chat lane: the Connect Chat path is
 * asynchronous (a thread row + a queue the worker drains) and requires an SMS
 * thread to exist. A caller is holding on the line for this code — it is sent
 * NOW, synchronously, through the same provider client the worker would use
 * for a VOIPMS row, with the tenant's number as the from. The code itself is
 * never logged and never persisted in clear (the runtime stores a hash).
 *
 * Scope, deliberately narrow (2026-09-17): the tenant's default number must be
 * a VoIP.ms number on the platform's "default" VoIP.ms account (Gesheft's is).
 * A number on another account or carrier answers `not_configured` and the
 * caller is offered the phone-call delivery instead — never a silent failure.
 */

import { resolvePlatformSmsSender } from "../billing/billingSmsSender";

export type PayLineSmsSend = (input: { tenantId: string; to10: string; body: string }) => Promise<{ ok: boolean; error?: string }>;

export function payLineCodeSmsBody(code: string, storeName: string): string {
  return `${storeName}: your one-time phone payment code is ${code}. It expires in 10 minutes. If you did not call us, ignore this text.`;
}

/** The tenant's own texting number for the code, or null with a reason. */
export async function resolvePayLineFromNumber(db: any, tenantId: string): Promise<{ e164: string } | { error: string }> {
  const row = await db.tenantSmsNumber
    .findFirst({
      where: { tenantId, active: true, smsCapable: true },
      orderBy: [{ isTenantDefault: "desc" }, { createdAt: "asc" }],
      select: { phoneE164: true, provider: true, voipmsAccountId: true },
    })
    .catch(() => null);
  if (!row?.phoneE164) return { error: "tenant_has_no_texting_number" };
  if (String(row.provider ?? "VOIPMS") !== "VOIPMS") return { error: "tenant_number_not_voipms" };
  if (String(row.voipmsAccountId ?? "default") !== "default") return { error: "tenant_number_not_on_default_account" };
  return { e164: String(row.phoneE164) };
}

/** Send the code text from the tenant's number, right now. Never throws. */
export async function sendPayLineSms(db: any, input: { tenantId: string; to10: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!/^\d{10}$/.test(input.to10)) return { ok: false, error: "bad_destination" };
    const from = await resolvePayLineFromNumber(db, input.tenantId);
    if ("error" in from) return { ok: false, error: from.error };
    const sender = await resolvePlatformSmsSender(from.e164);
    if (!sender.ok) return { ok: false, error: sender.error };
    await sender.send({ tenantId: input.tenantId, to: `+1${input.to10}`, body: input.body });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.code ?? err?.message ?? "sms_failed").slice(0, 80) };
  }
}
