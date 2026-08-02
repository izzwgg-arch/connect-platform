import type { PrismaClient } from "@connect/db";
import type { PbxTenantHints } from "@connect/integrations";
import {
  extractPbxTenantHintsFromChannel,
  extractPbxTenantHintsFromContext,
  mergePbxTenantHints,
  normalizeInboundDidDigits,
} from "@connect/integrations";

export type ResolvedCdrTenant = {
  tenantId: string | null;
  pbxVitalTenantId: string | null;
  pbxTenantCode: string | null;
  tenantResolutionSource: string | null;
};

type DirRow = {
  vitalTenantId: string;
  tenantSlug: string;
  tenantCode: string;
};

function normSlug(s: string): string {
  return s.toLowerCase().replace(/-/g, "_");
}

/**
 * The owning PBX tenant code as stamped BY ASTERISK into the call itself —
 * dcontext `T102_cos-all`, channel `PJSIP/T102_101_1-0000abcd`.
 *
 * This is the only ownership signal in a CDR that a caller cannot influence, so
 * it is the one we treat as authoritative (see the leak note in
 * resolveCdrTenant). Returns null when the call carries no marker, or when it
 * carries CONFLICTING markers — a call whose legs disagree about who owns it
 * must never be silently assigned to one of them.
 */
export function observedPbxTenantCodeFromCall(
  dcontexts: string[] | null | undefined,
  channels: string[] | null | undefined,
): string | null {
  const found = new Set<string>();
  const scan = (value: unknown) => {
    const text = String(value || "");
    if (!text) return;
    const re = /(?:^|[^A-Za-z0-9])(T\d+)_/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(m[1]!.toUpperCase());
  };
  for (const d of dcontexts ?? []) scan(d);
  for (const c of channels ?? []) scan(c);
  if (found.size !== 1) return null;
  return [...found][0]!;
}

/**
 * Called when a caller-supplied tenant is rejected because the call's own PBX
 * marker says otherwise. Wired to a logger by the API so every rejection is
 * visible — this is the alarm for the leak that made this check necessary.
 */
export type TenantClaimRejection = {
  claimedTenantId: string;
  claimedCode: string;
  observedCode: string;
  dcontexts: string[];
  channels: string[];
};
let onTenantClaimRejected: ((r: TenantClaimRejection) => void) | null = null;
export function setTenantClaimRejectionHandler(fn: ((r: TenantClaimRejection) => void) | null): void {
  onTenantClaimRejected = fn;
}

/** PJSIP endpoint → match directory (same idea as server resolveTenantFromChannels). */
function resolveVitalFromChannels(channels: string[], byVital: Map<string, DirRow>, normSlugMap: Map<string, DirRow>): string | null {
  const normMap = new Map<string, DirRow>();
  for (const [k, v] of normSlugMap) normMap.set(normSlug(k), v);

  for (const channel of channels) {
    const m =
      /PJSIP\/([^-]+(?:-[^-]+)*?)-[\da-f]{8}/i.exec(channel) ?? /PJSIP\/([^-]+)-/.exec(channel);
    if (!m) continue;
    const endpoint = m[1]!;
    const full = byVital.get(endpoint.toLowerCase()) ?? normMap.get(normSlug(endpoint));
    if (full) return full.vitalTenantId;
    for (const part of endpoint.split(/[_-]/)) {
      if (!part) continue;
      const hit = byVital.get(part.toLowerCase()) ?? normMap.get(normSlug(part));
      if (hit) return hit.vitalTenantId;
    }
  }
  return null;
}

function extractSlugFromDcontext(dcontext: string, bySlug: Map<string, DirRow>, normSlugMap: Map<string, DirRow>): string | null {
  const VPBX_CTX_PREFIXES = [
    "ext-local-",
    "from-pstn-",
    "from-internal-",
    "from-trunk-",
    "outbound-",
    "from-external-",
    "app-queue-",
    "app-dial-",
    "app-ringgroup-",
    "app-announcement-",
    "app-followme-",
    "app-blacklist-",
    "app-voicemail-",
    "app-dnd-",
    "macro-dial-exec-",
  ];
  const ctx = dcontext.trim();
  const lower = ctx.toLowerCase();
  for (const pfx of VPBX_CTX_PREFIXES) {
    if (lower.startsWith(pfx)) {
      const slug = ctx.slice(pfx.length).trim();
      if (!slug || /^\d+$/.test(slug)) continue;
      const hit = bySlug.get(slug.toLowerCase()) ?? normSlugMap.get(normSlug(slug));
      if (hit) return hit.vitalTenantId;
    }
  }
  const last = (ctx.split("-").pop() ?? "").trim();
  if (last.length > 2 && !/^\d+$/.test(last)) {
    const hit = bySlug.get(last.toLowerCase()) ?? normSlugMap.get(normSlug(last));
    if (hit) return hit.vitalTenantId;
  }
  return null;
}

