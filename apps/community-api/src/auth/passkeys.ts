import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { requireActor } from "./actor.js";
import { issueSession, clientIp } from "./tokens.js";
import { audit } from "../lib/audit.js";
import { sha256, token } from "../lib/ids.js";

/**
 * WebAuthn passkeys. Challenges live in VerificationCode (purpose LOGIN_OTP,
 * target "passkey:<scope>") so several api instances share them.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;

async function storeChallenge(db: Db, scope: string, challenge: string) {
  await db.verificationCode.updateMany({ where: { target: `passkey:${scope}`, purpose: "LOGIN_OTP", usedAt: null }, data: { usedAt: new Date() } });
  await db.verificationCode.create({
    data: { purpose: "LOGIN_OTP", target: `passkey:${scope}`, codeHash: challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
}

async function takeChallenge(db: Db, scope: string): Promise<string> {
  const row = await db.verificationCode.findFirst({ where: { target: `passkey:${scope}`, purpose: "LOGIN_OTP", usedAt: null }, orderBy: { createdAt: "desc" } });
  if (!row || row.expiresAt < new Date()) throw badRequest("challenge_expired", "That passkey prompt expired. Try again.");
  await db.verificationCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row.codeHash;
}

export function registerPasskeyRoutes(app: FastifyInstance, db: Db) {
  const rpID = () => env().WEBAUTHN_RP_ID;
  const origin = () => env().WEBAUTHN_ORIGIN;

  app.post("/auth/passkeys/register/options", async (req) => {
    const actor = requireActor(req);
    const person = await db.person.findUniqueOrThrow({ where: { id: actor.personId }, include: { passkeys: true, profile: true } });
    const options = await generateRegistrationOptions({
      rpName: "Loopcom Community",
      rpID: rpID(),
      userName: person.email || person.username,
      userDisplayName: person.profile ? `${person.profile.firstName} ${person.profile.lastName}` : person.username,
      attestationType: "none",
      excludeCredentials: person.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as any })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await storeChallenge(db, `reg:${actor.personId}`, options.challenge);
    return options;
  });

  app.post("/auth/passkeys/register/verify", async (req) => {
    const actor = requireActor(req);
    const body = z.object({ response: z.any(), label: z.string().max(60).optional() }).parse(req.body);
    const expectedChallenge = await takeChallenge(db, `reg:${actor.personId}`);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
    }).catch(() => null);
    if (!verification?.verified || !verification.registrationInfo) throw badRequest("passkey_invalid", "That passkey couldn't be verified.");
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const row = await db.passkey.create({
      data: {
        personId: actor.personId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: (credential.transports as string[] | undefined) ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        label: body.label ?? null,
      },
    });
    await audit(db, { actorId: actor.personId, action: "person.passkey_added", targetType: "Passkey", targetId: row.id });
    return { id: row.id, label: row.label, createdAt: row.createdAt };
  });

  app.post("/auth/passkeys/login/options", async (req) => {
    const body = z.object({ identifier: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    let allowCredentials: { id: string; transports?: any }[] | undefined;
    if (body.identifier) {
      const id = body.identifier.toLowerCase();
      const person = await db.person.findFirst({ where: { OR: [{ email: id }, { username: id }] }, include: { passkeys: true } });
      allowCredentials = person?.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as any })) ?? [];
    }
    const options = await generateAuthenticationOptions({ rpID: rpID(), userVerification: "preferred", allowCredentials });
    const scope = token(16);
    await storeChallenge(db, `login:${scope}`, options.challenge);
    return { ...options, scope };
  });

  app.post("/auth/passkeys/login/verify", async (req) => {
    const body = z.object({ scope: z.string().min(8).max(64), response: z.any(), client: z.string().max(30).optional() }).parse(req.body);
    const expectedChallenge = await takeChallenge(db, `login:${body.scope}`);
    const credentialId = String(body.response?.id || body.response?.rawId || "");
    const passkey = await db.passkey.findUnique({ where: { credentialId } });
    if (!passkey) throw unauthorized("That passkey isn't registered here.");
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpID(),
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: Number(passkey.counter), transports: passkey.transports as any },
    }).catch(() => null);
    if (!verification?.verified) throw unauthorized("That passkey couldn't be verified.");
    await db.passkey.update({ where: { id: passkey.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() } });
    const person = await db.person.findUniqueOrThrow({ where: { id: passkey.personId } });
    if (person.status === "BANNED" || person.status === "SUSPENDED") throw unauthorized("This account can't sign in right now.");
    const issued = await issueSession(app, db, person.id, { userAgent: String(req.headers["user-agent"] || ""), ip: clientIp(req), client: body.client ?? "web" });
    await audit(db, { actorId: person.id, action: "person.login", targetType: "Person", targetId: person.id, after: { method: "passkey" } });
    return { ...issued, person: { id: person.id, username: person.username } };
  });

  app.get("/auth/passkeys", async (req) => {
    const actor = requireActor(req);
    const rows = await db.passkey.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "asc" } });
    return { passkeys: rows.map((p) => ({ id: p.id, label: p.label, deviceType: p.deviceType, backedUp: p.backedUp, lastUsedAt: p.lastUsedAt, createdAt: p.createdAt })) };
  });

  app.delete("/auth/passkeys/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.passkey.findFirst({ where: { id, personId: actor.personId } });
    if (!row) throw notFound("That passkey");
    await db.passkey.delete({ where: { id } });
    await audit(db, { actorId: actor.personId, action: "person.passkey_removed", targetType: "Passkey", targetId: id });
    return { ok: true };
  });

  // Keep sha256 referenced for scope hashing callers; challenge values are already opaque.
  void sha256;
}
