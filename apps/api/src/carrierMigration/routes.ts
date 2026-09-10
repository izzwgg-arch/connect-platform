/**
 * Carrier migration — the admin routes behind /admin/carrier-migration.
 *
 * Moving all 52 numbers off VoIP.ms and onto SignalWire, a few at a time,
 * without dropping a call or a text.
 *
 * ⛔ Platform owner only (SUPER_ADMIN), every route — same rule as the
 * SignalWire console and IVR Migration. There is deliberately no permission
 * key that can grant it: these routes decide when a paying customer's number
 * changes carrier.
 *
 * ⛔ MARKING A PORT FILED IS RECORD-ONLY. SignalWire has no porting API — the
 * filing genuinely is a person in their dashboard — so `/filed` writes OUR
 * record and never contacts a carrier. A source guard pins that.
 *
 * ⛔ THE ONLY CARRIER WRITE HERE IS THE CLAIM (pointing a landed number at our
 * trunk), and it is the same operation the arrival watcher performs, through
 * the same decision (`decideClaim`) — a button that does something the sweep
 * would not do is a button that surprises somebody at 2am.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildBoard,
  buildGates,
  carrierMigrationE164,
  decideClaim,
  decideSmsSwitch,
  explainClaim,
  explainSmsSwitch,
  formatDid,
  normalizeDid,
  type GateState,
  type MigrationRowInput,
} from "./board";
import { runCarrierMigrationSweep, type WatchDeps } from "./arrivalWatcher";

export interface CarrierMigrationRouteDeps {
  app: any;
  db: any;
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
  /** Everything the sweep needs; the routes reuse it so both paths agree. */
  watch: Omit<WatchDeps, "db">;
}

const EVENT_PREFIX = "carrier_migration.";

function audit(db: any, actor: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const body = { actor, event, payload };
  return db.agentAuditLog
    .create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload as any,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    })
    .then(() => undefined)
    .catch(() => undefined);
}

/** Owner-confirmed fact we cannot read from anywhere: has SignalWire vetted us. */
export function attestationGranted(): boolean {
  return String(process.env.SIGNALWIRE_ATTESTATION_GRANTED || "").trim() === "1";
}

// The endpoint resolution costs a carrier call, so the gate caches it briefly.
// ⛔ A read cache, never state: a restart re-reads, and it can only ever make
// the gate stricter for a few minutes, never looser.
let endpointCache: { at: number; id: string | null; detail: string | null } | null = null;
const ENDPOINT_CACHE_MS = 5 * 60_000;

async function voicePathGate(deps: CarrierMigrationRouteDeps): Promise<{ ready: boolean; detail: string | null }> {
  const now = Date.now();
  if (endpointCache && now - endpointCache.at < ENDPOINT_CACHE_MS) {
    return { ready: Boolean(endpointCache.id), detail: endpointCache.detail };
  }
  const creds = await deps.watch.resolveCredentials().catch(() => null);
  if (!creds) {
    endpointCache = { at: now, id: null, detail: "No SignalWire credentials are saved, so a number that landed could not be pointed at the phone system." };
    return { ready: false, detail: endpointCache.detail };
  }
  try {
    const id = await deps.watch.resolvePbxSipEndpointId(creds, { listNumbers: deps.watch.listNumbers });
    endpointCache = {
      at: now,
      id,
      detail: id ? null : "SignalWire is reachable but no number on the account points at a SIP endpoint, so we cannot tell which endpoint to use.",
    };
    return { ready: Boolean(id), detail: endpointCache.detail };
  } catch (e: any) {
    const detail = `SignalWire could not be reached: ${String(e?.message || e || "unknown")}`;
    endpointCache = { at: now, id: null, detail };
    return { ready: false, detail };
  }
}

