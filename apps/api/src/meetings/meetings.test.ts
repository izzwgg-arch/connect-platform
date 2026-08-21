/**
 * Loopcom Meetings — token shape, config guard, and the join/host routes
 * driven through a real Fastify against a fake db.
 *
 * ⛔ The route tests exist because every defect of this repo's shape lives in
 * the CALLER: a unit test of buildLiveKitJwt alone would pass straight through
 * a join route that hands a guest roomAdmin or lets a locked meeting through.
 */
import assert from "node:assert";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  buildGuestIdentity,
  buildLiveKitJwt,
  buildMeetingCode,
  getLiveKitConfig,
  isValidMeetingCode,
  liveKitRoomForMeeting,
  roomServiceRequest,
  sanitizeDisplayName,
} from "./livekit";
import { registerMeetingRoutes, MEETINGS_PUBLIC_WS_PATH } from "./meetingRoutes";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

const CFG = { url: "http://livekit:7880", apiKey: "LKtestkey", apiSecret: "secret-for-tests-0123456789" };

function decodeJwt(token: string): { header: any; payload: any; signed: string; sig: string } {
  const [h, p, s] = token.split(".");
  const un = (x: string) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return { header: JSON.parse(un(h)), payload: JSON.parse(un(p)), signed: `${h}.${p}`, sig: s };
}

