import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app.js";
import { db as getDb, type Db } from "../db.js";
import type { LoopcomIdentity } from "../auth/loopcomSso.js";
import type { OAuthIdentity } from "../auth/oauth.js";

/**
 * Integration harness: a real Fastify app against the REAL local database
 * (COMMUNITY_DATABASE_URL), with the two external verifiers faked. Every test
 * creates its own people with unique emails, so tests can run in parallel and
 * never depend on a clean database.
 */
process.env.COMMUNITY_TEST_HOOKS ??= "1";
process.env.COMMUNITY_MAIL_MODE ??= "mailbox";
process.env.COMMUNITY_SCHEDULERS = "0";
process.env.COMMUNITY_RATE_LIMIT_OFF = "1";

export const fakeLoopcomUsers = new Map<string, LoopcomIdentity>();
export const fakeOAuth = new Map<string, OAuthIdentity>();

let appPromise: Promise<FastifyInstance> | null = null;

export function testApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp({
    logger: false,
    auth: {
      loopcomVerifier: async (token) => fakeLoopcomUsers.get(token) ?? null,
      oauthVerifier: async (_provider, idToken) => fakeOAuth.get(idToken) ?? null,
    },
  });
  return appPromise;
}

export const tdb = (): Db => getDb();

let seq = 0;
export function uniq(prefix = "t") {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

export type TestUser = {
  personId: string;
  username: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  headers: Record<string, string>;
  firstName: string;
  lastName: string;
};

export async function api(app: FastifyInstance, opts: InjectOptions & { token?: string }) {
  const { token, ...rest } = opts;
  const res = await app.inject({
    ...rest,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers as any) },
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers, raw: res };
}

/** Registers + email-verifies a person. */
export async function createUser(app: FastifyInstance, overrides: Partial<{ firstName: string; lastName: string; email: string; password: string; verify: boolean; headline: string }> = {}): Promise<TestUser> {
  const firstName = overrides.firstName ?? "Test";
  const lastName = overrides.lastName ?? uniq("User");
  const email = overrides.email ?? `${uniq("u")}@example.test`;
  const password = overrides.password ?? "Str0ng-Passw0rd-!!";
  const reg = await api(app, { method: "POST", url: "/auth/register", payload: { firstName, lastName, email, password } });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const headers = { authorization: `Bearer ${reg.body.accessToken}` };
  if (overrides.verify !== false) {
    const code = await lastCode(app, email);
    const c = await api(app, { method: "POST", url: "/auth/verify/confirm", token: reg.body.accessToken, payload: { purpose: "email", target: email, code } });
    if (c.status !== 200) throw new Error(`verify failed: ${JSON.stringify(c.body)}`);
  }
  if (overrides.headline) {
    await api(app, { method: "PATCH", url: "/me/profile", token: reg.body.accessToken, payload: { headline: overrides.headline } });
  }
  return { personId: reg.body.person.id, username: reg.body.person.username, email, accessToken: reg.body.accessToken, refreshToken: reg.body.refreshToken, headers, firstName, lastName };
}

export async function lastCode(app: FastifyInstance, target: string): Promise<string> {
  const r = await api(app, { method: "GET", url: `/dev/last-code?target=${encodeURIComponent(target)}` });
  if (!r.body?.code) throw new Error(`no code for ${target}: ${JSON.stringify(r.body)}`);
  return r.body.code;
}

export async function lastResetToken(app: FastifyInstance, target: string): Promise<string> {
  const r = await api(app, { method: "GET", url: `/dev/last-code?target=${encodeURIComponent(target)}` });
  if (!r.body?.resetToken) throw new Error(`no reset token for ${target}`);
  return r.body.resetToken;
}

export async function connectUsers(app: FastifyInstance, a: TestUser, b: TestUser) {
  const r = await api(app, { method: "POST", url: `/connections/request`, token: a.accessToken, payload: { personId: b.personId } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`connect request failed ${r.status} ${JSON.stringify(r.body)}`);
  const acc = await api(app, { method: "POST", url: `/connections/${r.body.id}/accept`, token: b.accessToken });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return acc.body;
}

export async function createOrg(app: FastifyInstance, owner: TestUser, name = uniq("Org ")) {
  const r = await api(app, { method: "POST", url: "/organizations", token: owner.accessToken, payload: { displayName: name, industry: "Apparel & uniforms" } });
  if (r.status !== 201) throw new Error(`org create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; slug: string; displayName: string };
}

export async function grantStaff(personId: string, role = "ADMIN") {
  await tdb().staffGrant.upsert({ where: { personId }, create: { personId, role }, update: { role } });
}
