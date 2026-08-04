import { db } from "@connect/db";
import { slugify } from "./pbxTenantBuild";

/**
 * provisioningIdentity.ts — the names a submission provisions under.
 *
 * THE RULE: every provisioning identity (VoIP.ms subaccount, VitalPBX tenant
 * slug, and the description used on the trunk / outbound route / route
 * selection / tenant) is unique PER SUBMISSION, never derived from the company
 * name alone. Two customers can sign up with the same company name; when every
 * name is just the company name, the second sign-up ADOPTS the first
 * customer's objects: its VoIP.ms subaccount password gets rotated (customer A
 * loses dial tone and customer B's number lands in A's account) and B's
 * extensions get built inside A's PBX tenant (cross-customer exposure).
 *
 * So: every name carries a short tag from the submission id, and the chosen
 * names are STORED on the submission (answers.provisioning) the first time
 * they are needed. Retries and resumes read the stored names and therefore
 * always match the objects an earlier attempt created — even if the company
 * name was edited mid-wizard, or the derivation scheme changes in a future
 * deploy.
 *
 * LEGACY: submissions that already started a PBX build under the old
 * company-name-only scheme (before this module existed) must keep matching
 * those objects on resume — they get the old-style names stamped instead.
 */

export type ProvisioningIdentity = {
  /** Short per-submission tag every name carries ("" on legacy stamps). */
  suffix: string;
  /** VoIP.ms subaccount username to request (≤12 chars — see subAccountName). */
  voipmsSubName: string;
  /** VitalPBX tenant name. */
  tenantSlug: string;
  /** Description used on the trunk, outbound route, route selection and tenant. */
  pbxLabel: string;
};

/** Stable per-submission tag: the last 6 usable characters of the id. */
export function identitySuffix(submissionId: string): string {
  const clean = String(submissionId || "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  return clean.slice(-6) || "0";
}

/**
 * VoIP.ms subaccount name = sanitized company + the submission tag, capped at
 * 12 characters TOTAL. VoIP.ms silently truncates longer usernames (live
 * 2026-07-28: "Thequickbrownfoxju1" came back as "Thequickbrow"), so anything
 * longer means the name we ask for is not the name we get — and the tag, the
 * part that makes the name collision-proof, would be exactly the part cut off.
 */
export function subAccountName(company: string, suffix: string): string {
  const tag = String(suffix || "").replace(/[^A-Za-z0-9]+/g, "");
  const clean = String(company || "").replace(/[^A-Za-z0-9]+/g, "") || "acct";
  return `${clean.slice(0, Math.max(1, 12 - tag.length))}${tag}`;
}

/** The old company-name-only scheme — kept ONLY for legacy resumes. */
function legacySubAccountName(company: string): string {
  const clean = String(company || "account").replace(/[^A-Za-z0-9]+/g, "").slice(0, 18) || "account";
  return `${clean}1`;
}

/** Pure derivation of the suffixed identity (exported for tests). */
export function computeProvisioningIdentity(submissionId: string, company: string): ProvisioningIdentity {
  const suffix = identitySuffix(submissionId);
  const base = String(company || "").trim() || "Account";
  return {
    suffix,
    voipmsSubName: subAccountName(base, suffix),
    tenantSlug: `${slugify(base) || "tenant"}_${suffix}`,
    pbxLabel: `${base} ${suffix}`,
  };
}

function companyOf(row: any): string {
  const answers: any = row?.answers || {};
  return String(row?.companyName || answers?.company?.companyName || answers?.submit?.companyName || "account");
}

/**
 * Did this submission already start a PBX build under the old scheme? Only
 * concrete evidence counts (a stored tenant path, or a status a build run set
 * BEFORE this module shipped). "failed" is deliberately NOT evidence — a
 * failed pre-suffix row retried today builds fresh suffixed objects, which at
 * worst duplicates that customer's own half-built infra; stamping it with
 * company-derived names could instead adopt ANOTHER customer's objects.
 * Post-deploy rows never reach this check: they stamp their identity before
 * their first status write, so the stored names always win.
 */
function isLegacy(row: any): boolean {
  if (row?.pbxTenantPath) return true;
  return ["building", "syncing", "inviting", "done"].includes(String(row?.pbxSetupStatus || ""));
}

/**
 * The submission's provisioning identity: stored names win; otherwise derive
 * (old-style for legacy rows, suffixed for everything else) and STORE the
 * result on answers.provisioning before returning it.
 *
 * Derivation is deterministic per submission, so a racing double-call (the
 * apply-number background task vs the submit orchestrator) writes identical
 * values and the race is harmless.
 */
export async function ensureProvisioningIdentity(row: any): Promise<ProvisioningIdentity> {
  const answers: any = row?.answers || {};
  const stored = answers?.provisioning;
  if (stored?.voipmsSubName && stored?.tenantSlug && stored?.pbxLabel) {
    return {
      suffix: String(stored.suffix ?? ""),
      voipmsSubName: String(stored.voipmsSubName),
      tenantSlug: String(stored.tenantSlug),
      pbxLabel: String(stored.pbxLabel),
    };
  }
  const company = companyOf(row);
  const identity: ProvisioningIdentity = isLegacy(row)
    ? { suffix: "", voipmsSubName: legacySubAccountName(company), tenantSlug: slugify(company), pbxLabel: company.trim() }
    : computeProvisioningIdentity(String(row.id), company);
  const nextAnswers = { ...answers, provisioning: identity };
  await (db as any).onboardingSubmission.update({ where: { id: row.id }, data: { answers: nextAnswers } });
  row.answers = nextAnswers;
  return identity;
}