test("buildLiveKitJwt: HS256, correct claims, verifiable signature", () => {
  const token = buildLiveKitJwt({
    config: CFG,
    identity: "user-abc",
    name: "Chaim Landau",
    ttlSeconds: 3600,
    grant: { room: "meet-x1", roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    nowMs: 1_700_000_000_000,
  });
  const { header, payload, signed, sig } = decodeJwt(token);
  assert.equal(header.alg, "HS256");
  assert.equal(payload.iss, "LKtestkey");
  assert.equal(payload.sub, "user-abc");
  assert.equal(payload.name, "Chaim Landau");
  assert.equal(payload.video.room, "meet-x1");
  assert.equal(payload.video.roomJoin, true);
  assert.equal(payload.video.roomAdmin, undefined, "participant tokens never carry roomAdmin");
  assert.equal(payload.exp, 1_700_000_000 + 3600);
  assert.equal(payload.nbf, 1_700_000_000 - 10);
  const expected = createHmac("sha256", CFG.apiSecret)
    .update(signed)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(sig, expected, "signature must verify against the api secret");
});

test("getLiveKitConfig: blank-after-trim reads as unset; trailing slash trimmed", () => {
  assert.equal(getLiveKitConfig({} as any), null);
  assert.equal(getLiveKitConfig({ LIVEKIT_URL: "http://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "  " } as any), null);
  assert.equal(getLiveKitConfig({ LIVEKIT_URL: " ", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" } as any), null);
  const cfg = getLiveKitConfig({ LIVEKIT_URL: "http://livekit:7880/", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" } as any);
  assert.deepEqual(cfg, { url: "http://livekit:7880", apiKey: "k", apiSecret: "s" });
});

test("meeting codes: format, validity, guest identities", () => {
  for (let i = 0; i < 20; i++) {
    const code = buildMeetingCode();
    assert.ok(isValidMeetingCode(code), `generated code must validate: ${code}`);
    assert.ok(!/[ilo01]/.test(code), `no confusable characters: ${code}`);
  }
  assert.equal(isValidMeetingCode("abc-defg-hij"), true);
  assert.equal(isValidMeetingCode("ABC-DEFG-HIJ"), false, "codes are lowercase; routes lowercase before checking");
  assert.equal(isValidMeetingCode("abc-defg"), false);
  assert.equal(isValidMeetingCode(""), false);
  assert.ok(buildGuestIdentity().startsWith("guest-"));
  assert.notEqual(buildGuestIdentity(), buildGuestIdentity());
});

test("sanitizeDisplayName: control chars stripped, length bounded, emptiness refused", () => {
  assert.equal(sanitizeDisplayName("  Rivky\u0000 Gold\u001f  "), "Rivky Gold");
  assert.equal(sanitizeDisplayName("x".repeat(200))!.length, 60);
  assert.equal(sanitizeDisplayName("   "), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName("Mrs. Halpert"), "Mrs. Halpert");
});

test("JWT bypass: only /meetings/public/* is open", () => {
  assert.equal(shouldSkipJwtVerification("/meetings/public/abc-defg-hij/info"), true);
  assert.equal(shouldSkipJwtVerification("/meetings/public/abc-defg-hij/join"), true);
  assert.equal(shouldSkipJwtVerification("/api/meetings/public/abc-defg-hij/join"), true);
  assert.equal(shouldSkipJwtVerification("/meetings"), false, "creating a meeting needs a session");
  assert.equal(shouldSkipJwtVerification("/meetings/abc-defg-hij/join"), false, "signed-in join needs a session");
  assert.equal(shouldSkipJwtVerification("/meetings/abc-defg-hij/host/remove"), false, "host controls need a session");
  assert.equal(shouldSkipJwtVerification("/x/meetings/public/abc/info"), false, "anchored to the path start");
});

test("RoomService admin token carries roomAdmin AND roomCreate (DeleteRoom 401s without roomCreate — seen live)", async () => {
  let auth = "";
  await roomServiceRequest(CFG as any, "DeleteRoom", { room: "meet-x" }, (async (_url: any, init: any) => {
    auth = init.headers.authorization;
    return { ok: true, status: 200, text: async () => "{}" };
  }) as any);
  const { payload } = decodeJwt(auth.replace("Bearer ", ""));
  assert.equal(payload.video.roomAdmin, true);
  assert.equal(payload.video.roomCreate, true, "DeleteRoom requires the roomCreate grant");
});

// ── Route tests against a fake db ──────────────────────────────────────────

function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    videoMeeting: {
      findUnique: async ({ where }: any) => rows.find((r) => r.code === where.code || r.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        rows.filter((r) => r.tenantId === where.tenantId && r.createdByUserId === where.createdByUserId),
      create: async ({ data }: any) => {
        if (rows.some((r) => r.code === data.code)) {
          const err: any = new Error("unique");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `m${rows.length + 1}`, locked: false, createdAt: new Date(), endedAt: null, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

async function buildApp(opts: { user?: any; configured?: boolean; roomCalls?: any[] } = {}) {
  const app = Fastify();
  const db = fakeDb();
  app.addHook("preHandler", async (req) => {
    (req as any).user = opts.user ?? { sub: "u1", tenantId: "t1", email: "a@b.c", role: "SUPER_ADMIN" };
  });
  registerMeetingRoutes(app, {
    db,
    config: () => (opts.configured === false ? null : (CFG as any)),
    roomService: (async (_cfg: any, method: string, body: any) => {
      opts.roomCalls?.push({ method, body });
      return { ok: true, status: 200, body: "{}" };
    }) as any,
  });
  return { app, db };
}

test("create → guest join round trip; guest is never host", async () => {
  const { app } = await buildApp();
  const created = await app.inject({ method: "POST", url: "/meetings", payload: { title: "Team check-in" } });
  assert.equal(created.statusCode, 200);
  const meeting = created.json();
  assert.ok(isValidMeetingCode(meeting.code));
  assert.equal(meeting.joinPath, `/meet/${meeting.code}`);

  const join = await app.inject({
    method: "POST",
    url: `/meetings/public/${meeting.code}/join`,
    payload: { displayName: "Ezra L." },
  });
  assert.equal(join.statusCode, 200);
  const body = join.json();
  assert.ok(body.identity.startsWith("guest-"));
  assert.equal(body.isHost, false);
  assert.equal(body.wsPath, MEETINGS_PUBLIC_WS_PATH);
  const { payload } = decodeJwt(body.token);
  assert.equal(payload.video.roomAdmin, undefined, "guest token must not carry roomAdmin");
  assert.equal(payload.video.roomCreate, undefined, "guest token must not carry roomCreate");
  assert.equal(payload.video.room, liveKitRoomForMeeting(meeting.id));
  assert.equal(payload.name, "Ezra L.");
  await app.close();
});

test("guest join: nameless 400, unknown code 404, locked 403, ended 410", async () => {
  const { app, db } = await buildApp();
  const meeting = (await app.inject({ method: "POST", url: "/meetings", payload: {} })).json();

  const noName = await app.inject({ method: "POST", url: `/meetings/public/${meeting.code}/join`, payload: {} });
  assert.equal(noName.statusCode, 400);
  assert.equal(noName.json().error, "name_required");

  const unknown = await app.inject({ method: "POST", url: "/meetings/public/zzz-zzzz-zzz/join", payload: { displayName: "X" } });
  assert.equal(unknown.statusCode, 404);

  db.rows[0].locked = true;
  const locked = await app.inject({ method: "POST", url: `/meetings/public/${meeting.code}/join`, payload: { displayName: "X" } });
  assert.equal(locked.statusCode, 403);
  assert.equal(locked.json().error, "meeting_locked");

  db.rows[0].locked = false;
  db.rows[0].endedAt = new Date();
  const ended = await app.inject({ method: "POST", url: `/meetings/public/${meeting.code}/join`, payload: { displayName: "X" } });
  assert.equal(ended.statusCode, 410);
  assert.equal(ended.json().error, "meeting_ended");
  await app.close();
});

test("signed-in join: creator is host and enters even when locked; others are refused when locked", async () => {
  const creator = { sub: "u1", tenantId: "t1", email: "a@b.c", role: "SUPER_ADMIN" };
  const { app, db } = await buildApp({ user: creator });
  const meeting = (await app.inject({ method: "POST", url: "/meetings", payload: {} })).json();
  db.rows[0].locked = true;

  const hostJoin = await app.inject({ method: "POST", url: `/meetings/${meeting.code}/join`, payload: { displayName: "Chaim" } });
  assert.equal(hostJoin.statusCode, 200);
  assert.equal(hostJoin.json().isHost, true);
  await app.close();

  // A different signed-in user against the same locked meeting.
  const other = Fastify();
  other.addHook("preHandler", async (req) => {
    (req as any).user = { sub: "u2", tenantId: "t1", email: "x@b.c", role: "USER" };
  });
  registerMeetingRoutes(other, { db, config: () => CFG as any });
  const refused = await other.inject({ method: "POST", url: `/meetings/${meeting.code}/join`, payload: { displayName: "Y" } });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, "meeting_locked");
  await other.close();
});

test("host controls: non-creator 403; end calls DeleteRoom; mute forwards track", async () => {
  const roomCalls: any[] = [];
  const { app, db } = await buildApp({ roomCalls });
  const meeting = (await app.inject({ method: "POST", url: "/meetings", payload: {} })).json();

  const mute = await app.inject({
    method: "POST",
    url: `/meetings/${meeting.code}/host/mute`,
    payload: { identity: "guest-abc", trackSid: "TR_123" },
  });
  assert.equal(mute.statusCode, 200);
  assert.deepEqual(roomCalls[0], {
    method: "MutePublishedTrack",
    body: { room: liveKitRoomForMeeting(meeting.id), identity: "guest-abc", track_sid: "TR_123", muted: true },
  });

  const end = await app.inject({ method: "POST", url: `/meetings/${meeting.code}/end` });
  assert.equal(end.statusCode, 200);
  assert.equal(roomCalls[1].method, "DeleteRoom");
  assert.ok(db.rows[0].endedAt instanceof Date);

  // A different user may not moderate.
  const other = Fastify();
  other.addHook("preHandler", async (req) => {
    (req as any).user = { sub: "intruder", tenantId: "t1", email: "x@b.c", role: "USER" };
  });
  registerMeetingRoutes(other, { db, config: () => CFG as any });
  const refused = await other.inject({ method: "POST", url: `/meetings/${meeting.code}/lock`, payload: { locked: true } });
  assert.equal(refused.statusCode, 403);
  await other.close();
  await app.close();
});

test("only SUPER_ADMIN may start or list meetings (Izzy-only, 2026-08-21)", async () => {
  const { app } = await buildApp({ user: { sub: "u9", tenantId: "t1", email: "staff@x.c", role: "TENANT_ADMIN" } });
  const create = await app.inject({ method: "POST", url: "/meetings", payload: { title: "nope" } });
  assert.equal(create.statusCode, 403);
  assert.equal(create.json().error, "forbidden");
  assert.ok(!/_/.test(create.json().message), "refusal must be plain English, not a slug");
  const list = await app.inject({ method: "GET", url: "/meetings" });
  assert.equal(list.statusCode, 403);
  await app.close();

  const admin = await buildApp({ user: { sub: "izzy", tenantId: "t1", email: "i@x.c", role: "SUPER_ADMIN" } });
  const ok = await admin.app.inject({ method: "POST", url: "/meetings", payload: { title: "yes" } });
  assert.equal(ok.statusCode, 200);
  await admin.app.close();
});

// ⛔ The negative that matters MOST: restricting who may START a meeting must
// never restrict who may JOIN one. A guest has no account, and an ordinary
// colleague opening a link must get in — gating these would make the whole
// feature pointless.
test("restricting creation does NOT restrict joining — guests and ordinary users still get in", async () => {
  const admin = await buildApp({ user: { sub: "izzy", tenantId: "t1", email: "i@x.c", role: "SUPER_ADMIN" } });
  const meeting = (await admin.app.inject({ method: "POST", url: "/meetings", payload: {} })).json();

  const guest = await admin.app.inject({
    method: "POST",
    url: `/meetings/public/${meeting.code}/join`,
    payload: { displayName: "Guest" },
  });
  assert.equal(guest.statusCode, 200, "a guest with the link must still join");
  assert.equal(guest.json().isHost, false);

  const info = await admin.app.inject({ method: "GET", url: `/meetings/public/${meeting.code}/info` });
  assert.equal(info.statusCode, 200, "the public info route stays open");
  await admin.app.close();

  const staff = Fastify();
  staff.addHook("preHandler", async (req) => {
    (req as any).user = { sub: "u9", tenantId: "t1", email: "staff@x.c", role: "USER" };
  });
  registerMeetingRoutes(staff, { db: admin.db, config: () => CFG as any });
  const joined = await staff.inject({ method: "POST", url: `/meetings/${meeting.code}/join`, payload: { displayName: "Colleague" } });
  assert.equal(joined.statusCode, 200, "an ordinary signed-in user must still join by link");
  assert.equal(joined.json().isHost, false, "but never as host");
  await staff.close();
});

test("unconfigured server: joins and creation answer 503 in plain English; info still works", async () => {
  const { app, db } = await buildApp({ configured: false, user: { sub: "izzy", tenantId: "t1", email: "i@x.c", role: "SUPER_ADMIN" } });
  const create = await app.inject({ method: "POST", url: "/meetings", payload: {} });
  assert.equal(create.statusCode, 503);
  assert.equal(create.json().error, "meetings_not_configured");

  db.rows.push({ id: "m1", code: "abc-defg-hij", tenantId: "t1", createdByUserId: "u1", title: "T", locked: false, createdAt: new Date(), endedAt: null });
  const info = await app.inject({ method: "GET", url: "/meetings/public/abc-defg-hij/info" });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().exists, true);
  const join = await app.inject({ method: "POST", url: "/meetings/public/abc-defg-hij/join", payload: { displayName: "X" } });
  assert.equal(join.statusCode, 503);
  await app.close();
});

// ── Source guard: the module must actually be registered in server.ts.
// The defect shape this guards is the whole feature shipping unreachable
// (routes written, never wired — the two-IVR-publish-paths family).
test("server.ts registers registerMeetingRoutes", () => {
  const src = readFileSync(path.join(__dirname, "..", "server.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes('from "./meetings/meetingRoutes"'), "server.ts must import the meetings module");
  assert.ok(/registerMeetingRoutes\(app/.test(src), "server.ts must call registerMeetingRoutes(app…)");
});
