import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, fakeLoopcomUsers, fakeOAuth, lastCode, lastResetToken, testApp, uniq } from "../testing/harness.js";
import { totpCode } from "./totp.js";

test("register → verify email → me → refresh → logout (the Tier-1 signup/login path)", async () => {
  const app = await testApp();
  const email = `${uniq("reg")}@example.test`;
  const reg = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "Shloimy", lastName: "Weiss", email, password: "Long-enough-pass-1" } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.person.emailVerified, false);
  assert.match(reg.body.person.username, /^shloimy-weiss/);

  const code = await lastCode(app, email);
  assert.match(code, /^\d{6}$/);
  const wrong = await api(app, { method: "POST", url: "/auth/verify/confirm", token: reg.body.accessToken, payload: { purpose: "email", target: email, code: "000000" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "code_wrong");
  const ok = await api(app, { method: "POST", url: "/auth/verify/confirm", token: reg.body.accessToken, payload: { purpose: "email", target: email, code } });
  assert.equal(ok.status, 200);

  const me = await api(app, { method: "GET", url: "/auth/me", token: reg.body.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.person.emailVerified, true);
  assert.equal(me.body.profile.firstName, "Shloimy");

  const refreshed = await api(app, { method: "POST", url: "/auth/refresh", payload: { refreshToken: reg.body.refreshToken } });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refreshToken, reg.body.refreshToken);
  // The old refresh token still works inside the 30s grace window (racing tabs)…
  const graced = await api(app, { method: "POST", url: "/auth/refresh", payload: { refreshToken: reg.body.refreshToken } });
  assert.equal(graced.status, 200);

  const out = await api(app, { method: "POST", url: "/auth/logout", token: refreshed.body.accessToken });
  assert.equal(out.status, 200);
  const after = await api(app, { method: "GET", url: "/auth/me", token: refreshed.body.accessToken });
  assert.equal(after.status, 401);
  assert.equal(after.body.error, "session_revoked");
});

test("duplicate email, weak password, bad phone are refused with human sentences", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const dupe = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "A", lastName: "B", email: u.email, password: "Long-enough-pass-1" } });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error, "email_taken");
  const weak = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "A", lastName: "B", email: `${uniq()}@example.test`, password: "short" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, "password_weak");
  const phone = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "A", lastName: "B", phone: "12", password: "Long-enough-pass-1" } });
  assert.equal(phone.status, 400);
  assert.equal(phone.body.error, "phone_invalid");
});

test("login by email, wrong password is generic, sessions list + revoke one + logout-all", async () => {
  const app = await testApp();
  const u = await createUser(app, { password: "Correct-horse-battery-9" });
  const bad = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "nope-nope-nope" } });
  assert.equal(bad.status, 401);
  const good = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email.toUpperCase(), password: "Correct-horse-battery-9" } });
  assert.equal(good.status, 200);
  const sessions = await api(app, { method: "GET", url: "/auth/sessions", token: good.body.accessToken });
  assert.equal(sessions.status, 200);
  assert.ok(sessions.body.sessions.length >= 2);
  const other = sessions.body.sessions.find((s: any) => !s.current);
  const rev = await api(app, { method: "DELETE", url: `/auth/sessions/${other.id}`, token: good.body.accessToken });
  assert.equal(rev.status, 200);
  const oldMe = await api(app, { method: "GET", url: "/auth/me", token: u.accessToken });
  assert.equal(oldMe.status, 401);
  const all = await api(app, { method: "POST", url: "/auth/logout-all", token: good.body.accessToken });
  assert.equal(all.status, 200);
});

test("password reset: forgot → token in mailbox → reset → old sessions dead → new login works", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const f = await api(app, { method: "POST", url: "/auth/password/forgot", payload: { identifier: u.email } });
  assert.equal(f.status, 200);
  const tok = await lastResetToken(app, u.email);
  const r = await api(app, { method: "POST", url: "/auth/password/reset", payload: { token: tok, password: "Brand-new-pass-77" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const dead = await api(app, { method: "GET", url: "/auth/me", token: u.accessToken });
  assert.equal(dead.status, 401);
  const again = await api(app, { method: "POST", url: "/auth/password/reset", payload: { token: tok, password: "Brand-new-pass-78" } });
  assert.equal(again.status, 400);
  const login = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "Brand-new-pass-77" } });
  assert.equal(login.status, 200);
  // Unknown identifiers get the same answer.
  const ghost = await api(app, { method: "POST", url: "/auth/password/forgot", payload: { identifier: "nobody@example.test" } });
  assert.equal(ghost.status, 200);
});

