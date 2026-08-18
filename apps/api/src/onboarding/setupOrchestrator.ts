import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@connect/db";
import { resolvePersonDisplayName } from "@connect/shared";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";
import { syncPbxTenantDirectoryFromRows } from "../pbxTenantDirectorySync";
import { syncExtensionsFromPbx } from "../pbxExtensionSync";
import { welcomeCreatePasswordEmail } from "../userEmailTemplates";
import { getAndroidApkUrlForInviteEmail } from "../androidApkInviteUrl";
import { loadPanelConfig, PanelSession, type PanelConfig, type RobotAccount } from "./panelClient";
import { buildPbxTenant, type PbxBuildJob, type PbxPerson } from "./pbxTenantBuild";
import { ensureProvisioningIdentity } from "./provisioningIdentity";
import { readSubaccount, applyOnboardingNumber, syncOnboardingSms } from "./voipMsProvisioning";
import { queueOnboardingSignupReport } from "./adminSignupReport";

/**
 * setupOrchestrator — everything that happens after the customer presses
 * "Launch my phone system".
 *
 *   1. ENSURE NUMBER   — VoIP.ms stage must be ready (retried here if it
 *                        failed / never ran while they filled the wizard).
 *   2. BUILD PBX       — full VitalPBX tenant via the panel robot flow
 *                        (trunk → outbound route → route selection → tenant →
 *                        extensions incl. cell devices → inbound route).
 *   3. SYNC CONNECT    — refresh the PBX tenant directory, link the new PBX
 *                        tenant to a Connect tenant, run the extension sync,
 *                        and HARD-VERIFY every requested extension landed as a
 *                        Connect extension + user with SIP credentials. The
 *                        sync alone has historically been unreliable, so this
 *                        stage retries with backoff and then deterministically
 *                        repairs anything the sync missed (users, ownership)
 *                        instead of hoping the next cycle fixes it.
 *   4. INVITE          — once SIP state is verified, email every person their
 *                        login-setup invitation.
 *
 * Progress is tracked on OnboardingSubmission.pbxSetupStatus:
 *   queued → building → syncing → inviting → done | failed
 * Every step also writes a human-readable OnboardingEvent, so the admin detail
 * page shows a full timeline.
 *
 * SAFETY GATE: panel writes only happen when ONBOARDING_PBX_AUTO_SETUP="on".
 * With the gate off (default) the run is a fully-logged dry run and no PBX,
 * tenant, user, or email state is created.
 */

const INVITE_TOKEN_HOURS = 72;

function pbxAutoSetupEnabled(): boolean {
  return String(process.env.ONBOARDING_PBX_AUTO_SETUP || "").toLowerCase() === "on";
}

async function logEvent(submissionId: string, message: string): Promise<void> {
  try {
    await (db as any).onboardingEvent.create({
      data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) },
    });
  } catch {
    /* event logging is best-effort */
  }
}

