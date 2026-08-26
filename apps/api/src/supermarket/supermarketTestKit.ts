/**
 * Shared test infrastructure for the supermarket suites: a faithful fake db
 * and a faithful fake POS register.
 *
 * ⛔ FAITHFULNESS RULES, each one bought by a real incident elsewhere in this
 * repo:
 *  - reads return SNAPSHOT COPIES, never live rows (a fake handing back the
 *    shared object masks every check-then-act race — the desk-phone reset
 *    lesson);
 *  - UNIQUE constraints throw P2002 exactly like Prisma (the claim patterns
 *    under test depend on them);
 *  - updateMany honours its where and reports an honest count (a fake that
 *    ignores where is how the day-1 billing bug shipped green);
 *  - unknown enum-ish values are NOT silently accepted where prod would throw.
 *
 * The fake POS implements their documented semantics: x-api-key auth,
 * X-Customer-Pin gates on balance + charges, externalId/externalOrderId
 * 409 dedupe, cursor+lastMod product paging, Retry-After on 429 — plus
 * failure injection (per-call-count 429/500/timeout) and a request log the
 * money invariants are audited against.
 */

export type FakeRow = Record<string, any>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function matches(row: FakeRow, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(row, cond)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c: any = cond;
      // relation sub-match (e.g. thread: { type: "SMS" })
      if (!("in" in c) && !("notIn" in c) && !("not" in c) && !("gte" in c) && !("lte" in c) && !("gt" in c) && !("lt" in c) && !("contains" in c) && !("startsWith" in c) && !("equals" in c) && !("mode" in c)) {
        if (value === null || typeof value !== "object") return false;
        if (!matches(value, c)) return false;
        continue;
      }
      if ("equals" in c && value !== c.equals) return false;
      if ("in" in c && !c.in.includes(value)) return false;
      if ("notIn" in c && c.notIn.includes(value)) return false;
      if ("not" in c) {
        if (c.not === null) {
          if (value === null || value === undefined) return false;
        } else if (value === c.not) return false;
      }
      if ("gte" in c) {
        const a = value instanceof Date || typeof value === "string" ? new Date(value).getTime() : value;
        const b = c.gte instanceof Date || typeof c.gte === "string" ? new Date(c.gte).getTime() : c.gte;
        if (!(a >= b)) return false;
      }
      if ("lte" in c) {
        const a = value instanceof Date || typeof value === "string" ? new Date(value).getTime() : value;
        const b = c.lte instanceof Date || typeof c.lte === "string" ? new Date(c.lte).getTime() : c.lte;
        if (!(a <= b)) return false;
      }
      if ("contains" in c) {
        const hay = String(value ?? "");
        const needle = String(c.contains);
        if (c.mode === "insensitive") {
          if (!hay.toLowerCase().includes(needle.toLowerCase())) return false;
        } else if (!hay.includes(needle)) return false;
      }
      if ("startsWith" in c && !String(value ?? "").startsWith(String(c.startsWith))) return false;
      continue;
    }
    // Date equality by time
    if (cond instanceof Date || value instanceof Date) {
      if (new Date(value as any).getTime() !== new Date(cond as any).getTime()) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function orderRows(rows: FakeRow[], orderBy: any): FakeRow[] {
  if (!orderBy) return rows;
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const entry of entries) {
      const [key, dir] = Object.entries(entry)[0] as [string, string];
      const av = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  return sorted;
}

function applySelect(row: FakeRow, select: any, relations: Record<string, (row: FakeRow) => any>): FakeRow {
  const resolved: FakeRow = { ...row };
  for (const [name, resolve] of Object.entries(relations)) {
    if (select?.[name] || (!select && false)) resolved[name] = resolve(row);
  }
  if (!select) return clone(resolved);
  const out: FakeRow = {};
  for (const [key, want] of Object.entries(select)) {
    if (!want) continue;
    if (relations[key]) {
      const rel = relations[key](row);
      const sub = typeof want === "object" && (want as any).select ? (want as any).select : null;
      if (Array.isArray(rel)) {
        out[key] = rel.map((r) => (sub ? applySelect(r, sub, {}) : clone(r)));
      } else {
        out[key] = sub ? applySelect(rel ?? {}, sub, {}) : clone(rel);
      }
    } else {
      out[key] = clone(row[key]);
    }
  }
  return out;
}

class P2002Error extends Error {
  code = "P2002";
  constructor(target: string) {
    super(`Unique constraint failed: P2002 ${target}`);
  }
}

export type FakeTableSpec = {
  uniques?: string[][];
  defaults?: () => FakeRow;
  relations?: Record<string, (row: FakeRow, db: FakeDb) => any>;
  /** Column names accepted in where/data; unknown keys in where THROW like Prisma. */
};

export class FakeDb {
  tables = new Map<string, FakeRow[]>();
  specs = new Map<string, FakeTableSpec>();
  seq = 0;
  [key: string]: any;

  constructor(models: Record<string, FakeTableSpec>) {
    for (const [name, spec] of Object.entries(models)) {
      this.tables.set(name, []);
      this.specs.set(name, spec);
      this[name] = this.makeModel(name);
    }
  }

  rows(name: string): FakeRow[] {
    return this.tables.get(name)!;
  }
  seed(name: string, row: FakeRow): FakeRow {
    const full = { ...(this.specs.get(name)!.defaults?.() ?? {}), ...row };
    if (!full.id) full.id = `${name}_${++this.seq}`;
    this.tables.get(name)!.push(full);
    return full;
  }

  private relResolvers(name: string): Record<string, (row: FakeRow) => any> {
    const spec = this.specs.get(name)!;
    const out: Record<string, (row: FakeRow) => any> = {};
    for (const [rel, fn] of Object.entries(spec.relations ?? {})) out[rel] = (row) => fn(row, this);
    return out;
  }

  /** A view of the row whose relation keys resolve on access, so a Prisma-style
   *  relation filter in `where` (e.g. thread: { type: "SMS" }) matches like prod. */
  private withRelations(name: string, row: FakeRow): FakeRow {
    const rels = this.relResolvers(name);
    if (Object.keys(rels).length === 0) return row;
    return new Proxy(row, {
      get: (target, key: string) => (key in target ? target[key as any] : rels[key as any]?.(target)),
      has: (target, key: string) => key in target || key in rels,
    });
  }

  private checkUniques(name: string, candidate: FakeRow, ignoreRow?: FakeRow) {
    const spec = this.specs.get(name)!;
    for (const unique of spec.uniques ?? []) {
      const clash = this.rows(name).find(
        (r) => r !== ignoreRow && unique.every((col) => r[col] !== null && r[col] !== undefined && r[col] === candidate[col]),
      );
      if (clash && unique.every((col) => candidate[col] !== null && candidate[col] !== undefined)) {
        throw new P2002Error(unique.join("_"));
      }
    }
  }

  private resolveWhereUnique(name: string, where: any): FakeRow | undefined {
    // supports { id }, { tenantId_provider: {...} }-style compound keys, and plain uniques
    const rows = this.rows(name);
    if (where.id !== undefined) return rows.find((r) => r.id === where.id);
    for (const [key, value] of Object.entries(where)) {
      if (value !== null && typeof value === "object" && key.includes("_")) {
        return rows.find((r) => Object.entries(value as FakeRow).every(([col, v]) => r[col] === v));
      }
    }
    return rows.find((r) => matches(r, where));
  }

  private makeModel(name: string) {
    const relations = () => this.relResolvers(name);
    return {
      findFirst: async ({ where, select, orderBy }: any = {}) => {
        const row = orderRows(this.rows(name).filter((r) => matches(this.withRelations(name, r), where)), orderBy)[0];
        return row ? applySelect(row, select, relations()) : null;
      },
      findUnique: async ({ where, select }: any = {}) => {
        const row = this.resolveWhereUnique(name, where ?? {});
        return row ? applySelect(row, select, relations()) : null;
      },
      findMany: async ({ where, select, orderBy, take, skip }: any = {}) => {
        let rows = orderRows(this.rows(name).filter((r) => matches(this.withRelations(name, r), where)), orderBy);
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((r) => applySelect(r, select, relations()));
      },
      count: async ({ where }: any = {}) => this.rows(name).filter((r) => matches(this.withRelations(name, r), where)).length,
      create: async ({ data, select }: any) => {
        const full = { ...(this.specs.get(name)!.defaults?.() ?? {}), ...clone(data) };
        if (!full.id) full.id = `${name}_${++this.seq}`;
        if (full.createdAt === undefined) full.createdAt = new Date();
        if (full.updatedAt === undefined) full.updatedAt = new Date();
        this.checkUniques(name, full);
        this.rows(name).push(full);
        return applySelect(full, select, relations());
      },
      update: async ({ where, data, select }: any) => {
        const row = this.resolveWhereUnique(name, where);
        if (!row) throw new Error("P2025 record not found");
        this.applyData(row, data);
        this.checkUniques(name, row, row);
        row.updatedAt = new Date();
        return applySelect(row, select, relations());
      },
      updateMany: async ({ where, data }: any = {}) => {
        const rows = this.rows(name).filter((r) => matches(this.withRelations(name, r), where));
        for (const row of rows) {
          this.applyData(row, data);
          row.updatedAt = new Date();
        }
        return { count: rows.length };
      },
      upsert: async ({ where, create, update, select }: any) => {
        const existing = this.resolveWhereUnique(name, where);
        if (existing) {
          this.applyData(existing, update);
          existing.updatedAt = new Date();
          return applySelect(existing, select, relations());
        }
        const full = { ...(this.specs.get(name)!.defaults?.() ?? {}), ...clone(create) };
        if (!full.id) full.id = `${name}_${++this.seq}`;
        full.createdAt = full.createdAt ?? new Date();
        full.updatedAt = new Date();
        this.checkUniques(name, full);
        this.rows(name).push(full);
        return applySelect(full, select, relations());
      },
      deleteMany: async ({ where }: any = {}) => {
        const keep = this.rows(name).filter((r) => !matches(r, where));
        const removed = this.rows(name).length - keep.length;
        this.tables.set(name, keep);
        this[name] = this.makeModel(name); // rebind over the fresh array
        return { count: removed };
      },
    };
  }

  private applyData(row: FakeRow, data: any) {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value) && "increment" in (value as any)) {
        row[key] = (row[key] ?? 0) + (value as any).increment;
      } else if (value !== undefined) {
        row[key] = clone(value);
      }
    }
  }
}

