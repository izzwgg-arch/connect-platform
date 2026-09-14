import { db } from "@connect/db";
import { connectOmbutelMysql } from "../pbxQueueDirectory";
import { resolvePbxTenantNumber } from "../pbxPhoneProvisioning";
import { DeviceError } from "./yealinkRps";
import type { SipConfig } from "./yealinkConfig";

/** Read-only: never invoke credential issuance, tenant save, or endpoint creation. */
export async function readManagedPhoneSip(tenantId: string, extensionId: string, mac: string): Promise<SipConfig> {
  const extension = await db.extension.findFirst({ where: { id: extensionId, tenantId, status: "ACTIVE" } });
  if (!extension) throw new DeviceError("extension_not_found", 404);
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId }, include: { pbxInstance: true, tenant: true } });
  const number = resolvePbxTenantNumber(link);
  if (!link || !number) throw new DeviceError("tenant_pbx_link_missing", 503);
  const server = link.pbxDomain || link.tenant.sipDomain;
  if (!server || !/^[a-z\d.-]+$/i.test(server)) throw new DeviceError("tenant_sip_domain_missing", 503);
  // Must be qualified against the actual desk SIP listener before enabling.
  const port = Number(process.env.MANAGED_PHONE_SIP_PORT);
  const transport = process.env.MANAGED_PHONE_SIP_TRANSPORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !["UDP", "TCP", "TLS"].includes(transport || ""))
    throw new DeviceError("desk_sip_listener_configuration_required", 503);
  const conn = await connectOmbutelMysql(link.pbxInstance.ombuMysqlUrlEncrypted);
  if (!conn.ok) throw new DeviceError("pbx_read_unavailable", 503);
  try {
    const [owners] = await conn.conn.query(
      "SELECT tenant FROM provisioning.devices WHERE REPLACE(REPLACE(LOWER(mac), ':', ''), '-', '') = ?", [mac]) as any;
    if (owners.some((o: any) => Number(o.tenant) !== number)) throw new DeviceError("device_ownership_conflict");
    const [rows] = await conn.conn.query(
      "SELECT d.user, d.secret FROM ombutel.ombu_devices d JOIN ombutel.ombu_extensions e ON e.extension_id = d.extension_id WHERE e.tenant_id = ? AND d.user = ?",
      [number, extension.extNumber]) as any;
    if (rows.length !== 1 || !rows[0].secret) throw new DeviceError("desk_endpoint_credentials_unavailable", 503);
    const endpoint = `T${number}_${extension.extNumber}`;
    const peers = await db.extension.findMany({ where: { tenantId, status: "ACTIVE", id: { not: extensionId } }, orderBy: { extNumber: "asc" } });
    return { endpoint, username: endpoint, authName: endpoint, password: String(rows[0].secret), server,
      port, transport: transport as SipConfig["transport"], displayName: extension.displayName, label: extension.extNumber,
      blf: peers.map(p => ({ extension: p.extNumber, label: p.displayName })) };
  } catch (error) {
    if (error instanceof DeviceError) throw error;
    throw new DeviceError("pbx_read_unavailable", 503);
  } finally { await conn.conn.end(); }
}

export function registrationEvidence(device: { tenantId: string; extensionId: string; endpoint: string; macAddress: string; configVersion: number; servedVersion: number | null; lastProvisionedAt: Date | null }, row: any, now = Date.now()) {
  if (!row || row.tenantId !== device.tenantId || row.extensionId !== device.extensionId || row.endpoint !== device.endpoint || row.isWebrtcDevice)
    return "unknown";
  if (row.status !== "REGISTERED") return "offline";
  // A stale cached REGISTERED event is not proof of present liveness.
  if (now - new Date(row.lastEventAt).getTime() > 180_000) return "unknown";
  if (device.servedVersion !== device.configVersion || !device.lastProvisionedAt || new Date(row.lastEventAt) < device.lastProvisionedAt) return "waiting_for_registration";
  // The MAC may appear in the SIP User-Agent or the contact URI. Yealink's default
  // SIP User-Agent is model + firmware only, so "online" will usually need the
  // admin-attested replacement path; that is honest, not a bug.
  const macs = `${row.userAgent || ""} ${row.contactUri || ""}`.match(/(?:[a-f\d]{2}:){5}[a-f\d]{2}|\b[a-f\d]{12}\b/gi) || [];
  // Model or shared NAT IP alone cannot identify a handset. A PBX observation
  // without a physical MAC stays unverified; never retire a predecessor on it.
  return macs.some(m => m.replace(/:/g, "").toLowerCase() === device.macAddress) ? "online" : "endpoint_registered_device_unverified";
}