async function loadDirectoryMaps(db: PrismaClient, pbxInstanceId: string) {
  const rows = await db.pbxTenantDirectory.findMany({ where: { pbxInstanceId } });
  const links = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId, status: "LINKED" },
  });
  const byVital = new Map<string, DirRow>();
  const byCode = new Map<string, DirRow>();
  const bySlug = new Map<string, DirRow>();
  const normSlugMap = new Map<string, DirRow>();
  for (const r of rows) {
    const row: DirRow = {
      vitalTenantId: r.vitalTenantId.trim(),
      tenantSlug: r.tenantSlug,
      tenantCode: r.tenantCode.trim().toUpperCase(),
    };
    byVital.set(row.vitalTenantId.toLowerCase(), row);
    byVital.set(row.tenantSlug.toLowerCase(), row);
    byCode.set(row.tenantCode.toUpperCase(), row);
    bySlug.set(row.tenantSlug.toLowerCase(), row);
    normSlugMap.set(normSlug(row.tenantSlug), row);
  }
  const connectByVital = new Map<string, string>();
  for (const l of links) {
    const vid = (l.pbxTenantId || "").trim();
    if (vid) connectByVital.set(vid.toLowerCase(), l.tenantId);
    const code = (l.pbxTenantCode || "").trim().toUpperCase();
    if (code) {
      const dir = byCode.get(code);
      if (dir) connectByVital.set(dir.vitalTenantId.toLowerCase(), l.tenantId);
    }
  }
  return { rows, byVital, byCode, bySlug, normSlugMap, connectByVital };
}

function packResult(
  vitalId: string | null,
  dir: DirRow | null,
  connectByVital: Map<string, string>,
  source: string,
): ResolvedCdrTenant {
  if (!vitalId || !dir) {
    return { tenantId: null, pbxVitalTenantId: null, pbxTenantCode: null, tenantResolutionSource: null };
  }
  const connectId = connectByVital.get(vitalId.toLowerCase()) ?? null;
  return {
    tenantId: connectId ?? `vpbx:${dir.tenantSlug}`,
    pbxVitalTenantId: vitalId,
    pbxTenantCode: dir.tenantCode,
    tenantResolutionSource: source,
  };
}

async function tryResolveFromSyncedInboundDid(
  db: PrismaClient,
  pbxInstanceId: string,
  maps: Awaited<ReturnType<typeof loadDirectoryMaps>>,
  phone: string | null | undefined,
  source: string,
): Promise<ResolvedCdrTenant | null> {
  const e164 = normalizeInboundDidDigits(phone);
  if (!e164) return null;
  const row = await db.pbxTenantInboundDid.findFirst({
    where: { pbxInstanceId, e164, active: true },
    select: { vitalTenantId: true, pbxTenantCode: true, connectTenantId: true },
  });
  if (!row) return null;
  const vitalId = row.vitalTenantId.trim();
  const dir = maps.byVital.get(vitalId.toLowerCase()) ?? null;
  if (dir) {
    return packResult(vitalId, dir, maps.connectByVital, source);
  }
  return {
    tenantId: row.connectTenantId,
    pbxVitalTenantId: vitalId,
    pbxTenantCode: row.pbxTenantCode?.trim().toUpperCase() ?? null,
    tenantResolutionSource: source,
  };
}

