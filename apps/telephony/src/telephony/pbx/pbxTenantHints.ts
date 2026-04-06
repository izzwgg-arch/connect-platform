/**
 * Mirror of packages/integrations/src/vitalpbx/pbxTenantHints.ts — keep in sync.
 */

export type PbxTenantHints = {
  vitalTenantId?: string;
  tenantCode?: string;
  dialplanT?: string;
  slug?: string;
};

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

function mergeSingle(a: PbxTenantHints, b: PbxTenantHints): PbxTenantHints {
  return {
    vitalTenantId: b.vitalTenantId ?? a.vitalTenantId,
    tenantCode: b.tenantCode ?? a.tenantCode,
    dialplanT: b.dialplanT ?? a.dialplanT,
    slug: b.slug ?? a.slug,
  };
}

export function extractSlugFromPrefixedContext(ctx: string): string | null {
  const trimmed = ctx.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const pfx of VPBX_CTX_PREFIXES) {
    if (lower.startsWith(pfx)) {
      const slug = trimmed.slice(pfx.length).trim();
      if (slug && !/^\d+$/.test(slug)) return slug;
    }
  }
  return null;
}

export function extractDialplanTFromContext(ctx: string): { dialplanT: string; tenantCode: string } | null {
  const m = /^t(\d+)_cos-/i.exec(ctx.trim());
  if (!m?.[1]) return null;
  const n = m[1];
  return { dialplanT: n, tenantCode: `T${n}` };
}

export function extractPbxTenantHintsFromContext(contextOrDcontext: string): PbxTenantHints {
  const ctx = String(contextOrDcontext || "").trim();
  if (!ctx) return {};
  const out: PbxTenantHints = {};
  const cos = extractDialplanTFromContext(ctx);
  if (cos) {
    out.dialplanT = cos.dialplanT;
    out.tenantCode = cos.tenantCode;
    out.vitalTenantId = cos.dialplanT;
  }
  const slug = extractSlugFromPrefixedContext(ctx);
  if (slug) out.slug = slug;
  return out;
}

export function extractPbxTenantHintsFromChannel(channel: string): PbxTenantHints {
  const ch = String(channel || "").trim();
  if (!ch) return {};
  const tCode = /^PJSIP\/(T\d+)_/i.exec(ch);
  if (tCode?.[1]) {
    const code = tCode[1].toUpperCase();
    const id = code.replace(/^T/i, "");
    return { tenantCode: code, vitalTenantId: id, dialplanT: id };
  }
  const numSlug = /^PJSIP\/(\d+)_([^/-]+)-/i.exec(ch);
  if (numSlug?.[1]) {
    // numSlug[2] is the tenant slug (e.g. "gesheft" from PJSIP/344022_gesheft-000062fc).
    // The numeric part (344022) is the SIP peer registration ID, not the VitalPBX tenant ID.
    const s = numSlug[2] ? String(numSlug[2]).trim() : undefined;
    return { vitalTenantId: numSlug[1], ...(s ? { slug: s } : {}) };
  }
  return {};
}

export function mergePbxTenantHints(...parts: Array<PbxTenantHints | null | undefined>): PbxTenantHints {
  let acc: PbxTenantHints = {};
  for (const p of parts) {
    if (!p || !Object.keys(p).length) continue;
    acc = mergeSingle(acc, p);
  }
  return acc;
}
