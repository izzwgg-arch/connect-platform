import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PORTAL_PERMISSION_KEYS,
} from "@connect/shared";

/**
 * The snapshot forward-merge (2026-08-20).
 *
 * The live PlatformRolePermissionSnapshot row is read LITERALLY for bucket
 * roles, and it was last saved 2026-07-06 — so every default key added since
 * (Queues 2026-08-16, Conferences 2026-08-20, Tracking, Yiddish) never reached
 * real tenant admins. The fix: the reader now grants a bucket the DEFAULT keys
 * that did not yet exist at the snapshot's last save, using the write-time key
 * inventory to tell "new since the save" from "deliberately removed".
 *
 * The inventory is the explicit `knownKeys` list (stored by POST from now on),
 * falling back to the stored SUPER_ADMIN list for older rows — POST has always
 * force-stored SUPER_ADMIN as the complete key inventory of its day.
 *
 * The fixture below mirrors the REAL live row's shape: version 2, saved when
 * the queues/conference/tracking/yiddish keys did not exist, with a handful of
 * keys the admin deliberately toggled off (PBX + Admin sections, invoices,
 * can_manage_crm for TENANT_ADMIN; recordings for END_USER).
 */

// Keys added to the platform AFTER the simulated save. Everything else in
// today's inventory existed at save time.
const NEW_SINCE_SAVE = new Set<string>([
  "can_use_yiddish",
  "can_view_queues",
  "can_view_queue_wallboard",
  "can_view_queue_reports",
  "can_create_queues",
  "can_view_pbx_queues",
  "can_view_conferences",
  "can_manage_conferences",
  "can_view_pbx_conference",
  ...PORTAL_PERMISSION_KEYS.filter((k) => (k as string).includes("tracking")),
]);

const INVENTORY_AT_SAVE = PORTAL_PERMISSION_KEYS.filter((k) => !NEW_SINCE_SAVE.has(k as string));

const TENANT_ADMIN_DELIBERATELY_OFF = new Set<string>([
  "can_view_section_pbx",
  "can_view_section_admin",
  "can_view_billing_invoices",
  "can_manage_crm",
]);
const END_USER_DELIBERATELY_OFF = new Set<string>(["can_view_recordings"]);

function legacyLiveRow() {
  return {
    id: "default",
    roles: {
      version: 2,
      roles: {
        END_USER: DEFAULT_ROLE_PERMISSIONS.END_USER.filter(
          (k) => !NEW_SINCE_SAVE.has(k as string) && !END_USER_DELIBERATELY_OFF.has(k as string),
        ),
        TENANT_ADMIN: DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.filter(
          (k) => !NEW_SINCE_SAVE.has(k as string) && !TENANT_ADMIN_DELIBERATELY_OFF.has(k as string),
        ),
        SUPER_ADMIN: INVENTORY_AT_SAVE,
      },
      // NO knownKeys — like the real row saved before this feature existed.
    },
  };
}

let row: any = legacyLiveRow();
const upserts: any[] = [];

const fakeDb = {
  platformRolePermissionSnapshot: {
    findUnique: async () => row,
    upsert: async (args: any) => {
      upserts.push(args);
      return { id: "default", roles: args.update.roles };
    },
  },
};

mock.module("@connect/db", { namedExports: { db: fakeDb } });

// Lazy — transpiled to CJS (no top-level await), and the module must not load
// before mock.module("@connect/db") is in place.
type Mod = {
  listFor: (bucket: "END_USER" | "TENANT_ADMIN" | "SUPER_ADMIN") => Promise<string[]>;
  registerRoutes: (app: any) => Promise<void>;
  resetCaches: () => void;
};
let mod: Mod | null = null;
async function load(): Promise<Mod> {
  if (!mod) {
    const perms = await import("./platformRolePermissions");
    const cache = await import("./permissionCache");
    mod = {
      listFor: (b) => perms.getEffectivePortalPermissionListForBucket(b) as Promise<string[]>,
      registerRoutes: (app) => perms.registerPlatformRolePermissionRoutes(app),
      resetCaches: cache.__resetPortalPermissionCaches,
    };
  }
  return mod;
}

async function listWith(nextRow: any, bucket: "END_USER" | "TENANT_ADMIN" | "SUPER_ADMIN") {
  const m = await load();
  m.resetCaches();
  row = nextRow;
  return m.listFor(bucket);
}

test("TENANT_ADMIN gains the action keys born after the snapshot's save", async () => {
  const list = new Set(await listWith(legacyLiveRow(), "TENANT_ADMIN"));
  for (const key of [
    "can_view_queues",
    "can_view_queue_wallboard",
    "can_view_queue_reports",
    "can_create_queues",
    "can_view_conferences",
    "can_manage_conferences",
    "can_use_yiddish",
  ]) {
    assert.ok(list.has(key), `TENANT_ADMIN must now hold ${key}`);
  }
});

test("a genuinely NEW section rides in whole: Tracking section, pages and actions", async () => {
  const list = new Set(await listWith(legacyLiveRow(), "TENANT_ADMIN"));
  for (const key of [
    "can_view_section_tracking",
    "can_view_tracking_dashboard",
    "can_view_tracking_orders",
    "can_view_tracking",
    "can_manage_tracking",
    "can_dispatch_tracking",
  ]) {
    assert.ok(list.has(key), `TENANT_ADMIN must now hold ${key}`);
  }
});

