/**
 * Every company's live facts, written for the assistant, kept current by itself.
 *
 * ⛔ WHY A SWEEP AND NOT A CREATION HOOK. There are FIVE places a tenant row is
 * created (onboarding payment, the setup orchestrator, the PBX extension sync,
 * and two admin paths in server.ts). Hooking each one is how this codebase has
 * repeatedly shipped a feature that works on one path and silently skips the
 * other — the two IVR publish paths, the two invite paths. A sweep over every
 * live tenant covers all five, plus any path added later by someone who never
 * reads this file.
 *
 * It also solves staleness, which a creation hook cannot: an account's numbers,
 * extensions and phone menu change constantly, and knowledge that was true on
 * signup day is worse than no knowledge at all.
 *
 * ⛔ THE DIVISION OF LABOUR:
 *   · THIS file owns the FACTS — generated, never hand-edited, refreshed on a
 *     timer. Row `source: "auto"`, slug `facts:<tenantId>`.
 *   · `docs/agent-knowledge/tenants/*.md` owns what we have LEARNED — written
 *     by people, published by `agentKnowledgeSync.ts`, never overwritten here.
 * The sync strips the generated block out of those files before publishing, so
 * the two can never both describe the same fact and disagree about it.
 */
import { createHash } from "node:crypto";
import { db } from "@connect/db";

export const FACTS_SLUG_PREFIX = "facts:";
export const factsSlug = (tenantId: string) => `${FACTS_SLUG_PREFIX}${tenantId}`;

function pretty(e164: string | null | undefined): string {
  const d = String(e164 ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(e164 ?? "");
}

/** Plain English for a menu key's destination — the customer's words, not ours. */
function keyDestination(o: { destinationType: string; label: string | null }): string {
  const kind: Record<string, string> = {
    extension: "an extension",
    queue: "a waiting line",
    ring_group: "a team of phones",
    voicemail: "voicemail",
    ivr: "another menu",
    announcement: "a recorded message",
    external_number: "an outside phone number",
    terminate: "hanging up",
    custom: "an outside phone number",
  };
  const what = kind[o.destinationType] ?? o.destinationType;
  return o.label ? `${o.label} (${what})` : what;
}

export interface TenantFactsDoc {
  body: string;
  internalBody: string;
}

/**
 * Build one company's facts. Read-only, and every section degrades to a plain
 * sentence rather than vanishing — "they have no phone menu" is knowledge too,
 * and an assistant that simply omits the section will guess instead.
 */
export async function buildTenantFactsDoc(tenantId: string): Promise<TenantFactsDoc | null> {
  const tenant = await (db as any).tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, createdAt: true, pbxRemovedAt: true },
  });
  if (!tenant || tenant.pbxRemovedAt) return null;

  const [dids, extensions, smsNumbers, users, profiles, pbxLink, billing] = await Promise.all([
    (db as any).pbxTenantInboundDid.findMany({
      where: { connectTenantId: tenantId, active: true },
      select: { e164: true },
      orderBy: { e164: "asc" },
    }).catch(() => []),
    (db as any).extension.findMany({
      where: { tenantId },
      select: { extNumber: true, displayName: true, status: true, vmEmailEnabled: true },
      orderBy: { extNumber: "asc" },
    }).catch(() => []),
    (db as any).tenantSmsNumber.findMany({
      where: { tenantId, active: true },
      select: { phoneE164: true, isTenantDefault: true },
    }).catch(() => []),
    (db as any).user.findMany({
      where: { tenantId },
      select: { email: true, firstName: true, lastName: true, displayName: true, role: true, uiLanguage: true },
      orderBy: { createdAt: "asc" },
      take: 30,
    }).catch(() => []),
    (db as any).ivrRouteProfile.findMany({
      where: { tenantId },
      select: {
        name: true, type: true, directDialEnabled: true,
        options: {
          where: { enabled: true },
          select: { optionDigit: true, destinationType: true, label: true },
          orderBy: { optionDigit: "asc" },
        },
      },
    }).catch(() => []),
    (db as any).tenantPbxLink.findFirst({ where: { tenantId }, select: { status: true, pbxTenantId: true } }).catch(() => null),
    (db as any).tenantBillingSettings.findFirst({
      where: { tenantId },
      select: { billingDayOfMonth: true, autopayEnabled: true, smsBillingEnabled: true },
    }).catch(() => null),
  ]);

  const L: string[] = [];
  L.push(`# ${tenant.name} — their account today`);
  L.push("");
  L.push("_These facts are read straight from the phone system and refresh by themselves._");
  L.push("");

  L.push("## Their phone numbers");
  if (dids.length === 0) L.push("- No number is routed to them yet.");
  else for (const d of dids) L.push(`- ${pretty(d.e164)}`);
  L.push("");

  L.push("## Their extensions");
  const active = extensions.filter((e: any) => e.status === "ACTIVE");
  if (active.length === 0) L.push("- No extensions set up yet.");
  else for (const e of active) {
    L.push(`- **${e.extNumber}** — ${e.displayName || "unnamed"}${e.vmEmailEnabled === false ? " (voicemail-to-email off)" : ""}`);
  }
  L.push("");

  L.push("## Texting");
  if (smsNumbers.length === 0) L.push("- Texting is not set up on this account.");
  else for (const n of smsNumbers) {
    L.push(`- ${pretty(n.phoneE164)}${n.isTenantDefault ? " — the number their texts go out from" : ""}`);
  }
  L.push("");

  L.push("## Their phone menu");
  if (profiles.length === 0) {
    L.push("- They have no phone menu — callers ring straight through.");
  } else {
    for (const p of profiles) {
      const when = p.type === "business_hours" ? "open hours" : p.type === "after_hours" ? "after hours" : p.type;
      L.push(`- **${p.name}** (${when})${p.directDialEnabled ? " — callers may dial an extension directly" : ""}`);
      if (p.options.length === 0) L.push("  - no keys set up yet");
      for (const o of p.options) L.push(`  - press ${o.optionDigit} → ${keyDestination(o)}`);
    }
  }
  L.push("");

  L.push("## People with a Connect login");
  if (users.length === 0) L.push("- Nobody has a login yet.");
  else for (const u of users) {
    const who = (u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "").trim();
    L.push(`- ${who || u.email}${u.role === "TENANT_ADMIN" ? " — the account admin" : ""}${u.uiLanguage === "yi" ? ", reads the app in Yiddish" : ""}`);
  }

  const I: string[] = [];
  I.push(`- Connect tenant id: \`${tenant.id}\`; phone system tenant ${pbxLink?.pbxTenantId ?? "unknown"} (${pbxLink?.status ?? "no link"}).`);
  I.push(`- Customer since ${new Date(tenant.createdAt).toISOString().slice(0, 10)}.`);
  if (billing) {
    I.push(`- Billed on day ${billing.billingDayOfMonth} of the month; autopay ${billing.autopayEnabled ? "on" : "off"}; texting billing ${billing.smsBillingEnabled ? "on" : "off"}.`);
  } else {
    I.push("- ⛔ No billing settings row — this account has never been set up for billing.");
  }
  const inactive = extensions.length - active.length;
  if (inactive > 0) I.push(`- ${inactive} extension row(s) exist but are not ACTIVE.`);
  for (const u of users) if (u.role === "TENANT_ADMIN") I.push(`- Admin login: ${u.email}`);

  return { body: L.join("\n").trim(), internalBody: I.join("\n").trim() };
}

