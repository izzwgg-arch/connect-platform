/**
 * `GET /remote-support/people` — the list behind "Choose a person…" on the
 * technician screen.
 *
 * ⛔ WHY THIS ROUTE EXISTS: the portal used to ask `/team/members`, a route that
 * never existed. Every load was a swallowed 404 and the dropdown was empty for
 * everybody (found live 2026-09-02). These tests pin the one property that
 * matters: the list is scoped by EXACTLY the rule `POST /remote-support/sessions`
 * applies — a super admin sees every approved customer, anyone else sees only
 * their own company — so the list can never offer a person the request refuses.
 *
 * Own fake db, because the attack harness's `where` evaluator cannot follow a
 * nested `tenant: {…}` relation filter and would throw.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

type Row = Record<string, any>;

const state = {
  tenants: new Map<string, Row>(),
  users: new Map<string, Row>(),
  perms: new Map<string, Set<string>>(),
  lastWhere: null as Row | null,
};

function reset() {
  state.tenants.clear();
  state.users.clear();
  state.perms.clear();
  state.lastWhere = null;
}

/** Enough of Prisma's `where` for this one route — scalar, `not`, and the nested tenant relation. */
function scalar(v: any, cond: any): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    if ("not" in cond) return cond.not === null ? v != null : v !== cond.not;
    throw new Error(`fake db: unsupported condition ${JSON.stringify(cond)}`);
  }
  return v === cond;
}
function matches(u: Row, where: Row): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === "tenant") {
      const t = state.tenants.get(u.tenantId);
      if (!t) return false;
      for (const [tk, tc] of Object.entries(cond as Row)) if (!scalar(t[tk], tc)) return false;
      continue;
    }
    if (!scalar(u[k], cond)) return false;
  }
  return true;
}

const db = {
  user: {
    findMany: async ({ where }: any) => {
      state.lastWhere = where;
      return [...state.users.values()]
        .filter((u) => matches(u, where))
        .map((u) => ({ ...u, tenant: state.tenants.get(u.tenantId) ?? null }));
    },
    findFirst: async () => null,
    findUnique: async () => null,
  },
};

mock.module("@connect/db", { namedExports: { db } });
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (user: any, key: string) => {
      if (String(user?.role).toUpperCase() === "SUPER_ADMIN") return true;
      return state.perms.get(user?.sub)?.has(key) === true;
    },
  },
});

let registerRemoteSupportRoutes: any = null;
let currentUser: Row | null = null;

function seedTenant(id: string, extra: Row = {}) {
  state.tenants.set(id, { id, name: `Company ${id}`, kind: "CUSTOMER", isApproved: true, pbxRemovedAt: null, ...extra });
}
function seedUser(input: { id: string; tenantId: string; role?: string; status?: string; keys?: string[]; firstName?: string | null; lastName?: string | null }) {
  state.users.set(input.id, {
    id: input.id,
    tenantId: input.tenantId,
    role: input.role || "USER",
    status: input.status || "ACTIVE",
    firstName: input.firstName === undefined ? input.id : input.firstName,
    lastName: input.lastName ?? null,
    email: `${input.id}@example.test`,
  });
  state.perms.set(input.id, new Set(input.keys || []));
}
const as = (userId: string) => {
  const u = state.users.get(userId);
  if (!u) throw new Error(`no such seeded user ${userId}`);
  currentUser = { sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email };
};

async function buildApp() {
  if (!registerRemoteSupportRoutes) {
    ({ registerRemoteSupportRoutes } = await import("../remoteSupportRoutes"));
  }
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => {
    req.user = currentUser;
  });
  await registerRemoteSupportRoutes(app as any, { audit: async () => {} });
  await app.ready();
  return app;
}

function seedCast() {
  seedTenant("T_A");
  seedTenant("T_B");
  seedTenant("T_GONE", { pbxRemovedAt: new Date("2026-08-12T00:00:00Z") });
  seedTenant("T_PENDING", { isApproved: false });
  seedTenant("T_ADMIN", { kind: "ADMIN", name: "Connect admin tenant" });
  seedUser({ id: "alice", tenantId: "T_A", firstName: "Alice", lastName: "Aaron" });
  seedUser({ id: "noname", tenantId: "T_A", firstName: null });
  seedUser({ id: "techA", tenantId: "T_A", keys: ["can_remote_support"] });
  seedUser({ id: "disabledA", tenantId: "T_A", status: "DISABLED" });
  seedUser({ id: "bob", tenantId: "T_B" });
  seedUser({ id: "ghost", tenantId: "T_GONE" });
  seedUser({ id: "pending", tenantId: "T_PENDING" });
  seedUser({ id: "plainA", tenantId: "T_A" });
  seedUser({ id: "root", tenantId: "T_ADMIN", role: "SUPER_ADMIN" });
}

async function people(app: any) {
  const r = await app.inject({ method: "GET", url: "/remote-support/people" });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

test("a super admin sees every person on every approved, live customer tenant — and nobody else", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("root");
  const { status, body } = await people(app);
  assert.equal(status, 200);
  const ids = body.people.map((p: Row) => p.id).sort();
  assert.deepEqual(ids, ["alice", "bob", "noname", "plainA", "techA"]);
  // Removed tenant, unapproved tenant, the admin tenant, a disabled login and
  // the super admin's own row are all absent — the request route would refuse
  // or the app could never answer for any of them.
  for (const gone of ["ghost", "pending", "root", "disabledA"]) assert.ok(!ids.includes(gone), `${gone} must not be offered`);
});

test("a technician inside one company sees only that company", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");
  const { status, body } = await people(app);
  assert.equal(status, 200);
  const ids = body.people.map((p: Row) => p.id).sort();
  assert.deepEqual(ids, ["alice", "noname", "plainA", "techA"]);
  assert.ok(!ids.includes("bob"), "another company's person must never be listed");
  // The scoping is written into the query itself, not filtered afterwards.
  assert.equal(state.lastWhere?.tenantId, "T_A");
});

test("no can_remote_support key → 403, and the query never runs", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("plainA");
  const { status, body } = await people(app);
  assert.equal(status, 403);
  assert.equal(body.error, "missing_permission");
  assert.equal(state.lastWhere, null);
});

test("each row carries a name a person can pick from — full name, else the email — plus the company", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("root");
  const { body } = await people(app);
  const byId = new Map<string, Row>(body.people.map((p: Row) => [p.id, p] as [string, Row]));
  assert.equal(byId.get("alice")?.name, "Alice Aaron");
  assert.equal(byId.get("noname")?.name, "noname@example.test");
  assert.equal(byId.get("bob")?.tenantName, "Company T_B");
  assert.equal(byId.get("bob")?.tenantId, "T_B");
  for (const p of body.people) assert.ok(p.name && p.name.trim().length > 0, "a row with no pickable name is useless in a dropdown");
});
