/**
 * An in-memory stand-in for the Prisma models the texting-registration engine
 * touches — enough of findUnique/findFirst/findMany/create/update/updateMany/
 * upsert/deleteMany/count and the where operators the engine uses
 * (equality, null, not, in, gt, lt, OR) to run the whole flow without a
 * database. Updates are applied atomically per call, which is exactly the
 * property the engine's conditional-update claims rely on.
 */
import { randomUUID } from "node:crypto";

type Row = Record<string, any>;

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    for (const [op, v] of Object.entries(cond)) {
      if (op === "not") {
        if (v === null ? actual === null || actual === undefined : matchValue(actual, v)) return false;
      } else if (op === "in") {
        if (!(v as any[]).some((x) => matchValue(actual, x))) return false;
      } else if (op === "gt") {
        if (!(actual != null && (actual instanceof Date ? actual.getTime() > (v as Date).getTime() : actual > v))) return false;
      } else if (op === "lt") {
        if (!(actual != null && (actual instanceof Date ? actual.getTime() < (v as Date).getTime() : actual < v))) return false;
      } else if (op === "contains") {
        const mode = (cond as any).mode;
        const a = String(actual ?? "");
        if (!(mode === "insensitive" ? a.toLowerCase().includes(String(v).toLowerCase()) : a.includes(String(v)))) return false;
      } else if (op === "mode") {
        continue;
      } else {
        return false;
      }
    }
    return true;
  }
  return actual === cond;
}

export function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(cond as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (cond === undefined) continue;
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as any;
  if (Array.isArray(v)) return v.map(clone) as any;
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = clone(x);
    return o;
  }
  return v;
}

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const [k, dirRaw] = Object.entries(s)[0] as [string, any];
      const dir = typeof dirRaw === "object" ? dirRaw.sort : dirRaw;
      const nullsFirst = typeof dirRaw === "object" && dirRaw.nulls === "first";
      const av = a[k], bv = b[k];
      if (av == null && bv == null) continue;
      if (av == null) return nullsFirst ? -1 : 1;
      if (bv == null) return nullsFirst ? 1 : -1;
      const an = av instanceof Date ? av.getTime() : av;
      const bn = bv instanceof Date ? bv.getTime() : bv;
      if (an < bn) return dir === "desc" ? 1 : -1;
      if (an > bn) return dir === "desc" ? -1 : 1;
    }
    return 0;
  });
}

export function createFakeDb(opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const tables: Record<string, Row[]> = {
    textingRegistration: [],
    textingRegistrationLink: [],
    textingRegistrationEin: [],
    textingRegistrationEvent: [],
    tenant: [],
    tenantBillingSettings: [],
    user: [],
    onboardingSubmission: [],
    tenantSmsNumber: [],
    tenantSmsRegistration: [],
    emailJob: [],
  };
  const unique: Record<string, string[]> = {
    textingRegistration: ["id", "publicSlug", "referenceKey", "telnyxBrandId", "telnyxCampaignId"],
    textingRegistrationLink: ["id", "tokenHash"],
    textingRegistrationEin: ["registrationId"],
  };
  const idKey = (t: string) => (t === "textingRegistrationEin" ? "registrationId" : "id");

  const relate = (t: string, row: Row, include: any): Row => {
    const out = clone(row);
    if (!include) return out;
    if (t === "textingRegistrationLink" && include.registration) {
      out.registration = clone(tables.textingRegistration.find((r) => r.id === row.registrationId));
    }
    if (t === "textingRegistrationEin" && (include.registration || include?.registration?.select)) {
      out.registration = clone(tables.textingRegistration.find((r) => r.id === row.registrationId));
    }
    if (t === "textingRegistration") {
      if (include.tenant) out.tenant = clone(tables.tenant.find((x) => x.id === row.tenantId) || null);
      if (include.links) out.links = sortRows(tables.textingRegistrationLink.filter((l) => l.registrationId === row.id), include.links.orderBy).slice(0, include.links.take ?? 1e9).map(clone);
      if (include.events) out.events = sortRows(tables.textingRegistrationEvent.filter((l) => l.registrationId === row.id), include.events.orderBy).slice(0, include.events.take ?? 1e9).map(clone);
      if (include.ein) out.ein = clone(tables.textingRegistrationEin.find((e) => e.registrationId === row.id) || null);
    }
    if (t === "tenant" && include.textingRegistrations) {
      const w = include.textingRegistrations.where;
      out.textingRegistrations = tables.textingRegistration.filter((r) => r.tenantId === row.id && matches(r, w)).map(clone);
    }
    return out;
  };

  const checkUnique = (t: string, row: Row, exceptId?: any) => {
    for (const k of unique[t] || []) {
      if (row[k] == null) continue;
      const clash = tables[t].find((r) => r[k] === row[k] && r[idKey(t)] !== exceptId);
      if (clash) {
        const err: any = new Error(`Unique constraint failed on ${t}.${k}`);
        err.code = "P2002";
        throw err;
      }
    }
  };

  const model = (t: string) => ({
    async findUnique(args: any) {
      const row = tables[t].find((r) => matches(r, args.where));
      return row ? relate(t, row, args.include ?? args.select) : null;
    },
    async findFirst(args: any = {}) {
      const rows = sortRows(tables[t].filter((r) => matches(r, args.where)), args.orderBy);
      return rows[0] ? relate(t, rows[0], args.include ?? args.select) : null;
    },
    async findMany(args: any = {}) {
      const rows = sortRows(tables[t].filter((r) => matches(r, args.where)), args.orderBy).slice(0, args.take ?? 1e9);
      return rows.map((r) => relate(t, r, args.include ?? args.select));
    },
    async count(args: any = {}) {
      return tables[t].filter((r) => matches(r, args.where)).length;
    },
    async create(args: any) {
      const ts = now();
      const row: Row = { ...(t === "textingRegistrationEin" ? {} : { id: randomUUID() }), createdAt: ts, updatedAt: ts, ...clone(args.data) };
      for (const [k, v] of Object.entries(row)) if (v === undefined) delete row[k];
      checkUnique(t, row);
      tables[t].push(row);
      return relate(t, row, args.include);
    },
    async update(args: any) {
      const row = tables[t].find((r) => matches(r, args.where));
      if (!row) {
        const err: any = new Error(`Record to update not found in ${t}`);
        err.code = "P2025";
        throw err;
      }
      const next = { ...row };
      for (const [k, v] of Object.entries(args.data)) if (v !== undefined) next[k] = clone(v);
      next.updatedAt = now();
      checkUnique(t, next, row[idKey(t)]);
      Object.assign(row, next);
      return relate(t, row, args.include);
    },
    async updateMany(args: any) {
      const rows = tables[t].filter((r) => matches(r, args.where));
      for (const row of rows) {
        for (const [k, v] of Object.entries(args.data)) if (v !== undefined) row[k] = clone(v);
        row.updatedAt = now();
      }
      return { count: rows.length };
    },
    async upsert(args: any) {
      const row = tables[t].find((r) => matches(r, args.where));
      if (row) return model(t).update({ where: args.where, data: args.update });
      return model(t).create({ data: args.create });
    },
    async deleteMany(args: any = {}) {
      const before = tables[t].length;
      tables[t] = tables[t].filter((r) => !matches(r, args.where));
      return { count: before - tables[t].length };
    },
  });

  const db: any = {};
  for (const t of Object.keys(tables)) db[t] = model(t);
  return { db, tables };
}