async function loadGates(deps: CarrierMigrationRouteDeps, textingNumbers: number): Promise<GateState[]> {
  const { db } = deps;
  const [active, inFlight, voice] = await Promise.all([
    db.tenantSmsRegistration.count({ where: { status: "active" } }).catch(() => 0),
    db.tenantSmsRegistration.count().catch(() => 0),
    voicePathGate(deps),
  ]);
  return buildGates({
    activeSmsRegistrations: Number(active) || 0,
    smsRegistrationsInFlight: Number(inFlight) || 0,
    textingNumbers,
    attestationGranted: attestationGranted(),
    voicePathReady: voice.ready,
    voicePathDetail: voice.detail,
  });
}

async function loadBoardData(deps: CarrierMigrationRouteDeps) {
  const { db } = deps;
  const [dids, migrations, smsNumbers] = await Promise.all([
    db.pbxTenantInboundDid.findMany({
      where: { active: true, connectTenantId: { not: null } },
      select: { e164: true, connectTenantId: true },
    }),
    db.carrierMigration.findMany({ take: 500 }),
    db.tenantSmsNumber.findMany({
      where: { active: true, tenantId: { not: null } },
      select: { phoneE164: true, provider: true, tenantId: true },
    }),
  ]);

  const tenantIds = [...new Set(dids.map((d: any) => String(d.connectTenantId)).filter(Boolean))];
  const tenants: any[] = tenantIds.length
    ? await db.tenant.findMany({ where: { id: { in: tenantIds }, pbxRemovedAt: null }, select: { id: true, name: true } })
    : [];
  const nameById = new Map<string, string>(tenants.map((t: any) => [String(t.id), String(t.name || "")]));

  const inventory = dids
    .filter((d: any) => nameById.has(String(d.connectTenantId)))
    .map((d: any) => ({
      did: normalizeDid(d.e164),
      connectTenantId: String(d.connectTenantId),
      tenantName: nameById.get(String(d.connectTenantId)) || null,
    }))
    .filter((d: any) => d.did);

  return { inventory, migrations: migrations as MigrationRowInput[], smsNumbers };
}

/** Find or lazily create the row for a number that is on the estate. */
async function rowFor(deps: CarrierMigrationRouteDeps, did: string): Promise<any | null> {
  const { db } = deps;
  const d = normalizeDid(did);
  if (!d) return null;
  const existing = await db.carrierMigration.findUnique({ where: { did: d } });
  if (existing) return existing;

  const inv = await db.pbxTenantInboundDid.findFirst({
    where: { e164: d, active: true },
    select: { connectTenantId: true },
  });
  if (!inv?.connectTenantId) return null;
  const tenant = await db.tenant.findUnique({ where: { id: String(inv.connectTenantId) }, select: { name: true } });
  return db.carrierMigration.create({
    data: {
      did: d,
      connectTenantId: String(inv.connectTenantId),
      tenantNameSnapshot: tenant?.name ? String(tenant.name) : null,
    },
  });
}

const holdSchema = z.object({ hold: z.boolean(), reason: z.string().trim().max(300).optional() });
const filedSchema = z.object({
  portReference: z.string().trim().max(120).optional(),
  focDate: z.string().trim().max(40).optional(),
});
const notesSchema = z.object({ notes: z.string().trim().max(2000) });

