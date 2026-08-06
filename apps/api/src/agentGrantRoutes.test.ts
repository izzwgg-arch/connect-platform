/**
 * Grant-by-chat, the apply half — the stress cases from
 * docs/ai-context/PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md §7.
 *
 * These are written against `applyAgentPermissionGrant` directly rather than
 * through Fastify, because what has to be proven is the ORDER and the
 * atomicity: which gate refuses first, and what happens when two requests
 * arrive at the same instant. Both are invisible from a route-level test.
 *
 * The fake DB below serialises transactions (a real one takes a row lock on the
 * AgentAction) but lets everything OUTSIDE a transaction interleave freely —
 * which is the realistic race: two tabs both read a live DRAFT, both pass every
 * check, and only the atomic claim decides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyAgentPermissionGrant,
  listPendingGrants,
  GRANT_DRAFT_TTL_MS,
  type GrantApplyDeps,
  type GrantActor,
} from "./agentGrantRoutes";
import {
  GRANT_CAPABILITY_ID,
  grantParamsHashInput,
  chatGrantRoleName,
  NEVER_GRANTABLE_BY_CHAT,
  CHAT_GRANTABLE_PERMISSIONS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  type PortalPermissionKey,
} from "@connect/shared";
import { permissionParamsHash } from "@connect/shared/chatPermissionGrantHash";

const TENANT = "t1";
const OTHER_TENANT = "t2";
const PASSWORD = "correct-horse-battery";
const HASH = "hash-of-correct-horse-battery";

const ADMIN: GrantActor = { sub: "admin-1", tenantId: TENANT, role: "TENANT_ADMIN", email: "boss@acme.com" };
const SUPER: GrantActor = { sub: "root-1", tenantId: TENANT, role: "SUPER_ADMIN", email: "izzy@connect.com" };
const END_USER: GrantActor = { sub: "u9", tenantId: TENANT, role: "END_USER", email: "nobody@acme.com" };

// ─── Fake DB ─────────────────────────────────────────────────────────────────

function makeDb(seed: { users?: any[]; actions?: any[] } = {}) {
  const state = {
    users: seed.users ?? [
      { id: "admin-1", email: "boss@acme.com", tenantId: TENANT, status: "ACTIVE", passwordHash: HASH },
      { id: "root-1", email: "izzy@connect.com", tenantId: TENANT, status: "ACTIVE", passwordHash: HASH },
      { id: "u9", email: "nobody@acme.com", tenantId: TENANT, status: "ACTIVE", passwordHash: HASH },
      { id: "u2", email: "yehuda@acme.com", tenantId: TENANT, status: "ACTIVE", passwordHash: "x" },
      { id: "u7", email: "spy@other.com", tenantId: OTHER_TENANT, status: "ACTIVE", passwordHash: "x" },
    ],
    actions: seed.actions ?? [],
    customRoles: [] as any[],
    userCustomRoles: [] as any[],
  };
  let seq = 0;
  // Serialised like a real transaction on a locked row; snapshot/restore models
  // the rollback, which is what makes "nothing was changed" testable.
  let queue: Promise<unknown> = Promise.resolve();

  const api: any = {
    _state: state,
    user: {
      findUnique: async ({ where }: any) => {
        await Promise.resolve();
        return state.users.find((u) => u.id === where.id) ?? null;
      },
    },
    agentAction: {
      findUnique: async ({ where }: any) => {
        await Promise.resolve();
        return state.actions.find((a) => a.id === where.id) ?? null;
      },
      updateMany: async ({ where, data }: any) => {
        // Deliberately synchronous check-and-set: this is the atomic claim.
        const row = state.actions.find(
          (a) =>
            a.id === where.id
            && (where.status === undefined || a.status === where.status)
            && (where.approvalConsumedAt !== null || a.approvalConsumedAt == null),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    customRole: {
      upsert: async ({ where, create, update }: any) => {
        await Promise.resolve();
        const key = where.tenantId_name;
        let row = state.customRoles.find((r) => r.tenantId === key.tenantId && r.name === key.name);
        if (row) Object.assign(row, update);
        else {
          row = { id: `role-${++seq}`, ...create };
          state.customRoles.push(row);
        }
        return row;
      },
      update: async ({ where, data }: any) => {
        await Promise.resolve();
        const row = state.customRoles.find((r) => r.id === where.id);
        if (!row) throw new Error("role_not_found");
        Object.assign(row, data);
        return row;
      },
    },
    userCustomRole: {
      upsert: async ({ where, create }: any) => {
        await Promise.resolve();
        const k = where.userId_customRoleId;
        let row = state.userCustomRoles.find((r) => r.userId === k.userId && r.customRoleId === k.customRoleId);
        if (!row) {
          row = { id: `ucr-${++seq}`, ...create };
          state.userCustomRoles.push(row);
        }
        return row;
      },
    },
    $transaction: async (fn: any) => {
      const run = queue.then(async () => {
        const snapshot = JSON.parse(JSON.stringify(state));
        try {
          return await fn(api);
        } catch (err) {
          state.users = snapshot.users;
          state.actions = snapshot.actions;
          state.customRoles = snapshot.customRoles;
          state.userCustomRoles = snapshot.userCustomRoles;
          throw err;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return api;
}

function draft(over: Record<string, any> = {}) {
  const tenantId = over.tenantId ?? TENANT;
  const targetUserId = over.targetUserId ?? "u2";
  const permission = over.permission ?? "can_manage_ivr_routing";
  return {
    id: over.id ?? "act-1",
    tenantId,
    capabilityId: over.capabilityId ?? GRANT_CAPABILITY_ID,
    params: over.params ?? { targetUserId, targetEmail: "yehuda@acme.com", permission },
    status: over.status ?? "DRAFT",
    summary: "Give Yehuda K (yehuda@acme.com) permission to change the phone menus (IVR routing).",
    requestedBy: over.requestedBy ?? "admin-1",
    // `in`, not `??` — a test that overrides the hash to null must actually get null.
    paramsHash: "paramsHash" in over ? over.paramsHash : permissionParamsHash(tenantId, targetUserId, permission),
    approvalConsumedAt: over.approvalConsumedAt ?? null,
    approvedBy: null,
    executedAt: null,
    createdAt: over.createdAt ?? new Date(),
  };
}

function makeDeps(
  db: any,
  over: Partial<GrantApplyDeps> = {},
): GrantApplyDeps & { audits: any[]; rateCalls: string[] } {
  const audits: any[] = [];
  const rateCalls: string[] = [];
  return {
    db,
    comparePassword: async (plain: string, hash: string) => hash === HASH && plain === PASSWORD,
    grantablePermissions: async () =>
      new Set(Object.values(CHAT_GRANTABLE_PERMISSIONS).map((p) => p.key)) as Set<PortalPermissionKey>,
    rateLimit: (key: string) => {
      rateCalls.push(key);
      return true;
    },
    audit: async (e: any) => {
      audits.push(e);
    },
    audits,
    rateCalls,
    ...over,
  } as any;
}

const apply = (deps: GrantApplyDeps, actor: GrantActor, actionId = "act-1", password = PASSWORD) =>
  applyAgentPermissionGrant(deps, { actor, actionId, password });

function grantedPermissions(db: any, userId: string): string[] {
  const roleIds = db._state.userCustomRoles.filter((r: any) => r.userId === userId).map((r: any) => r.customRoleId);
  return db._state.customRoles
    .filter((r: any) => roleIds.includes(r.id) && r.active !== false)
    .flatMap((r: any) => r.permissions as string[]);
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test("a confirmed grant lands where the permission resolver actually reads it", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  const r: any = await apply(deps, ADMIN);

  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"]);
  // One visible, revocable place — not scattered across the account.
  assert.equal(db._state.customRoles.length, 1);
  assert.equal(db._state.customRoles[0].name, chatGrantRoleName("yehuda@acme.com", "u2"));
  assert.equal(db._state.customRoles[0].tenantId, TENANT);
  // Applied once and spent.
  const row = db._state.actions[0];
  assert.equal(row.status, "EXECUTED");
  assert.equal(row.approvedBy, "admin-1");
  assert.ok(row.executedAt && row.approvalConsumedAt, "must be stamped executed AND consumed");
  assert.ok(deps.audits.some((a) => a.action === "AGENT_GRANT_APPLIED"));
});

test("the reply is plain English and says where to undo it", async () => {
  const db = makeDb({ actions: [draft()] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.match(r.message, /yehuda@acme\.com can now change the phone menus/);
  assert.match(r.message, /Assistant grants/);
  assert.doesNotMatch(r.message, /can_manage_ivr_routing/, "no permission keys in customer-facing text");
});

test("a second, different grant for the same person joins the same role", async () => {
  const db = makeDb({
    actions: [draft(), draft({ id: "act-2", permission: "can_manage_moh" })],
  });
  const deps = makeDeps(db);
  assert.equal((await apply(deps, ADMIN, "act-1")).ok, true);
  assert.equal((await apply(deps, ADMIN, "act-2")).ok, true);
  assert.equal(db._state.customRoles.length, 1, "one role per person, not one per grant");
  assert.deepEqual(grantedPermissions(db, "u2").sort(), ["can_manage_ivr_routing", "can_manage_moh"]);
  assert.equal(db._state.userCustomRoles.length, 1);
});

test("re-granting something they already have is honest about it", async () => {
  const db = makeDb({ actions: [draft(), draft({ id: "act-2" })] });
  const deps = makeDeps(db);
  await apply(deps, ADMIN, "act-1");
  const r: any = await apply(deps, ADMIN, "act-2");
  assert.equal(r.ok, true);
  assert.equal(r.alreadyHeld, true);
  assert.match(r.message, /already/);
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"], "not duplicated");
});

// ─── STRESS: replay a consumed approval ──────────────────────────────────────

test("⛔ STRESS: replaying a consumed approval grants nothing a second time", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  assert.equal((await apply(deps, ADMIN)).ok, true);

  // Exactly the same request again — the id, the password, everything.
  const replay: any = await apply(deps, ADMIN);
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 409);
  assert.equal(replay.error, "already_used");
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"], "still exactly one");
});

test("⛔ STRESS: an approval consumed but left in DRAFT is still spent", async () => {
  // Belt and braces: consumption is checked before status, so a row that somehow
  // has a consumption stamp without an EXECUTED status cannot be replayed.
  const db = makeDb({ actions: [draft({ approvalConsumedAt: new Date() })] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.error, "already_used");
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

// ─── STRESS: the race ────────────────────────────────────────────────────────

test("⛔ STRESS: two applies racing the same approval grant exactly once", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);

  // Both start before either finishes — two tabs, or a double-click.
  const [a, b]: any[] = await Promise.all([apply(deps, ADMIN), apply(deps, ADMIN)]);

  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1, "exactly one apply may succeed");
  assert.equal(losers.length, 1);
  assert.equal(losers[0].status, 409);
  assert.equal(losers[0].error, "already_used");
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"], "granted once, not twice");
  assert.equal(db._state.userCustomRoles.length, 1);
});

test("⛔ STRESS: five simultaneous applies still grant exactly once", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  const results: any[] = await Promise.all(Array.from({ length: 5 }, () => apply(deps, ADMIN)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error === "already_used"));
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"]);
});

// ─── STRESS: tampered params ─────────────────────────────────────────────────

test("⛔ STRESS: params edited after approval are refused, and nothing is granted", async () => {
  // The row was prepared for the IVR permission; someone swapped the params to
  // a bigger one but left the hash alone.
  const d = draft();
  d.params = { targetUserId: "u2", targetEmail: "yehuda@acme.com", permission: "can_manage_tenant_settings" };
  const db = makeDb({ actions: [d] });
  const deps = makeDeps(db);

  const r: any = await apply(deps, ADMIN);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, "params_tampered");
  assert.equal(grantedPermissions(db, "u2").length, 0);
  assert.equal(db._state.actions[0].status, "DRAFT", "a refused apply must not spend the approval");
  assert.ok(deps.audits.some((a) => a.action === "AGENT_GRANT_PARAMS_TAMPERED"), "tampering must be recorded");
});

test("⛔ STRESS: swapping the RECIPIENT is caught by the same hash", async () => {
  const d = draft();
  d.params = { targetUserId: "u9", targetEmail: "nobody@acme.com", permission: "can_manage_ivr_routing" };
  const db = makeDb({ actions: [d] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.error, "params_tampered");
  assert.equal(grantedPermissions(db, "u9").length, 0);
});

test("⛔ a draft with no hash at all is not a shortcut past the check", async () => {
  const db = makeDb({ actions: [draft({ paramsHash: null })] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.ok, false);
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

test("the hash format is frozen — the agent writes it, the API recomputes it", async () => {
  // If this literal ever changes, every grant prepared by a deployed agent
  // stops applying. Locking the digest makes that a failing test, not a
  // mysterious "confirmation no longer available" in production.
  assert.equal(grantParamsHashInput("t1", "u2", "can_manage_moh"), "grant_permission|t1|u2|can_manage_moh");
  assert.equal(
    permissionParamsHash("t1", "u2", "can_manage_moh"),
    createHash("sha256").update("grant_permission|t1|u2|can_manage_moh").digest("hex"),
  );
});

// ─── STRESS: authority ───────────────────────────────────────────────────────

test("⛔ STRESS: an actor cannot hand out a permission they do not hold", async () => {
  const db = makeDb({ actions: [draft()] });
  // This admin can do music-on-hold, and nothing else.
  const deps = makeDeps(db, {
    grantablePermissions: async () => new Set(["can_manage_moh"]) as Set<PortalPermissionKey>,
  });
  const r: any = await apply(deps, ADMIN);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, "not_yours_to_grant");
  assert.equal(grantedPermissions(db, "u2").length, 0);
  assert.equal(db._state.actions[0].status, "DRAFT");
  assert.ok(deps.audits.some((a) => a.action === "AGENT_GRANT_REFUSED_NOT_YOURS"));
});

test("⛔ STRESS: a TENANT_ADMIN reaching for a protected platform-admin key is refused", async () => {
  for (const key of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) {
    const db = makeDb({ actions: [draft({ permission: key })] });
    // Worst case on purpose: pretend the authority rule WRONGLY offered it, so
    // what this proves is the chat allow-list refusing independently.
    const deps = makeDeps(db, {
      grantablePermissions: async () => new Set([key]) as Set<PortalPermissionKey>,
    });
    const r: any = await apply(deps, ADMIN);
    assert.equal(r.ok, false, `${key} must never be grantable by chat`);
    assert.equal(r.status, 403);
    assert.equal(grantedPermissions(db, "u2").length, 0);
  }
});

test("⛔ every deny-listed permission is refused even with full authority", async () => {
  for (const key of NEVER_GRANTABLE_BY_CHAT) {
    const db = makeDb({ actions: [draft({ permission: key })] });
    const deps = makeDeps(db, {
      grantablePermissions: async () => new Set([key]) as Set<PortalPermissionKey>,
    });
    const r: any = await apply(deps, ADMIN);
    assert.equal(r.error, "not_grantable_by_chat", `${key} must be refused`);
    assert.equal(grantedPermissions(db, "u2").length, 0);
  }
});

test("⛔ an end user cannot apply a grant, even one prepared for them", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  const r: any = await apply(deps, END_USER);
  assert.equal(r.status, 403);
  assert.equal(r.error, "forbidden");
  assert.equal(deps.rateCalls.length, 0, "must refuse before touching the password path");
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

// ─── STRESS: cross-tenant ────────────────────────────────────────────────────

test("⛔ STRESS: an action id from another company simply does not exist", async () => {
  const db = makeDb({ actions: [draft({ tenantId: OTHER_TENANT, targetUserId: "u7" })] });
  const deps = makeDeps(db);
  const r: any = await apply(deps, ADMIN);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.error, "grant_not_found");
  assert.equal(grantedPermissions(db, "u7").length, 0);
  assert.equal(deps.rateCalls.length, 0, "and it must not even reach the password check");
});

test("a SUPER_ADMIN may cross tenants — the same helper the role editor uses", async () => {
  const db = makeDb({ actions: [draft({ tenantId: OTHER_TENANT, targetUserId: "u7" })] });
  const r: any = await apply(makeDeps(db), SUPER);
  assert.equal(r.ok, true);
  assert.deepEqual(grantedPermissions(db, "u7"), ["can_manage_ivr_routing"]);
  assert.equal(db._state.customRoles[0].tenantId, OTHER_TENANT, "the role belongs to the TARGET's company");
});

test("⛔ the grant is filed under the ACTION's company, never the actor's", async () => {
  const db = makeDb({ actions: [draft({ tenantId: OTHER_TENANT, targetUserId: "u7" })] });
  await apply(makeDeps(db), SUPER);
  assert.equal(db._state.userCustomRoles[0].tenantId, OTHER_TENANT);
});

// ─── STRESS: the password ────────────────────────────────────────────────────

test("⛔ STRESS: a wrong password changes nothing and is recorded", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  const r: any = await apply(deps, ADMIN, "act-1", "not-my-password");
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, "invalid_password");
  assert.equal(grantedPermissions(db, "u2").length, 0);
  assert.equal(db._state.actions[0].status, "DRAFT", "the approval survives a typo");
  assert.ok(deps.audits.some((a) => a.action === "AGENT_GRANT_PASSWORD_FAILED"));
});

test("⛔ STRESS: repeated wrong passwords are rate-limited, not a guessing game", async () => {
  const db = makeDb({ actions: [draft()] });
  let allowed = 5;
  const deps = makeDeps(db, { rateLimit: () => allowed-- > 0 });

  for (let i = 0; i < 5; i++) {
    const r: any = await apply(deps, ADMIN, "act-1", `guess-${i}`);
    assert.equal(r.status, 401, "attempt within the allowance");
  }
  const blocked: any = await apply(deps, ADMIN, "act-1", "guess-6");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.error, "rate_limited");
  // ⛔ And the limiter must still bite when the password is RIGHT — otherwise it
  // is not a limiter, it is a hint that the last guess was wrong.
  const rightButBlocked: any = await apply(deps, ADMIN, "act-1", PASSWORD);
  assert.equal(rightButBlocked.status, 429);
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

test("the limiter is keyed to the person, so one admin cannot lock another out", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  await apply(deps, ADMIN, "act-1", "wrong");
  assert.deepEqual(deps.rateCalls, ["agent-grant-apply:admin-1"]);
});

test("⛔ the password is checked against the ACTOR's own hash, never the target's", async () => {
  // The target's stored hash is "x"; a compare that accidentally used it would
  // let anyone who knows the target's password grant themselves anything.
  const db = makeDb({ actions: [draft()] });
  const seen: string[] = [];
  const deps = makeDeps(db, {
    comparePassword: async (_plain, hash) => {
      seen.push(hash);
      return hash === HASH;
    },
  });
  await apply(deps, ADMIN);
  assert.deepEqual(seen, [HASH]);
});

test("⛔ a disabled admin cannot confirm anything", async () => {
  const db = makeDb({ actions: [draft()] });
  db._state.users.find((u: any) => u.id === "admin-1").status = "DISABLED";
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.status, 403);
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

// ─── STRESS: the target moved or vanished ────────────────────────────────────

test("⛔ STRESS: a target deleted between prepare and apply grants nothing", async () => {
  const db = makeDb({ actions: [draft()] });
  db._state.users = db._state.users.filter((u: any) => u.id !== "u2");
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, "target_unavailable");
  assert.equal(db._state.customRoles.length, 0);
  assert.equal(db._state.actions[0].status, "DRAFT", "the approval is not spent on a failure");
  assert.equal(db._state.actions[0].approvalConsumedAt, null);
});

test("⛔ STRESS: a target moved to another company grants nothing", async () => {
  const db = makeDb({ actions: [draft()] });
  db._state.users.find((u: any) => u.id === "u2").tenantId = OTHER_TENANT;
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.error, "target_unavailable");
  assert.equal(db._state.userCustomRoles.length, 0);
});

test("⛔ STRESS: a target disabled between prepare and apply grants nothing", async () => {
  const db = makeDb({ actions: [draft()] });
  db._state.users.find((u: any) => u.id === "u2").status = "DISABLED";
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.error, "target_unavailable");
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

// ─── Two grants for the same person, confirmed at the same moment ────────────

test("a unique-index collision on the recipient's role is retried, not surfaced", async () => {
  // Two admins confirm two different grants for the same person at once: both
  // transactions try to create that person's role and one loses the index.
  const db = makeDb({ actions: [draft()] });
  const realUpsert = db.customRole.upsert;
  let thrown = false;
  db.customRole.upsert = async (args: any) => {
    if (!thrown) {
      thrown = true;
      const e: any = new Error("Unique constraint failed on the fields: (`tenantId`,`name`)");
      e.code = "P2002";
      throw e;
    }
    return realUpsert(args);
  };

  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.ok, true, "the loser simply does it again and succeeds");
  assert.deepEqual(grantedPermissions(db, "u2"), ["can_manage_ivr_routing"]);
  assert.equal(db._state.customRoles.length, 1);
});

test("⛔ a lost claim is never retried — that would be the double grant", async () => {
  const db = makeDb({ actions: [draft()] });
  const deps = makeDeps(db);
  await apply(deps, ADMIN);
  const before = grantedPermissions(db, "u2").length;
  const replay: any = await apply(deps, ADMIN);
  assert.equal(replay.error, "already_used");
  assert.equal(grantedPermissions(db, "u2").length, before);
});

test("a genuine failure is reported, not retried into a mess", async () => {
  const db = makeDb({ actions: [draft()] });
  db.customRole.upsert = async () => {
    throw new Error("connection reset");
  };
  const deps = makeDeps(db);
  const r: any = await apply(deps, ADMIN);
  assert.equal(r.status, 500);
  assert.equal(r.error, "apply_failed");
  assert.equal(db._state.actions[0].status, "DRAFT", "the approval survives so it can be retried");
  assert.ok(deps.audits.some((a) => a.action === "AGENT_GRANT_APPLY_FAILED"));
});

// ─── What the dialog is offered ──────────────────────────────────────────────

function withFindMany(db: any) {
  db.agentAction.findMany = async ({ where }: any) => {
    await Promise.resolve();
    const cutoff = where.createdAt?.gte ? new Date(where.createdAt.gte).getTime() : 0;
    return db._state.actions.filter(
      (a: any) =>
        a.tenantId === where.tenantId
        && a.capabilityId === where.capabilityId
        && a.status === where.status
        && a.approvalConsumedAt == null
        && a.requestedBy === where.requestedBy
        && new Date(a.createdAt).getTime() >= cutoff,
    );
  };
  db.user.findUnique = async ({ where }: any) => {
    await Promise.resolve();
    const u = db._state.users.find((x: any) => x.id === where.id);
    return u ? { ...u, firstName: "Yehuda", lastName: "K" } : null;
  };
  return db;
}

test("the dialog is offered the person's own pending grant, in plain English", async () => {
  const db = withFindMany(makeDb({ actions: [draft()] }));
  const list = await listPendingGrants(db, ADMIN);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "act-1");
  assert.match(list[0].summary, /Give Yehuda K \(yehuda@acme\.com\) permission to change the phone menus/);
  assert.doesNotMatch(list[0].summary, /can_manage/);
});

test("⛔ the sentence shown is REBUILT from the params, never the stored summary", async () => {
  // The hash binds who/what/where — it does not bind the summary text. A row
  // whose summary says one thing while its params say another must not let
  // someone read one change and confirm a different one.
  const d = draft();
  d.summary = "Give Yehuda K permission to change the music on hold.";
  const db = withFindMany(makeDb({ actions: [d] }));
  const list = await listPendingGrants(db, ADMIN);
  assert.match(list[0].summary, /change the phone menus/, "the params win, not the prose");
  assert.doesNotMatch(list[0].summary, /music on hold/);
});

test("⛔ a row whose params no longer match its hash is never offered", async () => {
  const d = draft();
  d.params = { targetUserId: "u2", targetEmail: "yehuda@acme.com", permission: "can_manage_tenant_settings" };
  const db = withFindMany(makeDb({ actions: [d] }));
  assert.deepEqual(await listPendingGrants(db, ADMIN), []);
});

test("⛔ nobody is shown someone else's half-finished request", async () => {
  const db = withFindMany(makeDb({ actions: [draft({ requestedBy: "someone-else" })] }));
  assert.deepEqual(await listPendingGrants(db, ADMIN), []);
});

test("⛔ a grant for a person who has since left is not offered", async () => {
  const db = withFindMany(makeDb({ actions: [draft()] }));
  db._state.users = db._state.users.filter((u: any) => u.id !== "u2");
  assert.deepEqual(await listPendingGrants(db, ADMIN), []);
});

test("a stale draft is not offered either", async () => {
  const db = withFindMany(makeDb({ actions: [draft({ createdAt: new Date(Date.now() - GRANT_DRAFT_TTL_MS - 1000) })] }));
  assert.deepEqual(await listPendingGrants(db, ADMIN), []);
});

test("⛔ a deny-listed permission is never even offered for confirmation", async () => {
  for (const key of NEVER_GRANTABLE_BY_CHAT) {
    const db = withFindMany(makeDb({ actions: [draft({ permission: key })] }));
    assert.deepEqual(await listPendingGrants(db, ADMIN), [], `${key} must not be offered`);
  }
});

test("a consumed grant stops being offered", async () => {
  const db = withFindMany(makeDb({ actions: [draft()] }));
  assert.equal((await listPendingGrants(db, ADMIN)).length, 1);
  await apply(makeDeps(db), ADMIN);
  assert.deepEqual(await listPendingGrants(db, ADMIN), []);
});

// ─── Shape of the draft itself ───────────────────────────────────────────────

test("⛔ an action id that is not a permission grant is not found", async () => {
  const db = makeDb({ actions: [draft({ capabilityId: "action.A1.temp_forward" })] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.status, 404);
  assert.equal(r.error, "grant_not_found");
});

test("an already-decided draft cannot be revived", async () => {
  for (const status of ["DENIED", "EXPIRED", "FAILED", "EXECUTED"]) {
    const db = makeDb({ actions: [draft({ status })] });
    const r: any = await apply(makeDeps(db), ADMIN);
    assert.equal(r.ok, false, `${status} must not apply`);
    assert.equal(grantedPermissions(db, "u2").length, 0);
  }
});

test("a stale draft expires instead of applying a change nobody remembers asking for", async () => {
  const old = new Date(Date.now() - GRANT_DRAFT_TTL_MS - 1000);
  const db = makeDb({ actions: [draft({ createdAt: old })] });
  const r: any = await apply(makeDeps(db), ADMIN);
  assert.equal(r.status, 409);
  assert.equal(r.error, "expired");
  assert.equal(grantedPermissions(db, "u2").length, 0);
});

test("a missing action id is not found, and reveals nothing else", async () => {
  const db = makeDb({ actions: [draft()] });
  const r: any = await apply(makeDeps(db), ADMIN, "act-does-not-exist");
  assert.equal(r.status, 404);
  assert.equal(r.error, "grant_not_found");
});

test("⛔ no refusal message ever names a permission key or another company", async () => {
  const cases: Array<[any, GrantActor, string, string]> = [
    [makeDb({ actions: [draft({ tenantId: OTHER_TENANT, targetUserId: "u7" })] }), ADMIN, "act-1", PASSWORD],
    [makeDb({ actions: [draft()] }), ADMIN, "act-1", "wrong"],
    [makeDb({ actions: [draft({ status: "EXECUTED" })] }), ADMIN, "act-1", PASSWORD],
  ];
  for (const [db, actor, id, pw] of cases) {
    const r: any = await apply(makeDeps(db), actor, id, pw);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /can_[a-z_]+/, "no raw permission keys in customer-facing text");
    assert.doesNotMatch(r.message, new RegExp(OTHER_TENANT));
  }
});
