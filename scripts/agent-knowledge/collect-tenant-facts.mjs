/**
 * Collects the live facts each company's knowledge document is built from.
 *
 * Runs INSIDE app-api-1 (it needs the generated Prisma client and the database
 * URL) and prints one JSON object to stdout:
 *
 *   docker exec -i -w /app/packages/db app-api-1 node - < collect-tenant-facts.mjs
 *
 * Read-only. It writes nothing, anywhere. The markdown is generated on the
 * developer machine from this output by `render-tenant-docs.mjs`, so the
 * wording is reviewable in git rather than produced on the server.
 */
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  // Live companies only. ⛔ pbxRemovedAt is not null for 21 rows that no Connect
  // screen shows — a knowledge document for one of those would describe a
  // company that no longer exists.
  const tenants = await p.tenant.findMany({
    where: { pbxRemovedAt: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { name: "asc" },
  });

  const out = [];
  for (const t of tenants) {
    const [extensions, dids, smsNumbers, users, profiles, hours, pbxLink, billing] = await Promise.all([
      p.extension.findMany({
        where: { tenantId: t.id },
        select: { extNumber: true, displayName: true, status: true, pbxUserEmail: true, vmEmailEnabled: true, ownerUserId: true },
        orderBy: { extNumber: "asc" },
      }),
      p.pbxTenantInboundDid.findMany({
        where: { connectTenantId: t.id, active: true },
        select: { e164: true, pbxInboundId: true },
        orderBy: { e164: "asc" },
      }),
      p.tenantSmsNumber.findMany({
        where: { tenantId: t.id },
        select: { phoneE164: true, isTenantDefault: true, active: true, smsCapable: true },
      }),
      p.user.findMany({
        where: { tenantId: t.id },
        select: { email: true, firstName: true, lastName: true, displayName: true, role: true, uiLanguage: true },
        orderBy: { createdAt: "asc" },
        take: 50,
      }),
      p.ivrRouteProfile.findMany({
        where: { tenantId: t.id },
        select: {
          id: true, name: true, type: true, pbxPromptRef: true, directDialEnabled: true,
          options: { select: { optionDigit: true, destinationType: true, destinationRef: true, label: true, enabled: true }, orderBy: { optionDigit: "asc" } },
        },
      }).catch(() => []),
      p.ivrScheduleConfig.findFirst({ where: { tenantId: t.id }, select: { businessHoursRules: true, timezone: true } }).catch(() => null),
      p.tenantPbxLink.findFirst({ where: { tenantId: t.id }, select: { status: true, pbxTenantId: true } }).catch(() => null),
      p.tenantBillingSettings.findFirst({
        where: { tenantId: t.id },
        select: { smsBillingEnabled: true, billingDayOfMonth: true, autopayEnabled: true },
      }).catch(() => null),
    ]);

    // 90-day call volume, so the document can say how busy they are — a fact
    // that changes how an answer should be phrased ("your busiest line").
    let callCount = 0;
    try {
      callCount = await p.connectCdr.count({
        where: { tenantId: t.id, startedAt: { gte: new Date(Date.now() - 90 * 864e5) } },
      });
    } catch { /* table name drift — the document simply omits the figure */ }

    out.push({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      extensions,
      dids,
      smsNumbers,
      users,
      profiles,
      hours,
      pbxLink,
      billing,
      callCount,
    });
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), tenants: out }));
  await p.$disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