test("a new PAGE inside a section the admin switched OFF stays hidden", async () => {
  // The admin deliberately removed can_view_section_pbx. The new Queues and
  // Conference nav keys live under that section, so they must NOT be granted —
  // a page must not become reachable inside a section the admin closed.
  const list = new Set(await listWith(legacyLiveRow(), "TENANT_ADMIN"));
  assert.ok(!list.has("can_view_pbx_queues"), "pbx queues nav key must stay off (PBX section removed)");
  assert.ok(!list.has("can_view_pbx_conference"), "pbx conference nav key must stay off (PBX section removed)");
});

test("keys the admin deliberately removed are NOT resurrected", async () => {
  const ta = new Set(await listWith(legacyLiveRow(), "TENANT_ADMIN"));
  for (const key of TENANT_ADMIN_DELIBERATELY_OFF) {
    assert.ok(!ta.has(key), `${key} was deliberately removed and must stay removed`);
  }
  const eu = new Set(await listWith(legacyLiveRow(), "END_USER"));
  assert.ok(!eu.has("can_view_recordings"), "END_USER recordings removal must survive");
});

test("END_USER gets its own new defaults and nothing of TENANT_ADMIN's", async () => {
  const list = new Set(await listWith(legacyLiveRow(), "END_USER"));
  assert.ok(list.has("can_use_yiddish"), "END_USER must gain can_use_yiddish");
  assert.ok(!list.has("can_view_queues"), "queues are a TENANT_ADMIN default, not END_USER's");
  assert.ok(!list.has("can_manage_conferences"), "conference management is not an END_USER default");
});

test("no derivable inventory → strictly literal (today's behavior preserved)", async () => {
  const bare = legacyLiveRow();
  delete (bare.roles.roles as Partial<typeof bare.roles.roles>).SUPER_ADMIN;
  const list = new Set(await listWith(bare, "TENANT_ADMIN"));
  assert.ok(!list.has("can_view_queues"), "without an inventory the reader must not guess");
  assert.ok(!list.has("can_view_section_tracking"), "without an inventory the reader must not guess");
});

test("an explicit knownKeys list beats the SUPER_ADMIN inference", async () => {
  // Admin saved AFTER the queues keys existed (knownKeys includes them) and
  // left them off — that is a deliberate removal even though the stored
  // SUPER_ADMIN list would suggest otherwise.
  const fresh = legacyLiveRow();
  (fresh.roles as any).knownKeys = [...PORTAL_PERMISSION_KEYS];
  const list = new Set(await listWith(fresh, "TENANT_ADMIN"));
  assert.ok(!list.has("can_view_queues"), "a key inside knownKeys but absent from the list is a removal");
  assert.ok(!list.has("can_view_section_tracking"), "same for the tracking section");
});

test("SUPER_ADMIN still holds every currently-defined key", async () => {
  const list = new Set(await listWith(legacyLiveRow(), "SUPER_ADMIN"));
  for (const key of PORTAL_PERMISSION_KEYS) {
    assert.ok(list.has(key as string), `SUPER_ADMIN must hold ${key}`);
  }
});

test("v1 snapshots keep the legacy-expansion path, untouched by the merge", async () => {
  const v1 = { id: "default", roles: { TENANT_ADMIN: ["can_view_dashboard"] } };
  const list = new Set(await listWith(v1, "TENANT_ADMIN"));
  assert.ok(list.has("can_view_dashboard"));
  assert.ok(list.has("can_view_workspace_overview"), "v1 lists still expand legacy keys");
  assert.ok(!list.has("can_view_queues"), "v1 lists must not forward-merge");
});

test("POST now stores knownKeys = the full key inventory of the day", async () => {
  const m = await load();
  const routes: Record<string, Function> = {};
  const app = {
    get: (p: string, h: Function) => { routes[`GET ${p}`] = h; },
    post: (p: string, h: Function) => { routes[`POST ${p}`] = h; },
    log: { error: () => {} },
  };
  await m.registerRoutes(app);
  upserts.length = 0;
  const reply = { code() { return this; }, send(x: unknown) { return x; } };
  const res = await routes["POST /admin/role-permissions"](
    {
      user: { role: "SUPER_ADMIN" },
      body: {
        permissions: {
          END_USER: DEFAULT_ROLE_PERMISSIONS.END_USER,
          TENANT_ADMIN: DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN,
          SUPER_ADMIN: [...PORTAL_PERMISSION_KEYS],
        },
      },
    },
    reply,
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(upserts.length, 1);
  const stored = upserts[0].update.roles;
  assert.equal(stored.version, 2);
  assert.deepEqual([...stored.knownKeys].sort(), [...PORTAL_PERMISSION_KEYS].sort());
});

test("round-trip stability: reading back a fresh save changes nothing", async () => {
  // Save through the real POST handler, then read the stored payload back:
  // the forward-merge must be a no-op on a snapshot whose knownKeys are
  // current — proving it only ever bridges the gap between saves.
  const stored = upserts[0].update.roles;
  const rereadTa = await listWith({ id: "default", roles: stored }, "TENANT_ADMIN");
  assert.deepEqual(
    [...rereadTa].sort(),
    [...new Set(stored.roles.TENANT_ADMIN as string[])].sort(),
    "normalized read of a fresh save must equal the saved list exactly",
  );
});