test("TOTP two-step: setup → enable → login requires code → disable", async () => {
  const app = await testApp();
  const u = await createUser(app, { password: "Correct-horse-battery-9" });
  const setup = await api(app, { method: "POST", url: "/auth/mfa/totp/setup", token: u.accessToken });
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const en = await api(app, { method: "POST", url: "/auth/mfa/totp/enable", token: u.accessToken, payload: { code: totpCode(setup.body.secret) } });
  assert.equal(en.status, 200);
  const noCode = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "Correct-horse-battery-9" } });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.error, "mfa_required");
  const withCode = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "Correct-horse-battery-9", totp: totpCode(setup.body.secret) } });
  assert.equal(withCode.status, 200);
  const dis = await api(app, { method: "POST", url: "/auth/mfa/totp/disable", token: withCode.body.accessToken, payload: { code: totpCode(setup.body.secret) } });
  assert.equal(dis.status, 200);
});

test("Loopcom SSO creates a linked Loopcom ID once and signs it in every time after; SUPER_ADMIN becomes staff", async () => {
  const app = await testApp();
  const token = uniq("lc-token-");
  const email = `${uniq("lc")}@customer.test`;
  fakeLoopcomUsers.set(token, { userId: uniq("user_"), tenantId: "T35", email, role: "TENANT_ADMIN", firstName: "Chany", lastName: "Weiss", tenantName: "Weiss Embroidery" });
  const first = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.created, true);
  assert.equal(first.body.person.loopcomLinked, true);
  assert.equal(first.body.person.emailVerified, true);
  const second = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token } });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.person.id, first.body.person.id);
  // Registering that email directly is refused and points at Loopcom sign-in.
  const reg = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "X", lastName: "Y", email, password: "Long-enough-pass-1" } });
  assert.equal(reg.status, 409);
  assert.equal(reg.body.error, "email_is_loopcom_account");
  const bad = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token: "not-a-real-token-at-all" } });
  assert.equal(bad.status, 401);

  const adminTok = uniq("lc-admin-");
  fakeLoopcomUsers.set(adminTok, { userId: uniq("su_"), tenantId: "global", email: `${uniq("su")}@loopcom.net`, role: "SUPER_ADMIN" });
  const su = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token: adminTok } });
  const me = await api(app, { method: "GET", url: "/auth/me", token: su.body.accessToken });
  assert.equal(me.body.staffRole, "ADMIN");
});

test("Google sign-in creates on first use and links to an existing verified email on later use", async () => {
  const app = await testApp();
  const existing = await createUser(app);
  const t1 = uniq("g1-");
  fakeOAuth.set(t1, { provider: "google", subject: uniq("sub"), email: existing.email, emailVerified: true, firstName: "Any", lastName: "One" });
  const r1 = await api(app, { method: "POST", url: "/auth/oauth/google", payload: { idToken: t1 } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.person.id, existing.personId);
  const t2 = uniq("g2-");
  fakeOAuth.set(t2, { provider: "google", subject: uniq("sub"), email: `${uniq("gnew")}@gmail.test`, emailVerified: true, firstName: "Gita", lastName: "Newman" });
  const r2 = await api(app, { method: "POST", url: "/auth/oauth/google", payload: { idToken: t2 } });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.created, true);
  const bad = await api(app, { method: "POST", url: "/auth/oauth/google", payload: { idToken: "garbage-token-xx" } });
  assert.equal(bad.status, 401);
});

test("deactivate hides and a login reactivates; delete schedules a 14-day purge and export returns the person's data", async () => {
  const app = await testApp();
  const u = await createUser(app, { password: "Correct-horse-battery-9" });
  const d = await api(app, { method: "POST", url: "/auth/deactivate", token: u.accessToken });
  assert.equal(d.status, 200);
  const login = await api(app, { method: "POST", url: "/auth/login", payload: { identifier: u.email, password: "Correct-horse-battery-9" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.person.status, "ACTIVE");
  const exp = await api(app, { method: "GET", url: "/auth/export", token: login.body.accessToken });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.person.email, u.email);
  assert.equal(exp.body.person.passwordHash, undefined);
  const del = await api(app, { method: "POST", url: "/auth/delete", token: login.body.accessToken, payload: { confirm: "DELETE", password: "Correct-horse-battery-9" } });
  assert.equal(del.status, 200);
  assert.ok(new Date(del.body.deleteAfter).getTime() > Date.now() + 13 * 86_400_000);
});

test("unauthenticated requests to protected routes are 401; health is public", async () => {
  const app = await testApp();
  const h = await api(app, { method: "GET", url: "/health" });
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  const me = await api(app, { method: "GET", url: "/auth/me" });
  assert.equal(me.status, 401);
  const bogus = await api(app, { method: "GET", url: "/auth/me", token: "abc.def.ghi" });
  assert.equal(bogus.status, 401);
});
