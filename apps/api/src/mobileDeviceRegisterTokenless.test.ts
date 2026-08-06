/**
 * The fast push token must not be hostage to the slow one.
 *
 * ⛔ THE BUG (census 2026-08-06: 8 of 16 active Android devices affected)
 * `POST /mobile/devices/register` is the ONLY channel by which a handset can
 * hand us its native FCM token — the Doze-exempt path we use for call wakes.
 * Its schema required `expoPushToken`, and `MobileDevice.expoPushToken` was a
 * NOT NULL unique column that the upsert keyed on. So when Expo token
 * acquisition failed (the app has an explicit "Expo token failed (raw FCM
 * available)" branch), the phone could not register AT ALL — and therefore
 * could never report the perfectly good FCM token it was already holding. It
 * stayed on the deprioritized Expo relay forever.
 *
 * These tests pin the contract, not the transport: the request schema must
 * accept a tokenless-but-identified device, must still reject a device that
 * identifies itself by nothing, and the DB must permit a null Expo token while
 * keeping real ones unique.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/mobileDeviceRegisterTokenless.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Mirrors the register route's identification contract. Kept in sync with
 * apps/api/src/server.ts `POST /mobile/devices/register`.
 */
const identitySchema = z
  .object({
    platform: z.enum(["IOS", "ANDROID"]),
    expoPushToken: z.string().min(8).optional(),
    nativeFcmToken: z.string().max(512).optional(),
    apnsAlertToken: z.string().max(200).optional(),
    deviceId: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.expoPushToken) || Boolean(v.deviceId), {
    message: "expoPushToken or deviceId is required",
    path: ["expoPushToken"],
  });

test("a phone with ONLY a native FCM token can register", () => {
  const parsed = identitySchema.safeParse({
    platform: "ANDROID",
    nativeFcmToken: "fcm-token-abc123",
    deviceId: "mobile-android-mr9epogm-knakpjbh",
  });
  assert.equal(
    parsed.success,
    true,
    "this is the whole point: no Expo token, but a usable fast token + a stable device id",
  );
});

test("the legacy Expo-only shape still registers unchanged", () => {
  const parsed = identitySchema.safeParse({
    platform: "ANDROID",
    expoPushToken: "ExponentPushToken[IyV0P3KOEzFY]",
  });
  assert.equal(parsed.success, true);
});

test("a device that identifies itself by nothing is still rejected", () => {
  const parsed = identitySchema.safeParse({ platform: "ANDROID" });
  assert.equal(
    parsed.success,
    false,
    "without an Expo token the row is keyed on (userId, deviceId) — a register with neither would mint an unaddressable row on every app start",
  );
});

test("a too-short Expo token is still rejected rather than silently ignored", () => {
  const parsed = identitySchema.safeParse({ platform: "ANDROID", expoPushToken: "abc" });
  assert.equal(parsed.success, false);
});

// ── Schema/migration guards ────────────────────────────────────────────────
const REPO = join(__dirname, "..", "..", "..");
const prismaSchema = readFileSync(
  join(REPO, "packages", "db", "prisma", "schema.prisma"),
  "utf8",
);
const mobileDeviceModel = prismaSchema.slice(
  prismaSchema.indexOf("model MobileDevice {"),
  prismaSchema.indexOf("model MobileProvisioningToken {"),
);

test("expoPushToken is nullable but still unique", () => {
  assert.match(
    mobileDeviceModel,
    /expoPushToken\s+String\?\s+@unique/,
    "must be optional (so a tokenless device can register) AND unique (so two devices cannot share one real Expo token — Postgres treats NULLs as distinct)",
  );
});

test("a tokenless device has a natural key to be upserted on", () => {
  assert.match(
    mobileDeviceModel,
    /@@unique\(\[userId, deviceId\]\)/,
    "without this the tokenless branch has no unique key to upsert against",
  );
});

test("the migration drops NOT NULL and adds the natural key", () => {
  const sql = readFileSync(
    join(
      REPO,
      "packages", "db", "prisma", "migrations",
      "20260806020000_mobile_device_optional_expo_token",
      "migration.sql",
    ),
    "utf8",
  );
  assert.match(sql, /ALTER COLUMN "expoPushToken" DROP NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*"userId",\s*"deviceId"/);
});