export async function resolveCdrTenant(
  db: PrismaClient,
  pbxInstanceId: string,
  input: {
    telephonyTenantId: string | null | undefined;
    pbxVitalTenantIdHint: string | null | undefined;
    pbxTenantCodeHint: string | null | undefined;
    dcontexts: string[];
    channels: string[];
    fromNumber: string | null | undefined;
    toNumber: string | null | undefined;
    ruleResolver: () => Promise<string | null>;
  },
): Promise<ResolvedCdrTenant> {
  const maps = await loadDirectoryMaps(db, pbxInstanceId);
  const { byVital, byCode, bySlug, normSlugMap, connectByVital } = maps;

  // ── THE PBX IS THE SOURCE OF TRUTH ──────────────────────────────────────────
  // Owner directive, 2026-08-02, after a confirmed CROSS-TENANT LEAK: calls were
  // written into other companies' call history. PBX-verified over 7 days: 3,517
  // matched records, 116 filed under the WRONG company (3.3%), affecting 11 real
  // customers in both directions — and recordings ride along on the record.
  //
  // ALL 116 came through the `telephony_connect_tenant_id` branch below and NONE
  // through any other path, because that branch TRUSTED a caller-supplied tenant
  // id outright. It checked only that the claimed tenant had *some* linked PBX
  // record — never that the link matched THIS call. The call's own ownership
  // markers were passed into this function and thrown away.
  //
  // Asterisk stamps the owning tenant into the call itself: dcontext `T102_...`
  // and channels `PJSIP/T102_101_1-...`. That marker comes from the PBX, cannot
  // be forged by a caller, and is therefore authoritative. Read it FIRST.
  const observedCode = observedPbxTenantCodeFromCall(input.dcontexts, input.channels);
  if (observedCode) {
    const dir = byCode.get(observedCode);
    if (dir) return packResult(dir.vitalTenantId, dir, connectByVital, "pbx_observed_tenant_code");
  }

  const telephony = String(input.telephonyTenantId || "").trim();
  if (telephony && !telephony.startsWith("vpbx:")) {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId: telephony } });
    if (link?.status === "LINKED") {
      const vid = (link.pbxTenantId || "").trim();
      const code = (link.pbxTenantCode || "").trim().toUpperCase();
      // FAIL CLOSED: if the call itself says one tenant and the caller claims a
      // different one, the caller is wrong. Never guess and never prefer the
      // claim — drop it and fall through to the evidence-based paths below
      // (DID/channel/dcontext). If none of those resolve, the record ends up
      // unattributed, which is recoverable. A record in the wrong company's
      // history is not.
      if (observedCode && code && observedCode !== code) {
        onTenantClaimRejected?.({
          claimedTenantId: telephony,
          claimedCode: code,
          observedCode,
          dcontexts: input.dcontexts,
          channels: input.channels,
        });
      } else {
        const dir =
          (vid && byVital.get(vid.toLowerCase())) ||
          (code ? byCode.get(code) : undefined) ||
          null;
        return {
          tenantId: telephony,
          pbxVitalTenantId: (dir?.vitalTenantId ?? vid) || null,
          pbxTenantCode: (dir?.tenantCode ?? code) || null,
          tenantResolutionSource: "telephony_connect_tenant_id",
        };
      }
    }
  }

  if (telephony && telephony.startsWith("vpbx:")) {
    const slug = telephony.slice(5).trim();
    const dir = bySlug.get(slug.toLowerCase()) ?? normSlugMap.get(normSlug(slug));
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "telephony_vpbx_slug_directory");
    }
  }

  const toDid = await tryResolveFromSyncedInboundDid(db, pbxInstanceId, maps, input.toNumber, "ombu_inbound_did_to");
  if (toDid) return toDid;
  const fromDid = await tryResolveFromSyncedInboundDid(db, pbxInstanceId, maps, input.fromNumber, "ombu_inbound_did_from");
  if (fromDid) return fromDid;

  const hintObj = mergePbxTenantHints(
    input.pbxVitalTenantIdHint || input.pbxTenantCodeHint
      ? {
          vitalTenantId: input.pbxVitalTenantIdHint || undefined,
          tenantCode: input.pbxTenantCodeHint || undefined,
        }
      : {},
    ...input.dcontexts.map((d) => extractPbxTenantHintsFromContext(d)),
    ...input.channels.map((c) => extractPbxTenantHintsFromChannel(c)),
  );

  if (hintObj.vitalTenantId) {
    const dir = byVital.get(hintObj.vitalTenantId.toLowerCase());
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "pbx_hint_vital_tenant_id");
    }
  }
  if (hintObj.tenantCode) {
    const dir = byCode.get(hintObj.tenantCode.toUpperCase());
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "pbx_hint_tenant_code");
    }
  }
  if (hintObj.dialplanT) {
    const dir = byVital.get(hintObj.dialplanT.toLowerCase());
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "pbx_hint_dialplan_t_index");
    }
  }
  if (hintObj.slug) {
    const dir = bySlug.get(hintObj.slug.toLowerCase()) ?? normSlugMap.get(normSlug(hintObj.slug));
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "pbx_hint_context_slug");
    }
  }

  for (const dc of input.dcontexts) {
    const vid = extractSlugFromDcontext(dc, bySlug, normSlugMap);
    if (vid) {
      const dir = byVital.get(vid.toLowerCase()) ?? null;
      if (dir) {
        return packResult(dir.vitalTenantId, dir, connectByVital, "dcontext_directory_slug");
      }
    }
  }

  const fromCh = resolveVitalFromChannels(input.channels, byVital, normSlugMap);
  if (fromCh) {
    const dir = byVital.get(fromCh.toLowerCase());
    if (dir) {
      return packResult(dir.vitalTenantId, dir, connectByVital, "channel_directory_endpoint");
    }
  }

  const fromRule = await input.ruleResolver();
  if (fromRule) {
    return {
      tenantId: fromRule,
      pbxVitalTenantId: null,
      pbxTenantCode: null,
      tenantResolutionSource: "cdr_tenant_rule",
    };
  }

  return { tenantId: null, pbxVitalTenantId: null, pbxTenantCode: null, tenantResolutionSource: null };
}
