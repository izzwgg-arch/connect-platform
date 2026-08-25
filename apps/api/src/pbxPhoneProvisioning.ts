/**
 * What the PBX believes each desk phone's MAC address is — so it can be
 * compared against what the phones on the network actually are.
 *
 * ⛔ WHY THIS EXISTS. The MAC on the PBX record is the single point of failure
 * in phone provisioning and nothing verifies it. VitalPBX pre-generates a
 * config file named after the MAC it was told; the handset downloads the file
 * named after the MAC it actually has. When those differ:
 *   - the panel looks completely correct,
 *   - the nginx log shows a clean 200 for a *different* filename,
 *   - and the phone serves a config from weeks ago.
 * There is no error anywhere in that chain. That was seven weeks of Create A
 * Box ext 102, and it was only found by hand-reading a log.
 *
 * ⛔ READ-ONLY, ALWAYS. The PBX is under a hard read-only guardrail. Everything
 * here is a SELECT. Nothing in this file may ever write to the PBX.
 *
 * Schema, confirmed live on 2026-08-16 rather than assumed:
 *   provisioning.devices ( id, model_id, template_id, mac, tenant,
 *                          description, keys, phonebook, expansion_module_keys )
 *   provisioning.phone_models ( id, ... )      — the handset model
 *   provisioning.brands ( id, ... )            — the manufacturer
 * ⛔ `ombu_devices` in the ombutel schema has NO mac column at all — the only
 * `mac` column anywhere in ombutel is `ombu_static_leases`, which is DHCP and
 * nothing to do with provisioning. Do not go looking for it there.
 */
import { connectOmbutelMysql } from "./pbxQueueDirectory";

/** One phone as the PBX has it recorded. */
export type PbxProvisionedPhone = {
  /** Normalised lowercase hex, no separators. */
  mac: string;
  /** Raw value as stored, for showing a human what is actually in the record. */
  macRaw: string;
  /** VitalPBX tenant number this device belongs to. */
  pbxTenant: number;
  /** The label on the record — often the extension, and often stale. */
  description: string | null;
  model: string | null;
  brand: string | null;
  /** The extension number this device's first SIP account belongs to, when the
   * accounts join could resolve one. Null for un-accounted or unreadable rows. */
  extension?: string | null;
  /** The extension's NAME on the PBX — the person ("Mrs Weinstock"), which is
   * what a customer screen should say. Null when unresolvable. Optional so the
   * comparison fixtures and any structural caller stay valid. */
  extensionName?: string | null;
};

export type ProvisionedPhonesResult =
  | { available: true; phones: PbxProvisionedPhone[] }
  /**
   * ⛔ A distinct, actionable code rather than a generic failure — exactly like
   * `queue_log_access_denied`. Without this the screen would render an empty
   * list, which reads as "this PBX has no phones" about a system running fifty
   * of them. Confidently wrong is worse than obviously broken.
   */
  | { available: false; reason: "provisioning_access_denied"; detail: string; grantSql: string }
  | { available: false; reason: "pbx_unavailable"; detail: string; grantSql?: undefined };

/**
 * The grant this needs. Deliberately the narrowest possible: SELECT on one
 * table, in one database, for the existing read-only user.
 */
export const PROVISIONING_GRANT_SQL =
  "GRANT SELECT ON `provisioning`.`devices` TO 'connect_read'@'%'; " +
  "GRANT SELECT ON `provisioning`.`phone_models` TO 'connect_read'@'%'; " +
  "GRANT SELECT ON `provisioning`.`brands` TO 'connect_read'@'%'; " +
  "GRANT SELECT ON `provisioning`.`accounts` TO 'connect_read'@'%'; " +
  "FLUSH PRIVILEGES;";

function normalizeMac(input: unknown): string | null {
  const cleaned = String(input ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (cleaned.length !== 12) return null;
  if (cleaned === "000000000000" || cleaned === "ffffffffffff") return null;
  return cleaned;
}

/** Does this error mean "no grant" rather than "PBX is down"? */
function isAccessDenied(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("access denied") ||
    m.includes("command denied") ||
    // MySQL says the database "doesn't exist" when the user cannot see it,
    // which reads as a missing database and is actually a missing grant.
    m.includes("unknown database")
  );
}