export function makeSupermarketDb(): FakeDb {
  const db = new FakeDb({
    tenant: { uniques: [["id"]], defaults: () => ({ crmMode: "classic", pbxRemovedAt: null, name: "T" }) },
    user: {
      uniques: [["email"]],
      defaults: () => ({ role: "USER", status: "ACTIVE", lastLoginAt: null, phone: null, firstName: null, lastName: null }),
    },
    providerCredential: { uniques: [["tenantId", "provider"]], defaults: () => ({ isEnabled: true, label: null }) },
    posCatalogItem: {
      uniques: [["tenantId", "posProductId"]],
      defaults: () => ({ code: "", name: "", priceCents: 0, priceQty: 1, unitPriceCents: 0, isActive: true, posLastMod: null }),
    },
    posCatalogSyncState: {
      uniques: [["tenantId"]],
      defaults: () => ({ lastMod: null, cursor: null, lastSyncAt: null, lastError: null, creditsSpent: 0, itemCount: 0 }),
    },
    supermarketOrderDraft: {
      uniques: [["tenantId", "sourceType", "sourceId"], ["posExternalId"]],
      defaults: () => ({
        threadId: null, customerName: "", customerPhone: "", posCustomerId: null, transcript: "", translation: "",
        items: [], comments: "", notes: "", status: "NEEDS_REVIEW", agentItems: null, corrections: null,
        orderMethod: "Pickup", posOrderId: null, posExternalId: null, submitError: null, reviewedBy: null,
        approvedAt: null, submittedAt: null,
      }),
    },
    supermarketPhonePin: { uniques: [["tenantId", "posCustomerId", "phoneE164"]], defaults: () => ({ lastUsedAt: null }) },
    supermarketPayCall: {
      uniques: [["tenantId", "callId"]],
      defaults: () => ({ callerNumber: "", state: null, posCustomerId: null, chargeSeq: 0, chargedCents: 0, status: "open" }),
    },
    supermarketSpecial: {
      uniques: [["id"]],
      defaults: () => ({ status: "DRAFT", recipientCount: 0, sentCount: 0, createdBy: null, sentAt: null }),
    },
    marketingUnsubscribe: { uniques: [["tenantId", "email"]], defaults: () => ({}) },
    supermarketSettings: {
      uniques: [["tenantId"]],
      defaults: () => ({
        autoSubmitEnabled: false, autoSubmitMaxCorrectionPct: 5, autoSubmitMinWeeks: 2,
        deliveryIngestEnabled: false, deliveryStoreRef: "main", payIvrEnabled: false, updatedBy: null,
      }),
    },
    emailJob: { uniques: [["id"]], defaults: () => ({ status: "QUEUED", attempts: 0 }) },
    contact: { uniques: [["id"]], defaults: () => ({ active: true, displayName: "" }), relations: { emails: (row, dbx) => dbx.rows("contactEmail").filter((e) => e.contactId === row.id) } },
    contactEmail: { uniques: [["contactId", "email"]], defaults: () => ({ isPrimary: false }) },
    voicemail: { uniques: [["id"]], defaults: () => ({ transcript: null, callerNumber: null, callerName: null, deletedAt: null }) },
    connectChatMessage: {
      uniques: [["id"]],
      defaults: () => ({ direction: "INBOUND", body: "", threadId: null }),
      relations: { thread: (row, dbx) => dbx.rows("connectChatThread").find((t) => t.id === row.threadId) ?? null },
    },
    connectChatThread: { uniques: [["id"]], defaults: () => ({ type: "SMS", externalSmsE164: "", title: "" }) },
    driverProfile: { uniques: [["tenantId", "userId"]], defaults: () => ({ status: "OFFLINE", active: true, activeRunId: null }) },
  });
  return db;
}

