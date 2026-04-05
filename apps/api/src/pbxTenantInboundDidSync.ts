import type { PrismaClient } from "@connect/db";
import { normalizeInboundDidDigits } from "@connect/integrations";
import { syncInboundDidsFromOmbutelMysql } from "./pbxOmbutelInboundDidSync";

export { normalizeInboundDidDigits };

export type InboundDidSyncResult = {
  tenantsProcessed: number;
  numbersUpserted: number;
  errors: string[];
  source: "ombutel_mysql" | "skipped";
  rowsRead?: number;
  skipReason?: string;
};

/**
 * Sync inbound DID → Vital tenant from VitalPBX Ombutel MySQL (`ombu_inbound_routes` + `ombu_tenants`).
 * Does not use the REST `.../inbound_numbers` endpoint (unreliable on many VitalPBX builds).
 *
 * Configure `PbxInstance.ombuMysqlUrlEncrypted` with `encryptJson({ mysqlUrl: "mysql://readonly:pass@host:3306/ombutel" })`.
 */
export async function syncPbxTenantInboundDids(db: PrismaClient, pbxInstanceId: string): Promise<InboundDidSyncResult> {
  const instance = await db.pbxInstance.findUnique({
    where: { id: pbxInstanceId },
    select: { ombuMysqlUrlEncrypted: true },
  });
  const out = await syncInboundDidsFromOmbutelMysql(db, pbxInstanceId, instance?.ombuMysqlUrlEncrypted);
  if (out.source === "skipped") {
    return {
      source: "skipped",
      skipReason: out.skipReason,
      tenantsProcessed: 0,
      numbersUpserted: 0,
      errors: out.errors,
    };
  }
  return {
    source: "ombutel_mysql",
    rowsRead: out.rowsRead,
    tenantsProcessed: out.tenantsProcessed,
    numbersUpserted: out.numbersUpserted,
    errors: out.errors,
  };
}