async function setPbxStatus(submissionId: string, pbxSetupStatus: string, extra: Record<string, unknown> = {}): Promise<void> {
  await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { pbxSetupStatus, ...extra } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry backoff base — overridable so tests don't sleep for real seconds. */
const retryBaseMs = () => Number(process.env.ONBOARDING_RETRY_BASE_MS || 3000);

// ── Panel account pool (in-process) ──────────────────────────────────────────
// One PBX build per robot account at a time, so parallel onboardings never
// collide on the per-session "current tenant" cookie or on panel Apply locks.

const busyAccounts = new Set<string>();
const accountWaiters: Array<() => void> = [];

export async function acquireAccount(cfg: PanelConfig): Promise<RobotAccount> {
  for (;;) {
    const free = cfg.accounts.find((a) => !busyAccounts.has(a.id));
    if (free) {
      busyAccounts.add(free.id);
      return free;
    }
    await new Promise<void>((resolve) => accountWaiters.push(resolve));
  }
}

export function releaseAccount(account: RobotAccount): void {
  busyAccounts.delete(account.id);
  const w = accountWaiters.shift();
  if (w) w();
}

// ── Connect-side helpers ──────────────────────────────────────────────────────

function portalPublicUrl(pathname: string): string {
  const origin = String(
    process.env.PORTAL_PUBLIC_URL || process.env.CONNECT_APP_URL || process.env.APP_PUBLIC_URL || "https://app.connectcomunications.com",
  ).replace(/\/$/, "");
  return `${origin}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

async function queueInviteEmail(input: {
  user: { id: string; tenantId: string; email: string; displayName?: string | null; firstName?: string | null; lastName?: string | null };
  tenantName: string;
  extensionNumber: string | null;
}): Promise<void> {
  const token = `cp_${randomBytes(32).toString("base64url")}`;
  await (db as any).userPasswordToken.create({
    data: {
      userId: input.user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      type: "INVITE",
      expiresAt: new Date(Date.now() + INVITE_TOKEN_HOURS * 3600_000),
      createdBy: null,
    },
  });
  // Same single rule as every other surface: the PBX extension name wins. For a
  // sign-up that IS the name the customer typed, because pbxTenantBuild names
  // the extension after the person (`ext_name: person.name`) — so this needs no
  // onboarding-specific branch.
  // ⛔ try/catch, not `.catch()` — a missing model accessor throws synchronously
  // and would abort the invitation rather than just losing the nicer name.
  let namingExtension: { displayName?: string | null } | null = null;
  try {
    namingExtension =
      (await (db as any).extension?.findFirst?.({
        where: { ownerUserId: input.user.id, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { displayName: true },
      })) ?? null;
  } catch {
    namingExtension = null;
  }
  const userName = resolvePersonDisplayName(
    {
      extensionDisplayName: namingExtension?.displayName ?? null,
      displayName: input.user.displayName,
      firstName: input.user.firstName,
      lastName: input.user.lastName,
      email: input.user.email,
    },
    "User",
  );
  const template = welcomeCreatePasswordEmail({
    userName,
    userFirstName: userName,
    tenantName: input.tenantName,
    extensionNumber: input.extensionNumber,
    setupUrl: portalPublicUrl(`/auth/invite/accept?token=${encodeURIComponent(token)}`),
    expiresHours: INVITE_TOKEN_HOURS,
    // Same Android download-page link the admin invite path sends. This was
    // hardcoded null, so every self-service sign-up got an invite with no APK.
    androidApkUrl: await getAndroidApkUrlForInviteEmail(),
  });
  // Same semantics as the admin invite/resend-invite path: the account is
  // INVITED until they set their password through the link.
  await (db as any).user
    .update({ where: { id: input.user.id }, data: { status: "INVITED", forcePasswordReset: true } })
    .catch(() => {});
  await (db as any).emailJob.create({
    data: {
      tenantId: input.user.tenantId,
      type: "USER_INVITE",
      toEmail: input.user.email,
      subject: template.subject,
      htmlBody: template.html,
      textBody: template.text,
      status: "QUEUED",
      attempts: 0,
      nextRunAt: new Date(),
    },
  });
}

/** Load the (single) enabled PBX instance + an API client for it. */
async function loadPbxInstanceClient(): Promise<{ instanceId: string; client: VitalPbxClient } | null> {
  const instance = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  if (!instance) return null;
  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = new VitalPbxClient({
    baseUrl: instance.baseUrl,
    apiToken: auth.token,
    apiSecret: auth.secret,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 20000),
    simulate: (process.env.PBX_SIMULATE || "false").toLowerCase() === "true",
  });
  return { instanceId: String(instance.id), client };
}

/**
 * Find the new PBX tenant in the directory (by slug/description) with retries —
 * VitalPBX needs a moment after Apply Changes before the tenant shows up in
 * its own API list.
 */
async function findPbxDirectoryEntry(
  instanceId: string,
  client: VitalPbxClient,
  slug: string,
  label: string,
  attempts = 6,
): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const tenants = await client.listTenants();
      await syncPbxTenantDirectoryFromRows(db as any, instanceId, tenants as unknown[]);
    } catch {
      /* transient — retry below */
    }
    const dirs = await (db as any).pbxTenantDirectory.findMany({ where: { pbxInstanceId: instanceId } });
    // slug and label are the submission's UNIQUE provisioning identity, never
    // the bare company name — matching by company name here adopted the wrong
    // customer's tenant when two sign-ups shared a name.
    const hit = dirs.find(
      (d: any) =>
        String(d.tenantSlug || "").toLowerCase() === slug.toLowerCase() ||
        String(d.displayName || "").trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (hit) return hit;
    await sleep(Math.min(retryBaseMs() * 5, retryBaseMs() * (i + 1)));
  }
  return null;
}

/**
 * Ensure the Connect Tenant + TenantPbxLink for the new PBX tenant.
 *
 * Priority order:
 *   1. A tenant already linked to this PBX tenant (a re-run, or the background
 *      auto-sync raced us) — reuse it and fix its name.
 *   2. The tenant checkout already created (`preferredTenantId` =
 *      submission.createdTenantId) — the customer's invoice, vaulted card, and
 *      autopay hang off THIS tenant, so the phone system must land on it too.
 *      Creating a fresh tenant here instead was the double-tenant bug: the
 *      card-on-file stayed on an empty orphan and month-2 autopay never ran.
 *   3. Only when neither exists: create a fresh tenant.
 */
async function ensureConnectTenant(
  instanceId: string,
  dirEntry: any,
  company: string,
  /** Answered in the wizard: does this customer want Yiddish offered at all?
   *  Only ever turns the offer ON here — a customer who later switched it off
   *  should not have it switched back on by a re-run of setup. */
  yiddish?: boolean,
  preferredTenantId?: string | null,
): Promise<string> {
  const existingLink = await (db as any).tenantPbxLink.findFirst({
    where: { pbxInstanceId: instanceId, pbxTenantId: String(dirEntry.vitalTenantId) },
  });
  if (existingLink) {
    await (db as any).tenant.update({
      where: { id: existingLink.tenantId },
      data: { name: company, ...(yiddish ? { yiddishEnabled: true } : {}) },
    }).catch(() => {});
    if (existingLink.status !== "LINKED") {
      await (db as any).tenantPbxLink.update({ where: { id: existingLink.id }, data: { status: "LINKED", lastError: null } }).catch(() => {});
    }
    return String(existingLink.tenantId);
  }
  if (preferredTenantId) {
    const existing = await (db as any).tenant.findUnique({ where: { id: preferredTenantId }, select: { id: true } });
    if (existing) {
      await (db as any).tenant.update({
        where: { id: preferredTenantId },
        data: { name: company, ...(yiddish ? { yiddishEnabled: true } : {}) },
      }).catch(() => {});
      // Upsert on tenantId (it's unique): a rebuilt PBX tenant gets the link
      // re-pointed instead of a unique-violation failing the whole setup.
      await (db as any).tenantPbxLink.upsert({
        where: { tenantId: preferredTenantId },
        create: {
          tenantId: preferredTenantId,
          pbxInstanceId: instanceId,
          pbxTenantId: String(dirEntry.vitalTenantId),
          pbxTenantCode: dirEntry.tenantCode ?? null,
          status: "LINKED",
        },
        update: {
          pbxInstanceId: instanceId,
          pbxTenantId: String(dirEntry.vitalTenantId),
          pbxTenantCode: dirEntry.tenantCode ?? null,
          status: "LINKED",
          lastError: null,
        },
      });
      return preferredTenantId;
    }
  }
  const created = await (db as any).$transaction(async (tx: any) => {
    const t = await tx.tenant.create({ data: { name: company, kind: "CUSTOMER", isApproved: true, yiddishEnabled: !!yiddish } });
    await tx.tenantPbxLink.create({
      data: {
        tenantId: t.id,
        pbxInstanceId: instanceId,
        pbxTenantId: String(dirEntry.vitalTenantId),
        pbxTenantCode: dirEntry.tenantCode ?? null,
        status: "LINKED",
      },
    });
    return t;
  });
  return String(created.id);
}

export type ExtensionVerification = {
  extNumber: string;
  extensionOk: boolean;
  sipOk: boolean;
  userOk: boolean;
  email: string | null;
};

/**
 * HARD verification + repair pass for one tenant's requested extensions.
 *
 * The bulk sync (syncExtensionsFromPbx) has historically been "best effort":
 * user creation is silently skipped on email conflicts, ownership can stay
 * unset, and failures vanish into catch-alls. This pass makes the outcome
 * deterministic for onboarding:
 *   - every requested extension must exist as a Connect Extension,
 *   - every requested extension with an email gets a Connect user (created if
 *     the sync didn't) and the extension's ownerUserId set,
 *   - SIP state (PbxExtensionLink) must exist for the extension.
 */
export async function verifyAndRepairTenantExtensions(
  tenantId: string,
  requested: Array<{ extNumber: string; displayName?: string | null; email?: string | null }>,
): Promise<ExtensionVerification[]> {
  const out: ExtensionVerification[] = [];
  for (const req of requested) {
    const extNumber = String(req.extNumber).trim();
    const email = String(req.email || "").trim().toLowerCase() || null;
    const v: ExtensionVerification = { extNumber, extensionOk: false, sipOk: false, userOk: !email, email };

    const ext = await (db as any).extension.findUnique({
      where: { tenantId_extNumber: { tenantId, extNumber } },
      include: { pbxLink: true },
    });
    if (!ext) {
      out.push(v);
      continue;
    }
    v.extensionOk = true;
    // Same bar as the admin "Sync SIP" button (userExtensionProvisioning):
    // a WebRTC device must exist AND its SIP password must be captured —
    // that's what makes the softphone actually register. A bare link row is
    // not "synced".
    v.sipOk = !!(ext.pbxLink && ext.pbxLink.pbxSipUsername && ext.pbxLink.webrtcEnabled && ext.pbxLink.sipPasswordEncrypted);

    if (email) {
      let user = await (db as any).user.findUnique({ where: { email } });
      if (user && user.tenantId !== tenantId) {
        // Email belongs to a user in ANOTHER tenant. Never hijack it — this
        // extension keeps working, but no Connect login/invite is possible for
        // this address. Surfaced (not swallowed) so the timeline shows it.
        v.userOk = false;
        out.push(v);
        continue;
      }
      if (!user) {
        const tempPassword = randomBytes(24).toString("base64url");
        user = await (db as any).user.create({
          data: {
            tenantId,
            email,
            passwordHash: await bcrypt.hash(tempPassword, 10),
            role: "USER",
            displayName: String(req.displayName || "").trim() || null,
          },
        });
      }
      if (ext.ownerUserId !== user.id) {
        await (db as any).extension.update({ where: { id: ext.id }, data: { ownerUserId: user.id } });
      }
      v.userOk = true;
    }
    out.push(v);
  }
  return out;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * The number stage runs as its own background task (kicked when the customer
 * leaves the "Your number" step). A fast customer can hit "Launch" while it is
 * still buying the DID — in that case WAIT for it to finish instead of failing
 * with number_stage_not_ready (live incident 2026-07-26: submit 6s after
 * apply-number permanently killed the whole setup).
 */
async function waitForNumberStage(submissionId: string): Promise<any> {
  const timeoutMs = Number(process.env.ONBOARDING_NUMBER_WAIT_MS || 5 * 60_000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cur = await (db as any).onboardingSubmission.findUnique({
      where: { id: submissionId },
      include: { requestedExtensions: true },
    } as any);
    if (!cur || cur.numberStatus !== "provisioning" || Date.now() >= deadline) return cur;
    await sleep(retryBaseMs());
  }
}

/**
 * Called when the background number stage finishes: if the customer already
 * submitted (and the setup either hasn't run or bailed waiting on the number),
 * pick the pipeline back up. Together with waitForNumberStage this makes the
 * apply-number ⇄ submit race impossible to lose: whichever side finishes last
 * carries the setup forward.
 */
export async function resumeSetupIfSubmitted(submissionId: string): Promise<void> {
  const row = await (db as any).onboardingSubmission.findUnique({ where: { id: submissionId } });
  if (!row || row.status !== "SUBMITTED") return;
  if (row.pbxSetupStatus === "done") return;
  await syncOnboardingSms(submissionId).catch(() => { /* logged inside */ });
  await runOnboardingSetup(submissionId);
}

// One run per submission per process: the submit chain and the apply-number
// completion hook can both call runOnboardingSetup at nearly the same moment.
const setupsInFlight = new Set<string>();

export async function runOnboardingSetup(submissionId: string): Promise<void> {
  if (setupsInFlight.has(submissionId)) return;
  setupsInFlight.add(submissionId);
  try {
    await runOnboardingSetupInner(submissionId);
  } finally {
    setupsInFlight.delete(submissionId);
  }
}

async function runOnboardingSetupInner(submissionId: string): Promise<void> {
  let row = await (db as any).onboardingSubmission.findUnique({
    where: { id: submissionId },
    include: { requestedExtensions: true },
  } as any);
  if (!row) return;
  if (row.pbxSetupStatus === "done") return;
  const live = pbxAutoSetupEnabled();
  // A completed DRY run stays re-runnable: once the gate is turned on, the
  // same submission can be re-kicked and provisioned for real.
  if (row.pbxSetupStatus === "dry_run_done" && !live) return;
  if (row.pbxSetupStatus === "building" || row.pbxSetupStatus === "syncing" || row.pbxSetupStatus === "inviting") {
    // In flight — but if the API restarted mid-run, the status would stay
    // stuck forever. Rows untouched for longer than the stale window are
    // treated as interrupted and resumed instead of blocked.
    const staleMs = Number(process.env.ONBOARDING_INFLIGHT_STALE_MS || 15 * 60_000);
    const age = Date.now() - new Date(row.updatedAt || 0).getTime();
    if (age < staleMs) return;
    await logEvent(submissionId, `Setup was interrupted mid-run (stuck in "${row.pbxSetupStatus}" for ${Math.round(age / 60000)} min) — resuming.`);
  }

  if (row.numberStatus === "provisioning") {
    await logEvent(submissionId, "Number stage still provisioning — waiting for it before building.");
    const waited = await waitForNumberStage(submissionId);
    if (!waited) return;
    row = waited;
  }

  const company = String(row.companyName || "").trim();
  const people: PbxPerson[] = (row.requestedExtensions || []).map((e: any) => ({
    name: String(e.displayName || e.extNumber),
    ext: String(e.extNumber),
    email: e.email || undefined,
    vmPassword: e.vmPassword || undefined,
    cellMode: (e.cellMode as "also" | "only" | null) || null,
    cellNumber: e.cellNumber || null,
  }));

  try {
    // The unique names this submission provisions under. Resolved BEFORE the
    // first status write: the legacy fallback inside (for pre-suffix builds)
    // reads pbxSetupStatus as loaded, and setPbxStatus would clobber it.
    const identity = await ensureProvisioningIdentity(row);

    await setPbxStatus(submissionId, "queued", { setupError: null });

    // ── 1. The number stage must be ready ───────────────────────────────────
    // "ready_dryrun" counts only while WE are also in dry-run mode; a live run
    // must redo the number stage for real (the dry-run credentials were never
    // registered with VoIP.ms).
    const numberOk = (s: string | null) => s === "ready" || (!live && s === "ready_dryrun");
    let fresh = row;
    if (!numberOk(row.numberStatus)) {
      if (live && row.numberStatus === "ready_dryrun") {
        await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: null } });
        await logEvent(submissionId, "Previous number stage was a dry run — re-provisioning for real.");
      }
      const res = await applyOnboardingNumber(submissionId);
      fresh = await (db as any).onboardingSubmission.findUnique({ where: { id: submissionId }, include: { requestedExtensions: true } } as any);
      if (!numberOk(fresh.numberStatus)) {
        throw new Error(`number_stage_not_ready (${res.detail})`);
      }
    }
    const sub = readSubaccount(fresh);
    const did = String(fresh.provisionedDid || "");
    if (!sub || did.length !== 10) throw new Error("number_stage_missing_subaccount_or_did");
    if (!company) throw new Error("company_name_missing");
    if (!people.length) throw new Error("no_extensions_requested");

    // ── 2. Build the PBX tenant ─────────────────────────────────────────────
    await setPbxStatus(submissionId, "building");
    // A porting sign-up prepares the customer's REAL number alongside the
    // temporary one: both go into the tenant, both get inbound routes, and
    // the real number is the outbound caller ID from day one. Port day is
    // then only a VoIP.ms repoint (see portLanding.ts).
    const freshAnswers: any = fresh.answers || {};
    const numberChoice = String(fresh.phoneNumberChoice || freshAnswers?.phone?.choice || "new");
    const portedDigits = String(freshAnswers?.phone?.details?.numbers ?? "")
      .replace(/\D/g, "")
      .replace(/^1(?=\d{10}$)/, "");
    const portedDid = numberChoice === "port" && portedDigits.length === 10 ? portedDigits : null;
    const job: PbxBuildJob = {
      company,
      slug: identity.tenantSlug,
      label: identity.pbxLabel,
      did,
      portedDid,
      voipms: { user: sub.username, pass: sub.password, server: sub.server },
      people,
    };

    if (!live) {
      await logEvent(
        submissionId,
        `[dry-run] Build VitalPBX tenant "${company}": trunk ${sub.username}@${sub.server}, DID ${did}, ${people.length} extension(s)` +
          `${people.some((p) => p.cellNumber) ? ` (incl. ${people.filter((p) => p.cellNumber).length} with cell routing)` : ""}, inbound route → ext ${people[0].ext}.`,
      );
      await logEvent(submissionId, "[dry-run] Would sync extensions into Connect, verify users + SIP, and email every extension its invitation.");
      await setPbxStatus(submissionId, "dry_run_done");
      await logEvent(submissionId, "[dry-run] Setup pipeline complete (enable ONBOARDING_PBX_AUTO_SETUP to run for real).");
      return;
    }

    const panelCfg = loadPanelConfig();
    if (!panelCfg) throw new Error("panel_not_configured (ONBOARDING_PANEL_BASE_URL / ONBOARDING_ROBOT_*)");

    // The read-only REST tenants list is the reliable source for tenant path
    // hashes (the panel's tenants form doesn't render them).
    const pbx = await loadPbxInstanceClient();
    if (!pbx) throw new Error("no_enabled_pbx_instance");
    const resolveTenantPath = async (slug: string, label: string): Promise<string | null> => {
      // slug/label are the unique per-submission identity (buildPbxTenant
      // passes them through) — never match on the bare company name here.
      try {
        const tenants = (await pbx.client.listTenants()) as any[];
        const hit = tenants.find(
          (t) =>
            String(t?.name || "").toLowerCase() === slug.toLowerCase() ||
            String(t?.description || "").trim().toLowerCase() === label.trim().toLowerCase(),
        );
        return hit?.path ? String(hit.path) : null;
      } catch {
        return null;
      }
    };

    const account = await acquireAccount(panelCfg);
    let tenantPath: string;
    try {
      const session = await new PanelSession(panelCfg.baseUrl, account).login();
      const result = await buildPbxTenant(
        session,
        panelCfg.mainTenant,
        job,
        (msg) => {
          void logEvent(submissionId, `PBX build: ${msg}`);
        },
        resolveTenantPath,
      );
      tenantPath = result.tenantPath;
    } finally {
      releaseAccount(account);
    }
    await setPbxStatus(submissionId, "syncing", { pbxTenantPath: tenantPath });
    await logEvent(submissionId, `PBX tenant built (path ${tenantPath}). Syncing into Connect…`);

    // ── 3. Sync + hard-verify into Connect ──────────────────────────────────

    const slug = identity.tenantSlug;
    const dirEntry = await findPbxDirectoryEntry(pbx.instanceId, pbx.client, slug, identity.pbxLabel);
    if (!dirEntry) throw new Error(`pbx_tenant_not_in_directory (slug ${slug})`);

    // The wizard's language question rides in the answers JSON, so no extra
    // column was needed on the submission.
    const wantsYiddish = String(((fresh?.answers as any)?.language ?? "")).toLowerCase() === "yi";
    const checkoutTenantId = fresh?.createdTenantId ? String(fresh.createdTenantId) : null;
    const tenantId = await ensureConnectTenant(pbx.instanceId, dirEntry, company, wantsYiddish, checkoutTenantId);
    if (checkoutTenantId && tenantId !== checkoutTenantId) {
      // The background auto-sync provisioned its own tenant for the new PBX
      // tenant before we got here, so the phone system is NOT on the tenant
      // that holds the sign-up invoice and card. Move the billing across —
      // otherwise autopay points at an empty orphan and month 2 never charges.
      const { adoptOnboardingBilling, deleteTenantIfEmpty } = await import("./onboardingBillingAdoption");
      const moved = await adoptOnboardingBilling(db as any, checkoutTenantId, tenantId);
      await logEvent(
        submissionId,
        `Moved sign-up billing to the live tenant (${moved.invoicesMoved} invoice(s), ${moved.paymentMethodsMoved} card(s) on file` +
          `${moved.autoBillingCarried ? ", autopay" : ""}).`,
      );
      const cleanup = await deleteTenantIfEmpty(db as any, checkoutTenantId).catch((e: any) => ({ deleted: false, reason: String(e?.message || e) }));
      if (!cleanup.deleted) {
        await logEvent(submissionId, `Checkout tenant ${checkoutTenantId} left in place (${cleanup.reason}).`);
      }
    }
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { createdTenantId: tenantId } });

    // Whichever tenant the phone system landed on (checkout's, the auto-sync
    // race's, or a fresh one) must bill month 2 exactly like the sign-up quote:
    // E911 per number + the flat telecom fee. Guarded inside — a tenant whose
    // billing an operator already configured is left alone.
    {
      const { ensureOnboardingBillingDefaults } = await import("./onboardingBillingDefaults");
      const { quoteInputForSubmission } = await import("./quoteInput");
      const stamp = await ensureOnboardingBillingDefaults(db as any, tenantId, {
        smsEnabled: !!fresh.smsEnabled,
        tollFreeNumber: quoteInputForSubmission(fresh).tollFreeNumber,
      });
      if (stamp.stamped) {
        await logEvent(submissionId, "Monthly billing set up to match the sign-up quote (E911 per number + telecom & regulatory fees).");
      }
    }

    // Retry the extension sync until every requested extension is present and
    // SIP-synced (VitalPBX can lag right after Apply Changes). Then repair
    // anything the sync skipped (users, ownership) deterministically.
    let verifications: ExtensionVerification[] = [];
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await syncExtensionsFromPbx(db as any, pbx.instanceId, pbx.client as any, { vitalTenantId: String(dirEntry.vitalTenantId) });
      } catch (e: any) {
        await logEvent(submissionId, `Extension sync attempt ${attempt} failed: ${String(e?.message || e).slice(0, 160)}`);
      }
      verifications = await verifyAndRepairTenantExtensions(tenantId, fresh.requestedExtensions || []);
      const allOk = verifications.every((v) => v.extensionOk && v.sipOk && v.userOk);
      if (allOk) break;
      if (attempt < maxAttempts) await sleep(Math.min(retryBaseMs() * 5, retryBaseMs() * attempt));
    }

    const missingExt = verifications.filter((v) => !v.extensionOk).map((v) => v.extNumber);
    const missingSip = verifications.filter((v) => v.extensionOk && !v.sipOk).map((v) => v.extNumber);
    const emailConflicts = verifications.filter((v) => v.email && !v.userOk).map((v) => `${v.extNumber} (${v.email})`);
    if (missingExt.length) throw new Error(`extensions_missing_after_sync: ${missingExt.join(", ")}`);
    if (missingSip.length) throw new Error(`sip_not_synced: ${missingSip.join(", ")}`);
    if (emailConflicts.length) {
      await logEvent(submissionId, `Email already in use by another organization — no invite sent for: ${emailConflicts.join("; ")}.`);
    }
    // "Sent 0 invitation email(s)" must never be a mystery: spell out when
    // extensions simply have no address to invite (live confusion 2026-07-27).
    const noEmail = verifications.filter((v) => !v.email).map((v) => v.extNumber);
    if (noEmail.length) {
      await logEvent(submissionId, `No email entered for extension(s) ${noEmail.join(", ")} — they cannot receive a login invite.`);
    }
    await logEvent(submissionId, `All ${verifications.length} extension(s) verified in Connect (users + SIP synced).`);

    // ── 3b. Account owner ───────────────────────────────────────────────────
    // The wizard marks one extension as the owner (defaulting to the first).
    // That person is promoted to TENANT_ADMIN — without this, every user the
    // build creates is a plain USER and the brand-new account has nobody who
    // can administer it (or even open IVR Studio for the first-run setup).
    const ownerExtNumber = String(
      ((fresh?.answers as any)?.ownerExtNumber ?? "") || (fresh.requestedExtensions?.[0]?.extNumber ?? ""),
    ).trim();
    if (ownerExtNumber) {
      const ownerExt = await (db as any).extension.findUnique({
        where: { tenantId_extNumber: { tenantId, extNumber: ownerExtNumber } },
      });
      const ownerUser = ownerExt?.ownerUserId
        ? await (db as any).user.findUnique({ where: { id: ownerExt.ownerUserId } })
        : null;
      // Never demote, and never touch platform staff: only a plain USER on
      // THIS tenant (i.e. someone this build just created or synced) goes up.
      if (ownerUser && ownerUser.tenantId === tenantId && ownerUser.role === "USER") {
        await (db as any).user.update({ where: { id: ownerUser.id }, data: { role: "TENANT_ADMIN" } });
        await logEvent(submissionId, `Owner: ${ownerUser.email || "user"} (ext ${ownerExtNumber}) is the account admin.`);
      } else if (!ownerUser) {
        await logEvent(
          submissionId,
          `Owner extension ${ownerExtNumber} has no login (no email, or the email belongs to another organization) — no account admin was created. Assign one from the admin panel.`,
        );
      }
    }

    // ── 4. Invitations ──────────────────────────────────────────────────────
    await setPbxStatus(submissionId, "inviting");
    let invited = 0;
    for (const v of verifications) {
      if (!v.email || !v.userOk) continue;
      const user = await (db as any).user.findUnique({ where: { email: v.email } });
      if (!user) continue;
      await queueInviteEmail({ user, tenantName: company, extensionNumber: v.extNumber });
      invited++;
    }
    await logEvent(submissionId, `Sent ${invited} invitation email(s).`);

    await setPbxStatus(submissionId, "done");
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { status: "ACTIVE" } }).catch(() => {});
    await logEvent(submissionId, `Setup complete — tenant "${company}" is live with ${people.length} extension(s) on ${did}.`);
    // The owner's plain-English sign-up report — one per finished sign-up.
    await queueOnboardingSignupReport(submissionId, "success");
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    await setPbxStatus(submissionId, "failed", { setupError: msg }).catch(() => {});
    await logEvent(submissionId, `Setup failed: ${msg}`);
    // Failures get reported too — a paid customer without a working system is
    // exactly what the owner wants to hear about immediately.
    await queueOnboardingSignupReport(submissionId, "failed");
  }
}