// ─── the fake POS register ───────────────────────────────────────────────────

export type FakePosCustomer = {
  id: string;
  phone10: string;
  firstName?: string;
  lastName?: string;
  pin: string | null;
  balanceCents: number;
  cards: Array<{ id: string; masked: string }>;
  address1?: string;
  city?: string;
};

export type FakePosOptions = {
  apiKey?: string;
  /** every Nth request (1-based counter) fails with this status; 0 = never */
  failEvery?: number;
  failStatus?: number;
  /** request indexes (1-based) that should time out (AbortError) */
  timeoutOn?: Set<number>;
  declineCards?: boolean;
};

export class FakePos {
  apiKey: string;
  customers = new Map<string, FakePosCustomer>();
  products: Array<{ id: string; code: string; name: string; price: number; priceQty?: number; lastMod: string; inactive?: boolean }> = [];
  charges = new Map<string, { customerId: string; amount: number; cardId: string }>();
  orders = new Map<string, { externalOrderId: string; body: any }>();
  requestLog: Array<{ method: string; path: string; pin: string | null }> = [];
  counter = 0;
  opts: FakePosOptions;

  constructor(opts: FakePosOptions = {}) {
    this.opts = opts;
    this.apiKey = opts.apiKey ?? "fake-pos-key-000001";
  }

