/**
 * One-time local bootstrap: tenant + SUPER_ADMIN user for portal login on localhost.
 * Requires Postgres (connectcomms DB) synced via `pnpm db:push` or migrate deploy.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/bootstrap-local-dev.ts
 *
 * Env overrides:
 *   LOCAL_DEV_EMAIL   (default: imwog@gmail.com)
 *   LOCAL_DEV_PASSWORD (default: LocalDev2026!)
 */
import { db } from "@connect/db";
import { resolveLocalDevEmail, resolveLocalDevPassword } from "@connect/shared";
import bcrypt from "bcryptjs";

const email = resolveLocalDevEmail();
const password = resolveLocalDevPassword();
const tenantName = process.env.LOCAL_DEV_TENANT_NAME || "Local Dev Workspace";

const LOCAL_QUEUE_CAMPAIGN_NAME = "Local Queue Demo";
const LOCAL_QUEUE_CONTACT_NAME = "Jordan Rivera (Demo Lead)";
const LOCAL_QUEUE_PHONE_RAW = "(555) 010-9001";
const LOCAL_QUEUE_PHONE_NORM = "5550109001";
const LOCAL_QUEUE_EMAIL = "demo.lead@example.com";

/** One pending lead in My Queue for localhost side-panel testing. */
async function seedLocalQueueLead(userId: string, tenantId: string) {
  let campaign = await db.crmCampaign.findFirst({
    where: { tenantId, name: LOCAL_QUEUE_CAMPAIGN_NAME },
    select: { id: true, status: true },
  });
  if (!campaign) {
    campaign = await db.crmCampaign.create({
      data: {
        tenantId,
        name: LOCAL_QUEUE_CAMPAIGN_NAME,
        description: "Sample campaign for local My Queue UI",
        status: "ACTIVE",
        priority: "NORMAL",
        createdByUserId: userId,
      },
      select: { id: true, status: true },
    });
    console.log("Created demo campaign:", LOCAL_QUEUE_CAMPAIGN_NAME);
  } else if (campaign.status !== "ACTIVE") {
    await db.crmCampaign.update({
      where: { id: campaign.id },
      data: { status: "ACTIVE" },
    });
    console.log("Reactivated demo campaign:", LOCAL_QUEUE_CAMPAIGN_NAME);
  }

  let contact = await db.contact.findFirst({
    where: { tenantId, displayName: LOCAL_QUEUE_CONTACT_NAME },
    select: { id: true },
  });
  if (!contact) {
    contact = await db.contact.create({
      data: {
        tenantId,
        displayName: LOCAL_QUEUE_CONTACT_NAME,
        company: "Connect Demo Co",
        source: "MANUAL",
        active: true,
        createdBy: userId,
        phones: {
          create: {
            type: "MOBILE",
            numberRaw: LOCAL_QUEUE_PHONE_RAW,
            numberNormalized: LOCAL_QUEUE_PHONE_NORM,
            isPrimary: true,
          },
        },
        emails: {
          create: {
            type: "WORK",
            email: LOCAL_QUEUE_EMAIL,
            isPrimary: true,
          },
        },
        crmMeta: {
          create: {
            tenantId,
            stage: "LEAD",
            assignedToUserId: userId,
            timezoneLabel: "Eastern",
            timezoneIana: "America/New_York",
            timezoneResolutionStatus: "RESOLVED",
          },
        },
      },
      select: { id: true },
    });
    console.log("Created demo contact:", LOCAL_QUEUE_CONTACT_NAME);
  } else {
    await db.crmContactMeta.upsert({
      where: { contactId: contact.id },
      create: {
        tenantId,
        contactId: contact.id,
        stage: "LEAD",
        assignedToUserId: userId,
      },
      update: {},
    });
  }

  const existingMember = await db.crmCampaignMember.findUnique({
    where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } },
    select: { id: true, assignedToUserId: true, status: true },
  });
  if (!existingMember) {
    await db.crmCampaignMember.create({
      data: {
        tenantId,
        campaignId: campaign.id,
        contactId: contact.id,
        assignedToUserId: userId,
        status: "PENDING",
        attemptCount: 0,
        sortOrder: 0,
      },
    });
    console.log("Queued demo lead for My Queue (assigned to local dev user).");
  } else {
    await db.crmCampaignMember.update({
      where: { id: existingMember.id },
      data: {
        assignedToUserId: userId,
        status: existingMember.status === "CONVERTED" || existingMember.status === "SKIPPED" || existingMember.status === "DO_NOT_CALL"
          ? "PENDING"
          : existingMember.status,
      },
    });
    console.log("Demo queue lead already exists — ensured assignment to local dev user.");
  }
  console.log("My Queue: http://localhost:3000/crm/queue");
}

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  let user = await db.user.findUnique({ where: { email } });
  if (user) {
    user = await db.user.update({
      where: { id: user.id },
      data: { passwordHash, status: "ACTIVE", role: "SUPER_ADMIN" },
    });
    console.log("Updated existing user:", user.email, "role:", user.role);
  } else {
    let tenant = await db.tenant.findFirst({ where: { name: tenantName } });
    if (!tenant) {
      tenant = await db.tenant.create({
        data: {
          name: tenantName,
          isApproved: true,
          kind: "CUSTOMER",
          smsSendMode: "TEST",
        },
      });
      console.log("Created tenant:", tenant.name, tenant.id);
    }

    user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email,
        passwordHash,
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        displayName: "Local Dev",
        emailVerifiedAt: new Date(),
      },
    });
    console.log("Created user:", user.email, "role:", user.role);
  }

  const tenants = await db.tenant.findMany({ select: { id: true, name: true } });
  let crmUsers = 0;
  for (const tenant of tenants) {
    await db.crmTenantSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, enabled: true },
      update: { enabled: true },
    });
    const tenantUsers = await db.user.findMany({
      where: { tenantId: tenant.id, status: "ACTIVE" },
      select: { id: true },
    });
    for (const tu of tenantUsers) {
      await db.crmUserAccess.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: tu.id } },
        create: { tenantId: tenant.id, userId: tu.id, enabled: true, role: "ADMIN" },
        update: { enabled: true, role: "ADMIN" },
      });
      crmUsers += 1;
    }
    console.log(`CRM enabled: ${tenant.name ?? tenant.id} (${tenantUsers.length} users)`);
  }
  console.log(`CRM ready for ${tenants.length} tenant(s), ${crmUsers} user access row(s). Re-login to refresh sidebar.`);

  await seedLocalQueueLead(user.id, user.tenantId);

  console.log("\nLocal login:");
  console.log("  URL:      http://localhost:3000/login");
  console.log("  Email:    ", email);
  console.log("  Password: ", password);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
