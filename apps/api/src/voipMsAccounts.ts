/**
 * Multiple VoIP.ms accounts (2026-09-15, Izzy: "attach a second voip.ms account").
 *
 * One `GlobalVoipMsConfig` row per account. The PRIMARY account keeps the
 * historical row id "default" — every legacy consumer that does
 * `findUnique({ where: { id: "default" } })` (onboarding provisioning, the
 * trunk guardrail, billing SMS, the port watchdog) keeps reading the primary
 * account and is deliberately untouched. Additional accounts get random ids
 * and a label, and matter only where a DID decides: each `TenantSmsNumber`
 * carries `voipmsAccountId`, stamped by the DID sync, and the inbound poller /
 * outbound sends resolve credentials from THAT row.
 */

import { randomUUID } from "node:crypto";
import { db as realDb } from "@connect/db";
import { decryptJson } from "@connect/security";

export const VOIPMS_PRIMARY_ACCOUNT_ID = "default";

export type VoipMsAccountCreds = { username: string; password: string; apiBaseUrl?: string };

export type VoipMsAccountSummary = {
  id: string;
  /** Human name. The legacy primary row has none; callers show "Primary account". */
  label: string | null;
  isPrimary: boolean;
  hasCredentials: boolean;
  usernameHint: string | null;
  apiBaseUrl: string | null;
  lastHealthOk: boolean | null;
  lastHealthAt: string | null;
  lastHealthMessage: string | null;
  lastDidsSyncAt: string | null;
  /** How many synced DIDs are stamped to this account. */
  numberCount: number;
};

type DbLike = {
  globalVoipMsConfig: {
    findUnique: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    delete: (args: any) => Promise<any>;
  };
  tenantSmsNumber: { groupBy?: (args: any) => Promise<any[]>; count: (args: any) => Promise<number> };
};

function decryptCreds(row: any): VoipMsAccountCreds | null {
  if (!row?.credentialsEncrypted) return null;
  try {
    const c = decryptJson<VoipMsAccountCreds>(row.credentialsEncrypted);
    if (!c?.username || !c?.password) return null;
    return { username: c.username, password: c.password, apiBaseUrl: row.apiBaseUrl || c.apiBaseUrl };
  } catch {
    return null;
  }
}

/** Credentials for ONE account row. Null when the row or its secrets are unusable. */
export async function loadVoipMsAccountCreds(accountId: string, db: DbLike = realDb as any): Promise<VoipMsAccountCreds | null> {
  const row = await db.globalVoipMsConfig.findUnique({ where: { id: accountId || VOIPMS_PRIMARY_ACCOUNT_ID } });
  return decryptCreds(row);
}

/**
 * Credentials for the account a NUMBER belongs to. The row's `voipmsAccountId`
 * decides; a missing row (a from-number never synced) falls back to the
 * primary account, which is exactly the pre-multi-account behaviour.
 */
export async function loadVoipMsCredsForNumber(
  phoneE164: string,
  db: (DbLike & { tenantSmsNumber: { findUnique: (args: any) => Promise<any> } }) | any = realDb,
): Promise<{ accountId: string; creds: VoipMsAccountCreds | null }> {
  const numberRow = await db.tenantSmsNumber
    .findUnique({ where: { phoneE164 }, select: { voipmsAccountId: true } })
    .catch(() => null);
  const accountId = String(numberRow?.voipmsAccountId || VOIPMS_PRIMARY_ACCOUNT_ID);
  return { accountId, creds: await loadVoipMsAccountCreds(accountId, db) };
}

/** Every account row, primary first, with per-account DID counts. */
export async function listVoipMsAccounts(db: DbLike = realDb as any): Promise<VoipMsAccountSummary[]> {
  const rows = await db.globalVoipMsConfig.findMany({ orderBy: { createdAt: "asc" } });
  const counts = new Map<string, number>();
  if (typeof db.tenantSmsNumber.groupBy === "function") {
    const grouped = await db.tenantSmsNumber
      .groupBy({ by: ["voipmsAccountId"], _count: { _all: true } })
      .catch(() => [] as any[]);
    for (const g of grouped) counts.set(String(g.voipmsAccountId), Number(g._count?._all ?? 0));
  }
  const summaries = rows.map((row) => {
    const creds = decryptCreds(row);
    return {
      id: row.id,
      label: row.label ?? null,
      isPrimary: row.id === VOIPMS_PRIMARY_ACCOUNT_ID,
      hasCredentials: !!creds,
      usernameHint: creds?.username ? `${creds.username.slice(0, 3)}…` : null,
      apiBaseUrl: row.apiBaseUrl ?? null,
      lastHealthOk: row.lastHealthOk ?? null,
      lastHealthAt: row.lastHealthAt ? new Date(row.lastHealthAt).toISOString() : null,
      lastHealthMessage: row.lastHealthMessage ?? null,
      lastDidsSyncAt: row.lastDidsSyncAt ? new Date(row.lastDidsSyncAt).toISOString() : null,
      numberCount: counts.get(row.id) ?? 0,
    };
  });
  summaries.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return summaries;
}

/**
 * Whether an account row may be deleted. Pure decision so the rule is testable:
 * the primary row is never deletable (it IS the legacy singleton every
 * provisioning/billing path reads), and an account still owning synced numbers
 * is not deletable — those rows would silently fall back to the wrong
 * credentials on the next send/poll.
 */
export function canDeleteVoipMsAccount(input: { accountId: string; numberCount: number }): { ok: true } | { ok: false; reason: string } {
  if (input.accountId === VOIPMS_PRIMARY_ACCOUNT_ID) {
    return { ok: false, reason: "The primary VoIP.ms account cannot be removed — provisioning, billing texts and the trunk guardrail read it." };
  }
  if (input.numberCount > 0) {
    return {
      ok: false,
      reason: `This account still owns ${input.numberCount} synced number${input.numberCount === 1 ? "" : "s"}. Re-sync after moving them, then remove it.`,
    };
  }
  return { ok: true };
}

/** Create an additional account row (never the primary — that one is upserted lazily by the legacy path). */
export async function createVoipMsAccount(
  input: { label: string; credentialsEncrypted: string; apiBaseUrl?: string | null },
  db: DbLike = realDb as any,
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.globalVoipMsConfig.create({
    data: {
      id,
      label: input.label,
      credentialsEncrypted: input.credentialsEncrypted,
      apiBaseUrl: input.apiBaseUrl || null,
      smsEnabled: true,
      mmsEnabled: true,
    },
  });
  return { id };
}