export interface FactsSyncSummary {
  tenants: number;
  written: number;
  unchanged: number;
  removed: number;
  errors: number;
}

/**
 * Refresh the facts document for every live company, and create one for any
 * company that does not have one yet — which is what makes a NEW client
 * automatic: nobody has to remember to do anything.
 */
export async function syncAllTenantFactsDocs(log?: {
  info: (o: any, m: string) => void;
  warn: (o: any, m: string) => void;
}): Promise<FactsSyncSummary> {
  const summary: FactsSyncSummary = { tenants: 0, written: 0, unchanged: 0, removed: 0, errors: 0 };
  const tenants = await (db as any).tenant.findMany({
    where: { pbxRemovedAt: null },
    select: { id: true, name: true },
  });
  summary.tenants = tenants.length;
  // ⛔ An empty tenant list is never a reason to delete anything — the same
  // rule the PBX-removal sweep learned the hard way.
  if (tenants.length === 0) return summary;

  const live = new Set<string>();
  for (const t of tenants) {
    try {
      const doc = await buildTenantFactsDoc(t.id);
      if (!doc) continue;
      live.add(factsSlug(t.id));
      const checksum = createHash("sha256").update(`${doc.body}\n${doc.internalBody}`).digest("hex");
      const existing = await (db as any).agentKnowledgeDoc.findUnique({
        where: { slug: factsSlug(t.id) },
        select: { id: true, checksum: true },
      });
      if (existing?.checksum === checksum) {
        summary.unchanged++;
        continue;
      }
      const data = {
        scope: "tenant",
        tenantId: t.id,
        title: `${t.name} — account facts`,
        body: doc.body,
        internalBody: doc.internalBody || null,
        checksum,
        source: "auto",
        sourcePath: null,
      };
      await (db as any).agentKnowledgeDoc.upsert({
        where: { slug: factsSlug(t.id) },
        create: { slug: factsSlug(t.id), ...data },
        update: data,
      });
      summary.written++;
    } catch (err: any) {
      summary.errors++;
      log?.warn?.({ tenantId: t.id, err: String(err?.message || err).slice(0, 200) }, "agent facts: tenant refresh failed");
    }
  }

  // A company that left the platform should stop being described.
  const stale = await (db as any).agentKnowledgeDoc.findMany({
    where: { source: "auto", slug: { startsWith: FACTS_SLUG_PREFIX } },
    select: { id: true, slug: true },
  });
  for (const row of stale) {
    if (live.has(row.slug)) continue;
    await (db as any).agentKnowledgeDoc.delete({ where: { id: row.id } });
    summary.removed++;
  }

  if (summary.written > 0 || summary.removed > 0 || summary.errors > 0) {
    log?.info?.({ factsSync: summary }, "agent tenant facts refreshed");
  }
  return summary;
}

/**
 * Refresh ONE company immediately. Called right after a tenant is provisioned
 * so a brand-new client is known about within seconds rather than at the next
 * sweep — the sweep remains the guarantee, this is just the courtesy.
 */
export async function refreshTenantFactsDoc(tenantId: string): Promise<boolean> {
  try {
    const doc = await buildTenantFactsDoc(tenantId);
    if (!doc) return false;
    const tenant = await (db as any).tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const checksum = createHash("sha256").update(`${doc.body}\n${doc.internalBody}`).digest("hex");
    const data = {
      scope: "tenant",
      tenantId,
      title: `${tenant?.name ?? "Customer"} — account facts`,
      body: doc.body,
      internalBody: doc.internalBody || null,
      checksum,
      source: "auto",
      sourcePath: null,
    };
    await (db as any).agentKnowledgeDoc.upsert({
      where: { slug: factsSlug(tenantId) },
      create: { slug: factsSlug(tenantId), ...data },
      update: data,
    });
    return true;
  } catch {
    return false;
  }
}
