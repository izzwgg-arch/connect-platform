/**
 * Text the owner when a finished sign-up has NO working 911 (Izzy, 2026-09-16:
 * "yes, do it" — to "an alert that actually reaches you when 911 fails").
 *
 * ⛔⛔ The only alarm channel that reaches a person is an `AgentEscalation` row
 * (agentEscalationDispatch.ts → SMS within 30 s). The sign-up report goes out as
 * ADMIN_ALERT, which is muted at the send door — on the Telnyx end-to-end test
 * every "needs attention" report read SKIPPED. Never route this through it.
 *
 * ⛔ Once per sign-up per number: de-duped on the summary prefix while an
 * escalation for it is still QUEUED/SENT, so the retry sweep can never spam.
 */
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

export const E911_ALERT_STATUSES = new Set(["failed", "address_incomplete"]);

function fmt(did: string): string {
  const d = String(did || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(did || "");
}

export function e911AlertKey(company: string, did: string): string {
  return `911 NOT registered: ${company} ${fmt(did)}`;
}

export function buildE911AlertSms(input: { company: string; did: string; status: string; detail: string }): string {
  const why =
    input.status === "address_incomplete"
      ? "the sign-up has no complete address"
      : /85009/.test(input.detail)
        ? "the carrier wants the address validated by hand (call their support)"
        : "the carrier refused the address";
  return `Loopcom: 911 is NOT set on ${input.company}'s new number ${fmt(input.did)} — ${why}. Calls work. It retries by itself; open the sign-up to see why.`.slice(0, 300);
}

/** Returns true when a new escalation was raised, false when one is already open (or nothing to alert). */
export async function raiseE911EscalationIfNeeded(db: any, row: any): Promise<boolean> {
  const e911: any = row?.answers?.provisioning?.e911;
  if (!e911 || !E911_ALERT_STATUSES.has(String(e911.status))) return false;
  const company = String(row?.companyName || "a new customer").trim();
  const did = String(e911.did || row?.provisionedDid || "");
  const key = e911AlertKey(company, did);
  const open = await db.agentEscalation
    .findFirst({ where: { requestSummary: { startsWith: key }, status: { in: ["QUEUED", "SENT"] } }, select: { id: true } })
    .catch(() => null);
  if (open) return false;
  await db.agentEscalation.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      tenantName: "Loopcom platform",
      clientUserId: null,
      userName: "911 registration monitor",
      userEmail: null,
      requestSummary: `${key} (${String(e911.status)})`,
      smsBody: buildE911AlertSms({ company, did, status: String(e911.status), detail: String(e911.detail || "") }),
      report:
        `Sign-up ${row.id} (${company}) finished, but 911 is not registered on ${fmt(did)}.\n` +
        `Status: ${e911.status}\nCarrier said: ${e911.detail || "(nothing)"}\n` +
        `The customer was NOT told 911 is set. Telnyx sign-ups retry automatically (hourly, then every 6 hours); ` +
        `POST /admin/onboarding/submissions/${row.id}/retry-e911 retries now.`,
      proposedFix: /85009/.test(String(e911.detail || ""))
        ? "Ask Telnyx support to validate this address for emergency use, then retry."
        : "Check the address on the sign-up; fix it, then retry.",
      researchDegraded: false,
      status: "QUEUED",
    },
  });
  return true;
}
