// The Studio's number picker must offer every number the tenant owns on the
// PBX (the synced PbxTenantInboundDid list — same source the Phone Numbers
// page shows), not only hand-registered DidRouteMapping rows. Found live
// 2026-08-05: the whole platform had 3 mapping rows, so every other tenant —
// including every onboarded customer — saw an empty picker and could never
// attach their published menu to their own number.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureMappingsForOwnedNumbers, normalizeDidNumber } from "./didSwitchSchedule";

function fakeDb(opts: {
  owned: Array<{ e164: string; pbxInstanceId?: string | null }>;
  /** e164 values (normalised) that already exist somewhere → create throws P2002. */
  takenElsewhere?: string[];
}) {
  const created: any[] = [];
  return {
    created,
    pbxTenantInboundDid: {
      findMany: async ({ where }: any) => {
        assert.equal(where.active, true, "must only read active synced numbers");
        assert.ok(where.connectTenantId, "must scope to the tenant");
        return opts.owned;
      },
    },
    didRouteMapping: {
      create: async ({ data }: any) => {
        if ((opts.takenElsewhere ?? []).includes(data.e164)) {
          const err: any = new Error("Unique constraint failed on e164");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `map-${created.length + 1}`, routingMode: "pbx", ivrProfileId: null, ...data };
        created.push(row);
        return row;
      },
    },
  };
}

test("normalizeDidNumber: digits only, +-prefixed, junk refused", () => {
  assert.equal(normalizeDidNumber("8457231213"), "+8457231213");
  assert.equal(normalizeDidNumber("(845) 723-1213"), "+8457231213");
  assert.equal(normalizeDidNumber("+8457231213"), "+8457231213");
  assert.equal(normalizeDidNumber("123"), null);
  assert.equal(normalizeDidNumber(""), null);
});

test("an owned PBX number with no mapping row gets one created (draft-only)", async () => {
  const db = fakeDb({ owned: [{ e164: "8457231213", pbxInstanceId: "pbx-1" }] });
  const added = await ensureMappingsForOwnedNumbers(db, "tenant-cc", [], "user-1");
  assert.equal(added.length, 1);
  assert.equal(added[0].e164, "+8457231213");
  assert.equal(added[0].tenantId, "tenant-cc");
  assert.equal(added[0].pbxInstanceId, "pbx-1");
  assert.equal(added[0].enabled, true);
  // Draft-only: the create must never set routingMode/ivrProfileId — flipping
  // live routing stays exclusively with the switch routes.
  assert.equal(db.created[0].routingMode, "pbx");
  assert.equal(db.created[0].ivrProfileId, null);
});

test("a number already mapped for this tenant is left alone", async () => {
  const db = fakeDb({ owned: [{ e164: "8457231213" }] });
  const existing = [{ e164: "+8457231213" }];
  const added = await ensureMappingsForOwnedNumbers(db, "tenant-cc", existing, null);
  assert.equal(added.length, 0);
  assert.equal(db.created.length, 0);
});

test("a number mapped under ANOTHER tenant is skipped, not hijacked", async () => {
  const db = fakeDb({
    owned: [{ e164: "8457823064" }, { e164: "8457231213" }],
    takenElsewhere: ["+8457823064"],
  });
  const added = await ensureMappingsForOwnedNumbers(db, "tenant-cc", [], null);
  assert.equal(added.length, 1);
  assert.equal(added[0].e164, "+8457231213");
});

test("unparseable synced numbers are skipped without failing the read", async () => {
  const db = fakeDb({ owned: [{ e164: "??" }, { e164: "8457231213" }] });
  const added = await ensureMappingsForOwnedNumbers(db, "tenant-cc", [], null);
  assert.equal(added.length, 1);
  assert.equal(added[0].e164, "+8457231213");
});
