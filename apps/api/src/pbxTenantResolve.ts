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

  const telephony = String(input.telephonyTenantId || "").trim();
  if (telephony && !telephony.startsWith("vpbx:")) {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId: telephony } });
    if (link?.status === "LINKED") {
      const vid = (link.pbxTenantId || "").trim();
      const code = (link.pbxTenantCode || "").trim().toUpperCase();
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