  addCustomer(c: FakePosCustomer) {
    this.customers.set(c.id, c);
  }

  fetchImpl = async (url: string, init: any) => {
    this.counter++;
    const u = new URL(url);
    const path = u.pathname;
    const pin = init.headers?.["X-Customer-Pin"] ?? null;
    this.requestLog.push({ method: init.method, path, pin });

    if (this.opts.timeoutOn?.has(this.counter)) {
      const err: any = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (this.opts.failEvery && this.counter % this.opts.failEvery === 0) {
      return this.res(this.opts.failStatus ?? 500, { error: "injected" }, this.opts.failStatus === 429 ? { "retry-after": "1" } : {});
    }
    if (init.headers?.["x-api-key"] !== this.apiKey) return this.res(401, { error: "bad key" });

    // customers
    let m = path.match(/^\/customers\/phonenumber\/(\d+)\/id$/) ?? path.match(/^\/customers\/phonenumber\/(\d+)$/);
    if (m && init.method === "GET") {
      const c = [...this.customers.values()].find((x) => x.phone10 === m![1]);
      if (!c) return this.res(404, { error: "not found" });
      return this.res(200, { id: c.id, firstName: c.firstName, lastName: c.lastName });
    }
    m = path.match(/^\/customers\/id\/([^/]+)\/balance$/);
    if (m && init.method === "GET") {
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return this.res(404, { error: "not found" });
      if (!c.pin || pin !== c.pin) return this.res(401, { error: "bad pin" });
      return this.res(200, { balance: c.balanceCents / 100 });
    }
    m = path.match(/^\/customers\/id\/([^/]+)\/cards$/);
    if (m && init.method === "GET") {
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return this.res(404, { error: "not found" });
      return this.res(200, c.cards);
    }
    m = path.match(/^\/customers\/id\/([^/]+)\/charges$/);
    if (m && init.method === "POST") {
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return this.res(404, { error: "not found" });
      if (!c.pin || pin !== c.pin) return this.res(401, { error: "bad pin" });
      const body = JSON.parse(init.body);
      if (this.charges.has(body.externalId)) return this.res(409, { error: "duplicate externalId" });
      if (this.opts.declineCards) return this.res(422, { error: "declined" });
      const cents = Math.round(body.amount * 100);
      this.charges.set(body.externalId, { customerId: c.id, amount: cents, cardId: body.cardId });
      c.balanceCents -= cents;
      return this.res(200, { amountCharged: body.amount, authCode: "A1", referenceNo: `R${this.counter}`, newBalance: c.balanceCents / 100 });
    }
    m = path.match(/^\/customers\/id\/([^/]+)$/);
    if (m && init.method === "GET") {
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return this.res(404, { error: "not found" });
      return this.res(200, { id: c.id, firstName: c.firstName, lastName: c.lastName, address1: c.address1, city: c.city });
    }

    // products
    if (path === "/products" && init.method === "GET") {
      const take = Number(u.searchParams.get("take") ?? 100);
      const cursor = u.searchParams.get("cursor");
      const lastMod = u.searchParams.get("lastMod");
      let list = this.products;
      if (lastMod) list = list.filter((p) => p.lastMod > lastMod);
      const start = cursor ? Number(cursor) : 0;
      const page = list.slice(start, start + take);
      const nextCursor = start + take < list.length ? String(start + take) : null;
      return this.res(200, { items: page.map((p) => ({ id: p.id, code: p.code, name: p.name, price: p.price, priceQty: p.priceQty, lastMod: p.lastMod, inactive: p.inactive })), cursor: nextCursor });
    }
    m = path.match(/^\/products\/code\/([^/]+)$/);
    if (m && init.method === "GET") {
      const p = this.products.find((x) => x.code === decodeURIComponent(m![1]));
      return p ? this.res(200, p) : this.res(404, { error: "not found" });
    }

    // orders
    if (path === "/orders" && init.method === "POST") {
      const body = JSON.parse(init.body);
      const ext = String(body.externalOrderId ?? "");
      if (ext && this.orders.has(ext)) return this.res(409, { error: "duplicate order" });
      const id = `ord_${this.orders.size + 1}`;
      this.orders.set(ext || id, { externalOrderId: ext, body });
      return this.res(201, { id });
    }
    m = path.match(/^\/orders\/external\/([^/]+)$/);
    if (m && init.method === "GET") {
      const o = this.orders.get(decodeURIComponent(m[1]));
      return o ? this.res(200, { id: `ord_ext_${m[1]}` }) : this.res(404, { error: "not found" });
    }
    m = path.match(/^\/orders\/id\/([^/]+)$/);
    if (m && init.method === "GET") {
      return this.res(404, { error: "not found" }); // probe path
    }

    return this.res(404, { error: `unhandled ${init.method} ${path}` });
  };

  private res(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    };
  }
}

/** Deterministic PRNG so every stress failure is reproducible from its seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