/**
 * Every phone the PBX has a provisioning record for.
 *
 * Never throws — a phone-inventory screen must degrade to an honest
 * "we could not read this" rather than a 500 or, worse, an empty list.
 */
export async function listPbxProvisionedPhones(
  ombuMysqlUrlEncrypted: string | null | undefined,
  options: { pbxTenant?: number } = {},
): Promise<ProvisionedPhonesResult> {
  const connected = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!connected.ok) {
    return { available: false, reason: "pbx_unavailable", detail: connected.skipReason };
  }

  const conn = connected.conn;
  try {
    // The brand/model join is LEFT so a device whose model row is missing still
    // appears — knowing a phone exists matters more than knowing what it is.
    const where = options.pbxTenant ? "WHERE d.tenant = ?" : "";
    const params = options.pbxTenant ? [options.pbxTenant] : [];

    // ⛔ `phone_models` has NO `name` column — the model string lives in
    // `pm.model`. The original select said `pm.name`, which threw
    // "Unknown column" on EVERY call, was caught below, and reported the whole
    // PBX as unreachable — a latent bug for the feature's entire life, found
    // 2026-08-25 the first time a real customer run needed this data.
    const [rows] = (await conn.query(
      `SELECT d.id         AS id,
              d.mac        AS mac,
              d.tenant     AS tenant,
              d.description AS description,
              pm.model     AS model,
              b.name       AS brand
         FROM provisioning.devices d
         LEFT JOIN provisioning.phone_models pm ON pm.id = d.model_id
         LEFT JOIN provisioning.brands b        ON b.id = pm.brand_id
         ${where}
         ORDER BY d.tenant, d.description`,
      params,
    )) as any;

    // The person behind the phone: provisioning.accounts -> ombu_devices ->
    // ombu_extensions. Separate query (a device can carry several accounts —
    // W60P bases do) and best-effort: a failure here loses the NAMES, never the
    // phone list itself.
    const extByDevice = new Map<number, { extension: string; name: string }>();
    try {
      const ids = (rows as any[]).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length) {
        const [accts] = (await conn.query(
          `SELECT a.device_id AS phone_id, e.extension AS extension, e.name AS ext_name
             FROM provisioning.accounts a
             LEFT JOIN ombutel.ombu_devices od ON od.device_id = a.phone_device_id
             LEFT JOIN ombutel.ombu_extensions e ON e.extension_id = od.extension_id
            WHERE a.device_id IN (${ids.map(() => "?").join(",")})
            ORDER BY a.id`,
          ids,
        )) as any;
        for (const a of accts as any[]) {
          const pid = Number(a.phone_id);
          // First account wins — it is the phone's primary line.
          if (!extByDevice.has(pid) && a.extension) {
            extByDevice.set(pid, { extension: String(a.extension), name: String(a.ext_name ?? "") });
          }
        }
      }
    } catch { /* names are optional; the phone list is not */ }

    const phones: PbxProvisionedPhone[] = [];
    for (const row of rows as any[]) {
      const mac = normalizeMac(row.mac);
      // ⛔ A record with an unreadable MAC is REPORTED, not silently dropped —
      // it is one of the ways provisioning breaks, so hiding it would hide the
      // very thing this module exists to surface.
      const acct = extByDevice.get(Number(row.id)) || null;
      phones.push({
        mac: mac ?? "",
        macRaw: String(row.mac ?? ""),
        pbxTenant: Number(row.tenant) || 0,
        description: row.description ? String(row.description) : null,
        model: row.model ? String(row.model) : null,
        brand: row.brand ? String(row.brand) : null,
        extension: acct?.extension || null,
        extensionName: acct?.name || null,
      });
    }
    return { available: true, phones };
  } catch (e: any) {
    const detail = e?.message || String(e);
    if (isAccessDenied(detail)) {
      return {
        available: false,
        reason: "provisioning_access_denied",
        detail,
        grantSql: PROVISIONING_GRANT_SQL,
      };
    }
    return { available: false, reason: "pbx_unavailable", detail };
  } finally {
    try { await conn.end(); } catch { /* connection already gone */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison — the actual point of all of this.
// ─────────────────────────────────────────────────────────────────────────────

export type PhoneComparisonRow = {
  mac: string;
  macFormatted: string;
  /** Present in the PBX's provisioning records. */
  onPbx: boolean;
  /** Seen on the customer's network by the Windows app. */
  onNetwork: boolean;
  ip: string | null;
  vendor: string | null;
  model: string | null;
  description: string | null;
  /** What a person should do about this row, in plain words. */
  verdict: "ok" | "missing_from_pbx" | "not_on_network" | "unreadable_mac";
  explanation: string;
};

export type PhoneComparison = {
  rows: PhoneComparisonRow[];
  counts: { ok: number; missingFromPbx: number; notOnNetwork: number; unreadable: number };
};

/**
 * Join what the PBX believes against what is actually on the wire.
 *
 * ⛔ THE VERDICTS ARE THE PRODUCT. A list of MACs helps nobody; "this phone is
 * on the network but the phone system has never heard of it" is the sentence
 * that saves an afternoon. Each one is written so a person who has not read any
 * of this code can act on it.
 *
 * ⛔ `notOnNetwork` is NOT proof of a fault and must never be phrased as one.
 * A phone at another site, on another subnet, or simply switched off looks
 * identical from here. The scan only ever sees one network.
 */
export function comparePhones(input: {
  pbxPhones: PbxProvisionedPhone[];
  networkPhones: Array<{ mac: string; ip?: string | null; vendor?: string | null }>;
  /** True when a scan has actually been run; changes what an absence means. */
  networkScanned: boolean;
}): PhoneComparison {
  const byMac = new Map<string, PhoneComparisonRow>();
  const format = (mac: string) => (mac.match(/.{2}/g) || []).join(":");

  for (const phone of input.pbxPhones) {
    if (!phone.mac) {
      // A provisioning record whose MAC cannot be read is broken by definition:
      // VitalPBX will have written a config file under a nonsense name.
      byMac.set(`raw:${phone.macRaw}:${phone.pbxTenant}:${phone.description ?? ""}`, {
        mac: "",
        macFormatted: phone.macRaw || "(blank)",
        onPbx: true,
        onNetwork: false,
        ip: null,
        vendor: null,
        model: phone.model,
        description: phone.description,
        verdict: "unreadable_mac",
        explanation:
          "The phone system has a hardware ID recorded for this phone that is not a valid address, " +
          "so any settings written for it are saved under a name no phone will ever ask for.",
      });
      continue;
    }
    byMac.set(phone.mac, {
      mac: phone.mac,
      macFormatted: format(phone.mac),
      onPbx: true,
      onNetwork: false,
      ip: null,
      vendor: phone.brand,
      model: phone.model,
      description: phone.description,
      verdict: "not_on_network",
      explanation: input.networkScanned
        ? "The phone system knows about this phone, but it was not seen on the network that was " +
          "scanned. It may be switched off, at another site, or on a different network."
        : "The phone system knows about this phone. Nobody has scanned a network yet, so there is " +
          "nothing to compare it against.",
    });
  }

  for (const found of input.networkPhones) {
    const mac = normalizeMac(found.mac);
    if (!mac) continue;
    const existing = byMac.get(mac);
    if (existing) {
      existing.onNetwork = true;
      existing.ip = found.ip ?? null;
      existing.vendor = existing.vendor || found.vendor || null;
      existing.verdict = "ok";
      existing.explanation = "This phone is on the network and the phone system's record matches it.";
      continue;
    }
    byMac.set(mac, {
      mac,
      macFormatted: format(mac),
      onPbx: false,
      onNetwork: true,
      ip: found.ip ?? null,
      vendor: found.vendor ?? null,
      model: null,
      description: null,
      verdict: "missing_from_pbx",
      explanation:
        "This phone is on the network but the phone system has no record of it. If it is supposed " +
        "to be working, the hardware ID on its record is probably wrong — which is why it never " +
        "picks up its settings.",
    });
  }

  const rows = [...byMac.values()];
  return {
    rows,
    counts: {
      ok: rows.filter((r) => r.verdict === "ok").length,
      missingFromPbx: rows.filter((r) => r.verdict === "missing_from_pbx").length,
      notOnNetwork: rows.filter((r) => r.verdict === "not_on_network").length,
      unreadable: rows.filter((r) => r.verdict === "unreadable_mac").length,
    },
  };
}