export function registerCarrierMigrationRoutes(deps: CarrierMigrationRouteDeps): void {
  const { app, db } = deps;

  // ── The board ──────────────────────────────────────────────────────────────
  app.get("/admin/carrier-migration/board", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const { inventory, migrations, smsNumbers } = await loadBoardData(deps);
    const textingNumbers = smsNumbers.filter((s: any) =>
      inventory.some((i: any) => carrierMigrationE164(i.did) === String(s.phoneE164)),
    ).length;
    const gates = await loadGates(deps, textingNumbers);
    const board = buildBoard({ inventory, migrations, smsNumbers, gates });
    return reply.send({ gates, ...board, attestationGranted: attestationGranted() });
  });

  // ── One number ─────────────────────────────────────────────────────────────
  app.get("/admin/carrier-migration/numbers/:did", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });

    const { inventory, migrations, smsNumbers } = await loadBoardData(deps);
    const textingNumbers = smsNumbers.filter((s: any) =>
      inventory.some((i: any) => carrierMigrationE164(i.did) === String(s.phoneE164)),
    ).length;
    const gates = await loadGates(deps, textingNumbers);
    const board = buildBoard({ inventory, migrations, smsNumbers, gates });
    for (const c of board.customers) {
      const n = c.numbers.find((x) => x.did === did);
      if (n) {
        const tendlcActive = gates.find((g) => g.id === "tendlc")?.level === "ok";
        const smsDecision = decideSmsSwitch({
          hasTexting: n.hasTexting,
          voice: n.voice,
          smsCarrier: n.sms,
          tendlcActive,
        });
        return reply.send({
          number: n,
          customer: { tenantId: c.tenantId, tenantName: c.tenantName, outbound: c.outbound, numberCount: c.numbers.length },
          gates,
          smsSwitch: smsDecision.switch
            ? { allowed: true, message: "Ready to move this number's texting to SignalWire." }
            : { allowed: false, reason: smsDecision.reason, message: explainSmsSwitch(smsDecision.reason) },
        });
      }
    }
    return reply.code(404).send({ error: "not_found", message: "That number is not on the estate." });
  });

  // ── Hold / release ─────────────────────────────────────────────────────────
  app.post("/admin/carrier-migration/numbers/:did/hold", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });
    const parsed = holdSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Check the hold reason." });

    const row = await rowFor(deps, did);
    if (!row) return reply.code(404).send({ error: "not_found", message: "That number is not on the estate." });
    if (row.status === "live" || row.status === "done") {
      return reply.code(409).send({ error: "already_moved", message: "This number has already moved — there is nothing to hold." });
    }

    const updated = await db.carrierMigration.update({
      where: { id: row.id },
      data: parsed.data.hold
        ? { status: "held", holdReason: parsed.data.reason || "Held back by hand" }
        : { status: "not_started", holdReason: null },
    });
    await audit(db, "owner", `${EVENT_PREFIX}hold_changed`, { did, hold: parsed.data.hold, reason: parsed.data.reason ?? null, by: user?.sub ?? null });
    return reply.send({ ok: true, status: updated.status, holdReason: updated.holdReason });
  });

  // ── Record that it was filed at SignalWire (record-only) ───────────────────
  // ⛔ This route must NEVER contact a carrier — SignalWire has no porting API
  // and the filing is a person's job in their dashboard. Source-guarded.
  app.post("/admin/carrier-migration/numbers/:did/filed", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });
    const parsed = filedSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Check the reference and date." });

    const row = await rowFor(deps, did);
    if (!row) return reply.code(404).send({ error: "not_found", message: "That number is not on the estate." });
    if (row.status === "live" || row.status === "done") {
      return reply.code(409).send({ error: "already_moved", message: "This number has already moved." });
    }

    let focDate: Date | null = null;
    if (parsed.data.focDate) {
      const d = new Date(parsed.data.focDate);
      if (Number.isNaN(d.getTime())) {
        return reply.code(400).send({ error: "bad_date", message: "That date could not be read. Use the date picker." });
      }
      focDate = d;
    }

    const updated = await db.carrierMigration.update({
      where: { id: row.id },
      data: {
        status: "filed",
        holdReason: null,
        portReference: parsed.data.portReference || null,
        focDate,
        filedAt: new Date(),
        filedByUserId: user?.sub ? String(user.sub) : null,
        lastError: null,
      },
    });
    await audit(db, "owner", `${EVENT_PREFIX}filed`, {
      did,
      portReference: updated.portReference,
      focDate: focDate ? focDate.toISOString() : null,
      by: user?.sub ?? null,
    });
    return reply.send({ ok: true, status: updated.status, focDate: updated.focDate, portReference: updated.portReference });
  });

  // ── Claim now (the one carrier write) ──────────────────────────────────────
  app.post("/admin/carrier-migration/numbers/:did/claim", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });

    const row = await db.carrierMigration.findUnique({ where: { did } });
    if (!row) return reply.code(404).send({ error: "not_found", message: "That number is not being migrated." });

    // Ask the SAME question the sweep asks, so a button can never do something
    // the timer would refuse.
    const pre = decideClaim(row, true);
    if (!pre.claim && pre.reason !== "not_on_account_yet") {
      return reply.code(409).send({ error: pre.reason, message: explainClaim(pre.reason) });
    }

    const result = await runCarrierMigrationSweep({ ...deps.watch, db });
    const after = await db.carrierMigration.findUnique({ where: { did } });
    if (after?.pointedAt) {
      return reply.send({ ok: true, status: after.status, landedAt: after.landedAt, pointedAt: after.pointedAt });
    }
    const err = result.errors.find((e) => e.did === did || e.did === "*");
    return reply.code(409).send({
      error: "not_claimed",
      message: err
        ? `Could not point the number at the phone system: ${err.error}`
        : "The number has not arrived on the SignalWire account yet.",
    });
  });

  // ── Move this number's texting ─────────────────────────────────────────────
  app.post("/admin/carrier-migration/numbers/:did/sms-switch", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });
    const e164 = carrierMigrationE164(did);

    const [row, smsRow, activeRegs] = await Promise.all([
      db.carrierMigration.findUnique({ where: { did } }),
      db.tenantSmsNumber.findUnique({ where: { phoneE164: e164 } }),
      db.tenantSmsRegistration.count({ where: { status: "active" } }).catch(() => 0),
    ]);
    if (!row) return reply.code(404).send({ error: "not_found", message: "That number is not being migrated." });

    const decision = decideSmsSwitch({
      hasTexting: Boolean(smsRow?.tenantId),
      voice: row.voiceCarrier === "signalwire" ? "signalwire" : "voipms",
      smsCarrier: smsRow ? (String(smsRow.provider) === "SIGNALWIRE" ? "signalwire" : "voipms") : "none",
      tendlcActive: Number(activeRegs) > 0,
    });
    if (!decision.switch) {
      return reply.code(409).send({ error: decision.reason, message: explainSmsSwitch(decision.reason) });
    }

    await db.tenantSmsNumber.update({ where: { id: smsRow.id }, data: { provider: "SIGNALWIRE" } });
    await db.carrierMigration.update({ where: { id: row.id }, data: { smsCarrier: "signalwire", smsFlippedAt: new Date() } });
    await audit(db, "owner", `${EVENT_PREFIX}sms_switched`, { did, e164, by: user?.sub ?? null });
    return reply.send({ ok: true, message: "Texting on this number now sends through SignalWire." });
  });

  // ── Notes ──────────────────────────────────────────────────────────────────
  app.post("/admin/carrier-migration/numbers/:did/notes", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const did = normalizeDid(req.params?.did);
    if (!did) return reply.code(400).send({ error: "bad_number", message: "That is not a 10-digit number." });
    const parsed = notesSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "That note is too long." });
    const row = await rowFor(deps, did);
    if (!row) return reply.code(404).send({ error: "not_found", message: "That number is not on the estate." });
    await db.carrierMigration.update({ where: { id: row.id }, data: { notes: parsed.data.notes || null } });
    return reply.send({ ok: true });
  });

  // ── What happened ──────────────────────────────────────────────────────────
  app.get("/admin/carrier-migration/events", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const limit = Math.min(Number(req.query?.limit) || 60, 200);
    const rows = await db.agentAuditLog.findMany({
      where: { event: { startsWith: EVENT_PREFIX } },
      orderBy: { ts: "desc" },
      take: limit,
      select: { id: true, ts: true, event: true, payload: true },
    });
    return reply.send({
      events: rows.map((r: any) => ({
        id: String(r.id),
        at: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        event: String(r.event).slice(EVENT_PREFIX.length),
        payload: r.payload ?? null,
      })),
    });
  });

  // ── Run the watcher now ────────────────────────────────────────────────────
  app.post("/admin/carrier-migration/sweep", async (req: any, reply: any) => {
    const user = await deps.requireOwner(req, reply);
    if (!user) return;
    const result = await runCarrierMigrationSweep({ ...deps.watch, db });
    return reply.send({ ok: true, result });
  });
}

export { formatDid };
