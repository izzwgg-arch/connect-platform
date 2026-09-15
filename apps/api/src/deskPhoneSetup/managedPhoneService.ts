import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";
import { DeviceError, configuredRps, strictMac, type RpsAdapter } from "./yealinkRps";
import { yealinkConfig, managedModel, type SipConfig, type DeviceConfigOptions } from "./yealinkConfig";
import { readManagedPhoneSip, registrationEvidence } from "./managedPhonePbx";

type Actor = { tenantId: string; sub: string };
type Secrets = { provisioningPassword: string; adminPassword: string };
export interface DeskPhoneProvider {
  manufacturer: string;
  validateModel(model: string): unknown;
  configuration(model: string, sip: SipConfig, secrets: Secrets, url: string, mac: string, options: DeviceConfigOptions): string;
  rps: RpsAdapter;
}
export class YealinkProvider implements DeskPhoneProvider {
  manufacturer = "yealink";
  constructor(public rps: RpsAdapter = configuredRps()) {}
  validateModel = managedModel;
  configuration = yealinkConfig;
}
export function provisioningBase(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try { url = new URL(env.MANAGED_PHONE_PROVISIONING_BASE_URL || ""); } catch { throw new DeviceError("provisioning_https_url_required", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/phone-provisioning/"))
    throw new DeviceError("provisioning_https_url_required", 503);
  return url.href;
}
export function validPhoneAuthorization(header: string | undefined, mac: string, secret: string) {
  if (!header?.startsWith("Basic ") || header.length > 256) return false;
  const expected = Buffer.from(`${mac}:${secret}`);
  const actual = Buffer.from(header.slice(6), "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export class ManagedPhoneService {
  constructor(private provider: DeskPhoneProvider = new YealinkProvider(), private database: any = db,
    private loadSip: typeof readManagedPhoneSip = readManagedPhoneSip, private base = provisioningBase,
    private serverId = () => process.env.YEALINK_RPS_SERVER_ID || "") {}
  private url(mac: string) { return `${this.base()}${mac}/`; }
  private async event(tx: any, actor: Actor, device: any, action: string, requestId: string, metadata: object = {}) {
    await tx.auditLog.create({ data: { tenantId: actor.tenantId, actorUserId: actor.sub || null,
      action: `MANAGED_PHONE_${action}`, entityType: "ManagedDeskPhone", entityId: device.id,
      metadata: { mac: device.macAddress, requestId, ...metadata } } });
  }
  private async lock<T>(mac: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return this.database.$transaction(async (tx: any) => {
      // Cross-process serialization, including concurrent cross-tenant claims.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`managed-phone:${mac}`}, 0))::text`;
      return fn(tx);
    }, { timeout: 60_000, maxWait: 5_000 });
  }
  private async own(tx: any, actor: Actor, id: string) {
    const row = await tx.managedDeskPhone.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!row) throw new DeviceError("device_not_found", 404);
    return row;
  }
  async provision(actor: Actor, input: { mac: string; serialNumber?: string; model: string; extensionId: string; nickname?: string; displayName?: string; options?: DeviceConfigOptions; replacesId?: string }, requestId: string) {
    const mac = strictMac(input.mac); this.provider.validateModel(input.model);
    // ⛔ Yealink RPS refuses a MAC-only claim (403). The serial is proof of
    // possession and is mandatory for the zero-touch (RPS) assignment.
    let serialNumber = String(input.serialNumber || "").trim();
    if (!serialNumber) {
      // Izzy 2026-09-15: "the system should already know the serial — I've been through
      // this step and entered it before." A serial on a setup row exists ONLY because it
      // passed the one label gate (typed, scanned, photographed or texted), so reusing it
      // adds no new trust. Same tenant, this exact MAC (both sides are normalised bare
      // hex), newest first.
      const onFile = await this.database.deskPhoneSetupPhone?.findFirst?.({
        where: { tenantId: actor.tenantId, macAddress: mac, serialNumber: { not: null } },
        orderBy: { updatedAt: "desc" }, select: { serialNumber: true },
      });
      if (onFile?.serialNumber) serialNumber = String(onFile.serialNumber).trim();
    }
    if (!serialNumber) throw new DeviceError("serial_number_required", 400);
    // Persist identity + unique secrets before contacting RPS. A timed-out remote
    // write can then be reconciled with exactly the same URL and credentials.
    const device = await this.lock(mac, async tx => {
      const prior = await tx.managedDeskPhone.findUnique({ where: { macAddress: mac } });
      if (prior) {
        if (prior.tenantId !== actor.tenantId) throw new DeviceError("device_ownership_conflict");
        if (prior.extensionId !== input.extensionId || prior.model !== input.model || prior.retiredAt) throw new DeviceError("device_exists_use_management");
        return prior;
      }
      if (input.replacesId) {
        const old = await this.own(tx, actor, input.replacesId);
        if (old.retiredAt || old.extensionId !== input.extensionId || old.macAddress === mac) throw new DeviceError("invalid_replacement");
      }
      const sip = await this.loadSip(actor.tenantId, input.extensionId, mac);
      const secrets: Secrets = { provisioningPassword: randomBytes(24).toString("base64url"), adminPassword: randomBytes(24).toString("base64url") };
      this.provider.configuration(input.model, { ...sip, displayName: input.displayName || sip.displayName }, secrets, this.url(mac), mac, input.options || {});
      const row = await tx.managedDeskPhone.create({ data: {
        macAddress: mac, tenantId: actor.tenantId, extensionId: input.extensionId,
        manufacturer: this.provider.manufacturer, model: input.model, endpoint: sip.endpoint,
        serialNumber, nickname: input.nickname || null, displayName: input.displayName || null, options: input.options || {},
        secretsEncrypted: encryptJson(secrets), replacesId: input.replacesId || null,
        createdBy: actor.sub, updatedBy: actor.sub,
      } });
      await this.event(tx, actor, row, "CREATED", requestId, { extensionId: row.extensionId, replacesId: row.replacesId });
      return row;
    });
    await this.reconcile(actor, device.id, requestId);
    return this.detail(actor, device.id);
  }
  async reconcile(actor: Actor, id: string, requestId: string) {
    const first = await this.own(this.database, actor, id);
    return this.lock(first.macAddress, async tx => {
      const row = await this.own(tx, actor, id);
      if (row.retiredAt) throw new DeviceError("device_retired");
      await this.event(tx, actor, row, "RPS_ASSIGNMENT_REQUESTED", requestId);
      let state: string; let remoteId: string | undefined; let error: string | null = null;
      try {
        const secret = decryptJson<Secrets>(row.secretsEncrypted);
        const out = await this.provider.rps.assign({ mac: row.macAddress, serialNumber: row.serialNumber || "", serverId: this.serverId(), uniqueServerUrl: this.url(row.macAddress), authName: row.macAddress, password: secret.provisioningPassword });
        state = out.state; remoteId = out.id;
      } catch (e) { error = e instanceof DeviceError ? e.code : "rps_service_unavailable"; state = error.includes("conflict") ? "conflict" : "failed"; }
      await tx.managedDeskPhone.update({ where: { id }, data: { rpsState: state, rpsDeviceId: remoteId, rpsServerId: state === "assigned" ? this.serverId() : row.rpsServerId, lastError: error } });
      await this.event(tx, actor, row, state === "assigned" ? "RPS_ASSIGNMENT_SUCCESS" : "RPS_ASSIGNMENT_PENDING_OR_FAILED", requestId, { state, error });
    });
  }
  async detail(actor: Actor, id: string) {
    const row = await this.own(this.database, actor, id);
    const registration = await this.database.pbxEndpointRegistration.findUnique({ where: { endpoint: row.endpoint } });
    const registrationState = registrationEvidence(row, registration);
    // Explicit projection: no encrypted envelope, URL password or SIP config.
    return { id: row.id, mac: row.macAddress, manufacturer: row.manufacturer, model: row.model,
      tenantId: row.tenantId, extensionId: row.extensionId, nickname: row.nickname, displayName: row.displayName,
      serialNumber: row.serialNumber, configVersion: row.configVersion, rpsState: row.rpsState,
      lastError: row.lastError, lastSeenAt: row.lastSeenAt, lastProvisionedAt: row.lastProvisionedAt,
      servedVersion: row.servedVersion, registrationState, firmware: row.firmware, ipAddress: row.sourceIp,
      retiredAt: row.retiredAt, replacesId: row.replacesId, createdAt: row.createdAt, updatedAt: row.updatedAt,
      updatedBy: row.updatedBy, options: row.options, capabilities: managedModel(row.model).capabilities };
  }
  async list(actor: Actor) {
    const rows = await this.database.managedDeskPhone.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: "desc" }, take: 200 });
    return Promise.all(rows.map((r: any) => this.detail(actor, r.id)));
  }
  async update(actor: Actor, id: string, input: { extensionId?: string; nickname?: string; displayName?: string; options?: DeviceConfigOptions }, requestId: string) {
    const first = await this.own(this.database, actor, id);
    await this.lock(first.macAddress, async tx => {
      const row = await this.own(tx, actor, id);
      if (row.retiredAt) throw new DeviceError("device_retired");
      const extensionId = input.extensionId || row.extensionId;
      const sip = await this.loadSip(actor.tenantId, extensionId, row.macAddress);
      this.provider.configuration(row.model, { ...sip, displayName: input.displayName ?? row.displayName ?? sip.displayName }, decryptJson(row.secretsEncrypted), this.url(row.macAddress), row.macAddress, input.options || row.options);
      await tx.managedDeskPhone.update({ where: { id }, data: { ...input, endpoint: sip.endpoint, configVersion: { increment: 1 }, updatedBy: actor.sub, lastError: null } });
      await this.event(tx, actor, row, "CONFIGURATION_UPDATED", requestId, { previousExtensionId: row.extensionId, extensionId,
        previousSettings: { extensionId: row.extensionId, nickname: row.nickname, displayName: row.displayName, options: row.options } });
    });
    return this.detail(actor, id);
  }
  async release(actor: Actor, id: string, requestId: string) {
    const first = await this.own(this.database, actor, id);
    await this.lock(first.macAddress, async tx => {
      const row = await this.own(tx, actor, id);
      // Explicit action only. Disabled mode cannot report a successful release.
      await this.provider.rps.release(row.macAddress, row.rpsServerId || this.serverId(), this.url(row.macAddress));
      await tx.managedDeskPhone.update({ where: { id }, data: { rpsState: "released", rpsDeviceId: null, updatedBy: actor.sub } });
      await this.event(tx, actor, row, "RPS_RELEASED", requestId);
    });
    return this.detail(actor, id);
  }
  async retire(actor: Actor, id: string, requestId: string) {
    const first = await this.own(this.database, actor, id);
    await this.lock(first.macAddress, async tx => {
      const row = await this.own(tx, actor, id);
      if (!["released", "pending_credentials"].includes(row.rpsState)) throw new DeviceError("release_rps_before_removing_phone");
      await tx.managedDeskPhone.update({ where: { id }, data: { retiredAt: new Date(), replacesId: null, updatedBy: actor.sub } });
      await this.event(tx, actor, row, "RETIRED", requestId);
    });
  }
  async configuration(macInput: string, filename: string, authorization: string | undefined, requestId: string, sourceIp: string, userAgent: string) {
    const mac = strictMac(macInput);
    return this.lock(mac, async tx => {
      const row = await tx.managedDeskPhone.findUnique({ where: { macAddress: mac } });
      if (!row || row.retiredAt || !validPhoneAuthorization(authorization, mac, decryptJson<Secrets>(row.secretsEncrypted).provisioningPassword))
        throw new DeviceError("phone_authentication_required", 401);
      const actor = { tenantId: row.tenantId, sub: "" };
      if (filename === "y000000000000.boot" || filename.toLowerCase() === `${mac}.boot`)
        return `#!version:1.0.0.1\ninclude:config <${mac}.cfg>\noverwrite_mode = 1\n`;
      if (/^y\d{12}\.cfg$/i.test(filename)) return "#!version:1.0.0.1\n";
      if (filename.toLowerCase() !== `${mac}.cfg`) throw new DeviceError("configuration_not_found", 404);
      const sip = await this.loadSip(row.tenantId, row.extensionId, mac);
      if (sip.endpoint !== row.endpoint) throw new DeviceError("endpoint_assignment_changed", 409);
      const config = this.provider.configuration(row.model, { ...sip, displayName: row.displayName || sip.displayName }, decryptJson(row.secretsEncrypted), this.url(mac), mac, row.options);
      const now = new Date();
      await tx.managedDeskPhone.update({ where: { id: row.id }, data: { lastSeenAt: now, sourceIp, userAgent: userAgent.replace(/[\x00-\x1f]/g, "").slice(0, 256) } });
      await this.event(tx, actor, row, row.lastSeenAt ? "CONFIGURATION_REQUESTED" : "PHONE_FIRST_CONTACT", requestId, { configVersion: row.configVersion });
      // Delivery is recorded by the route's successful response hook, not merely
      // by configuration generation. Version guards reject racing updates.
      return { config, id: row.id, tenantId: row.tenantId, version: row.configVersion, hash: createHash("sha256").update(config).digest("hex") };
    });
  }
  /**
   * Retire the predecessor only once the replacement is proven.
   *
   * Default proof: the PBX shows the endpoint registered AFTER the new config was
   * delivered AND the phone's own MAC in the SIP evidence ("online").
   *
   * ⛔ Yealink's stock SIP User-Agent carries no MAC, so that proof is often
   * unavailable. `attestedWorking` lets an authorised admin who has confirmed the
   * new phone places/receives calls finish the swap on the weaker evidence
   * "endpoint registered after this phone downloaded its config". It is recorded
   * as an attestation in the audit trail and is NEVER accepted with no
   * post-delivery registration at all.
   */
  async completeReplacement(actor: Actor, id: string, requestId: string, attestedWorking = false) {
    const next = await this.own(this.database, actor, id);
    if (!next.replacesId) throw new DeviceError("replacement_not_pending");
    const previous = await this.own(this.database, actor, next.replacesId);
    await this.database.$transaction(async (tx: any) => {
      for (const mac of [next.macAddress, previous.macAddress].sort())
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`managed-phone:${mac}`}, 0))::text`;
      const current = await this.own(tx, actor, id);
      const old = await this.own(tx, actor, previous.id);
      const registration = await tx.pbxEndpointRegistration.findUnique({ where: { endpoint: current.endpoint } });
      const evidence = registrationEvidence(current, registration);
      const proven = evidence === "online" || (attestedWorking && evidence === "endpoint_registered_device_unverified");
      if (current.retiredAt || current.replacesId !== old.id || old.extensionId !== current.extensionId || !proven)
        throw new DeviceError("replacement_not_verified_old_phone_preserved");
      if (old.rpsState !== "pending_credentials" && old.rpsState !== "released")
        await this.provider.rps.release(old.macAddress, old.rpsServerId || this.serverId(), this.url(old.macAddress));
      await tx.managedDeskPhone.update({ where: { id: old.id }, data: { retiredAt: new Date(), rpsState: "released", updatedBy: actor.sub } });
      await tx.managedDeskPhone.update({ where: { id }, data: { replacesId: null, updatedBy: actor.sub } });
      await this.event(tx, actor, current, "REPLACEMENT_COMPLETED", requestId, { previousId: old.id, evidence, attestedWorking: evidence !== "online" });
    }, { timeout: 60_000 });
  }
  async served(delivery: { id: string; tenantId: string; version: number }, requestId: string) {
    await this.database.$transaction(async (tx: any) => {
      const result = await tx.managedDeskPhone.updateMany({ where: { id: delivery.id, tenantId: delivery.tenantId, configVersion: delivery.version, retiredAt: null }, data: { lastProvisionedAt: new Date(), servedVersion: delivery.version } });
      if (result.count) {
        const row = await tx.managedDeskPhone.findUnique({ where: { id: delivery.id } });
        await this.event(tx, { tenantId: delivery.tenantId, sub: "" }, row, "CONFIGURATION_SERVED", requestId, { configVersion: delivery.version });
      }
    });
  }
}
