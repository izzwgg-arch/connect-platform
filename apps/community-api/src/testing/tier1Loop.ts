/**
 * Tier-1 repeatability loop (brief §49): runs every critical flow N times in a
 * row against a RUNNING api (COMMUNITY_API_URL, default http://localhost:3101)
 * with COMMUNITY_TEST_HOOKS=1 and COMMUNITY_RATE_LIMIT_OFF=1 (hundreds of signups from one IP), over real HTTP. Any single failure is reported
 * with the iteration and the step; the process exits 1. No retries, ever.
 *
 *   pnpm --filter @loopcom/community-api test:tier1            # 20 iterations
 *   TIER1_ITERATIONS=50 pnpm --filter @loopcom/community-api test:tier1
 */
import "dotenv/config";

const BASE = (process.env.COMMUNITY_API_URL || "http://localhost:3101").replace(/\/$/, "");
const N = Number(process.env.TIER1_ITERATIONS || 20);

type Res = { status: number; body: any };
async function call(path: string, opts: { method?: string; body?: unknown; token?: string; idem?: string } = {}): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idem ? { "idempotency-key": opts.idem } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function expect(cond: boolean, step: string, r?: Res) {
  if (!cond) throw new Error(`${step}${r ? ` → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}` : ""}`);
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function code(target: string): Promise<string> {
  const r = await call(`/dev/last-code?target=${encodeURIComponent(target)}`);
  expect(!!r.body?.code, "read verification code", r);
  return r.body.code;
}

async function makeUser(tag: string) {
  const email = `t1-${tag}-${uid()}@example.test`;
  const password = "Blue-anchor-marble-99";
  const reg = await call("/auth/register", { body: { firstName: "Tier", lastName: `One${tag}`, email, password } });
  expect(reg.status === 201, "signup", reg);
  const c = await call("/auth/verify/confirm", { token: reg.body.accessToken, body: { purpose: "email", target: email, code: await code(email) } });
  expect(c.status === 200, "verify email", c);
  return { email, password, token: reg.body.accessToken as string, refresh: reg.body.refreshToken as string, id: reg.body.person.id as string, username: reg.body.person.username as string };
}

/** Each flow returns nothing or throws. Flows are independent and create their own data. */
const flows: Record<string, () => Promise<void>> = {
  async "signup+login+logout"() {
    const u = await makeUser("a");
    const login = await call("/auth/login", { body: { identifier: u.email, password: u.password } });
    expect(login.status === 200, "login", login);
    const me = await call("/auth/me", { token: login.body.accessToken });
    expect(me.status === 200 && me.body.person.emailVerified === true, "me after login", me);
    const out = await call("/auth/logout", { method: "POST", token: login.body.accessToken });
    expect(out.status === 200, "logout", out);
    const dead = await call("/auth/me", { token: login.body.accessToken });
    expect(dead.status === 401, "session dead after logout", dead);
  },
  async "password reset"() {
    const u = await makeUser("r");
    const f = await call("/auth/password/forgot", { body: { identifier: u.email } });
    expect(f.status === 200, "forgot", f);
    const r = await call(`/dev/last-code?target=${encodeURIComponent(u.email)}`);
    expect(!!r.body?.resetToken, "reset token in mailbox", r);
    const reset = await call("/auth/password/reset", { body: { token: r.body.resetToken, password: "New-tier1-pass-77" } });
    expect(reset.status === 200, "reset", reset);
    const login = await call("/auth/login", { body: { identifier: u.email, password: "New-tier1-pass-77" } });
    expect(login.status === 200, "login with new password", login);
  },
  async "profile create+edit"() {
    const u = await makeUser("p");
    const patch = await call("/me/profile", { method: "PATCH", token: u.token, body: { headline: "Owner, Tier One Embroidery", industry: "Apparel & uniforms", location: "Monroe, NY", skills: ["embroidery"] } });
    expect(patch.status === 200, "patch profile", patch);
    const pub = await call(`/public/people/${u.username}`);
    expect(pub.status === 200 && pub.body.profile?.headline === "Owner, Tier One Embroidery", "public profile shows headline", pub);
  },
  async "privacy change"() {
    const u = await makeUser("v");
    const put = await call("/me/privacy", { method: "PUT", token: u.token, body: { phone: "PRIVATE", experience: "CONNECTIONS" } });
    expect(put.status === 200, "put privacy", put);
    const get = await call("/me/privacy", { token: u.token });
    expect(get.body.settings.phone === "PRIVATE" && get.body.settings.experience === "CONNECTIONS", "privacy persisted", get);
  },
  async "company create+invite"() {
    const owner = await makeUser("o");
    const member = await makeUser("m");
    const org = await call("/organizations", { token: owner.token, body: { displayName: `Tier One Co ${uid()}`, industry: "Apparel & uniforms" } });
    expect(org.status === 201, "create org", org);
    const inv = await call(`/organizations/${org.body.id}/invites`, { token: owner.token, body: { email: member.email, role: "EMPLOYEE" }, idem: uid() });
    expect(inv.status === 201 || inv.status === 200, "invite", inv);
    const tok = await call(`/dev/last-code?target=${encodeURIComponent(member.email)}`);
    const invToken = tok.body?.resetToken;
    expect(!!invToken, "invite token in mailbox", tok);
    const acc = await call("/organizations/invites/accept", { token: member.token, body: { token: invToken } });
    expect(acc.status === 200, "accept invite", acc);
  },
  async "connection request+accept"() {
    const a = await makeUser("c1");
    const b = await makeUser("c2");
    const req = await call("/connections/request", { token: a.token, body: { personId: b.id }, idem: uid() });
    expect(req.status === 201, "request", req);
    const acc = await call(`/connections/${req.body.id}/accept`, { method: "POST", token: b.token });
    expect(acc.status === 200, "accept", acc);
    const dup = await call("/connections/request", { token: a.token, body: { personId: b.id } });
    expect(dup.status === 409, "duplicate accepted connection impossible", dup);
  },
  async "follow+unfollow"() {
    const a = await makeUser("f1");
    const b = await makeUser("f2");
    const f = await call(`/people/${b.id}/follow`, { method: "POST", token: a.token });
    expect(f.status === 200 || f.status === 201, "follow", f);
    const un = await call(`/people/${b.id}/follow`, { method: "DELETE", token: a.token });
    expect(un.status === 200, "unfollow", un);
  },
  async "post create+edit+delete+react+comment"() {
    const a = await makeUser("po");
    const b = await makeUser("pb");
    const post = await call("/posts", { token: a.token, body: { kind: "TEXT", body: `Tier-1 post ${uid()}`, visibility: "PUBLIC" } });
    expect(post.status === 201, "create post", post);
    const id = post.body.post?.id ?? post.body.id;
    const edit = await call(`/posts/${id}`, { method: "PATCH", token: a.token, body: { body: "Edited body" } });
    expect(edit.status === 200, "edit post", edit);
    const react = await call(`/posts/${id}/react`, { token: b.token, body: { kind: "LIKE" } });
    expect(react.status === 200 || react.status === 201, "react", react);
    const comment = await call(`/posts/${id}/comments`, { token: b.token, body: { body: "Nice" } });
    expect(comment.status === 201, "comment", comment);
    const del = await call(`/posts/${id}`, { method: "DELETE", token: a.token });
    expect(del.status === 200, "delete post", del);
  },
  async "messaging"() {
    const a = await makeUser("m1");
    const b = await makeUser("m2");
    const req = await call("/connections/request", { token: a.token, body: { personId: b.id } });
    await call(`/connections/${req.body.id}/accept`, { method: "POST", token: b.token });
    const t = await call("/threads", { token: a.token, body: { personIds: [b.id] } });
    expect(t.status === 201 || t.status === 200, "thread", t);
    const tid = t.body.thread?.id ?? t.body.id;
    const m = await call(`/threads/${tid}/messages`, { token: a.token, body: { kind: "TEXT", body: "hello" } });
    expect(m.status === 201, "send message", m);
    const list = await call(`/threads/${tid}/messages`, { token: b.token });
    expect(list.status === 200 && Array.isArray(list.body.items ?? list.body.messages), "recipient reads", list);
  },
  async "search"() {
    const u = await makeUser("s");
    const r = await call(`/search?q=tier&type=people`, { token: u.token });
    expect(r.status === 200, "search", r);
  },
  async "job create+apply"() {
    const emp = await makeUser("e");
    const cand = await makeUser("k");
    const org = await call("/organizations", { token: emp.token, body: { displayName: `Hiring Co ${uid()}` } });
    const job = await call("/jobs", { token: emp.token, body: { organizationId: org.body.id, title: "Office manager", description: "Run the office", location: "Brooklyn, NY" } });
    expect(job.status === 201, "create job", job);
    const jid = job.body.job?.id ?? job.body.id;
    const app = await call(`/jobs/${jid}/apply`, { token: cand.token, body: { sections: ["headline"], coverNote: "Hi" }, idem: uid() });
    expect(app.status === 201, "apply", app);
  },
  async "rfq create+quote+accept"() {
    const buyer = await makeUser("b");
    const vendor = await makeUser("v");
    const org = await call("/organizations", { token: vendor.token, body: { displayName: `Vendor Co ${uid()}` } });
    const rfq = await call("/rfq", { token: buyer.token, body: { title: "25 embroidered jackets", description: "Navy softshell, logo left chest, delivered to Monroe by Oct 20", quantity: "25", location: "Monroe, NY", inviteOrganizationIds: [org.body.id] }, idem: uid() });
    expect(rfq.status === 201, "create rfq", rfq);
    const rid = rfq.body.rfq?.id ?? rfq.body.id;
    const q = await call(`/rfq/${rid}/quotes`, { token: vendor.token, body: { organizationId: org.body.id, total: 1875, notes: "Sample in 3 days" }, idem: uid() });
    expect(q.status === 201, "quote", q);
    const qid = q.body.quote?.id ?? q.body.id;
    const acc = await call(`/rfq/${rid}/quotes/${qid}/accept`, { method: "POST", token: buyer.token, idem: uid() });
    expect(acc.status === 200, "accept quote", acc);
    const again = await call(`/rfq/${rid}/quotes/${qid}/accept`, { method: "POST", token: buyer.token, idem: uid() });
    expect(again.status === 409 || again.status === 400, "second accept is refused, never a second acceptance", again);
    const after = await call(`/rfq/${rid}`, { token: buyer.token });
    expect(after.status === 200 && after.body.rfq?.status === "ACCEPTED" || after.body.status === "ACCEPTED", "rfq accepted once", after);
  },
  async "opportunity create"() {
    const u = await makeUser("op");
    const types = await call("/opportunities/types", { token: u.token });
    expect(types.status === 200 && (types.body.types?.length ?? 0) > 0, "types", types);
    const t = types.body.types.find((x: any) => x.slug === "partnerships") ?? types.body.types[0];
    // Fill every required field from the type's own schema — the schema is data, so the loop reads it.
    const fields: Record<string, unknown> = {};
    for (const f of t.fieldSchema?.fields ?? t.fieldSchema ?? []) {
      if (!f.required) continue;
      fields[f.key] = f.type === "number" || f.type === "money" ? 1000 : f.type === "date" ? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) : f.type === "select" ? f.options?.[0] : f.type === "multiselect" ? [f.options?.[0]].filter(Boolean) : f.type === "boolean" ? true : "Uniform program partner";
    }
    const r = await call("/opportunities", { token: u.token, body: { typeSlug: t.slug, title: "Partner wanted", description: "Uniform program partner", location: "Monroe, NY", fields } });
    expect(r.status === 201, "create opportunity", r);
  },
  async "event rsvp"() {
    const host = await makeUser("h");
    const guest = await makeUser("g");
    const ev = await call("/events", { token: host.token, body: { title: `Breakfast ${uid()}`, mode: "IN_PERSON", startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString(), venue: "Atrium Hall" } });
    expect(ev.status === 201, "create event", ev);
    const eid = ev.body.event?.id ?? ev.body.id;
    const r = await call(`/events/${eid}/rsvp`, { token: guest.token, body: { status: "GOING" } });
    expect(r.status === 200 || r.status === 201, "rsvp", r);
  },
  async "group join"() {
    const owner = await makeUser("go");
    const member = await makeUser("gm");
    const g = await call("/groups", { token: owner.token, body: { name: `Wholesale ${uid()}`, isPrivate: false } });
    expect(g.status === 201, "create group", g);
    const gid = g.body.group?.id ?? g.body.id;
    const j = await call(`/groups/${gid}/join`, { method: "POST", token: member.token });
    expect(j.status === 200 || j.status === 201, "join", j);
  },
  async "media upload"() {
    const u = await makeUser("mu");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const boundary = `----t1${uid()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${BASE}/media`, { method: "POST", headers: { authorization: `Bearer ${u.token}`, "content-type": `multipart/form-data; boundary=${boundary}` }, body });
    expect(res.status === 201, `upload → ${res.status} ${await res.text()}`);
  },
  async "report+block"() {
    const a = await makeUser("rb1");
    const b = await makeUser("rb2");
    const rep = await call("/reports", { token: a.token, body: { targetType: "person", targetId: b.id, reason: "SPAM", details: "test" } });
    expect(rep.status === 201 || rep.status === 200, "report", rep);
    const blk = await call(`/people/${b.id}/block`, { method: "POST", token: a.token });
    expect(blk.status === 200 || blk.status === 201, "block", blk);
    const prof = await call(`/public/people/${a.username}`, { token: b.token });
    expect(prof.status === 404, "blocked person cannot see profile", prof);
  },
};

async function main() {
  const health = await call("/health");
  if (health.status !== 200) {
    console.error(`api not reachable at ${BASE} (${health.status})`);
    process.exit(2);
  }
  const only = process.env.TIER1_ONLY ? process.env.TIER1_ONLY.split(",") : Object.keys(flows);
  const results: Record<string, { ok: number; fail: { iteration: number; error: string } | null; ms: number[] }> = {};
  let anyFail = false;
  for (const name of only) {
    const flow = flows[name];
    if (!flow) continue;
    results[name] = { ok: 0, fail: null, ms: [] };
    for (let i = 1; i <= N; i++) {
      const t0 = Date.now();
      try {
        await flow();
        results[name].ok += 1;
        results[name].ms.push(Date.now() - t0);
      } catch (err) {
        results[name].fail = { iteration: i, error: (err as Error).message };
        anyFail = true;
        break; // a single failure is investigated, never retried past
      }
    }
    const r = results[name];
    const p95 = r.ms.length ? r.ms.sort((a, b) => a - b)[Math.floor(r.ms.length * 0.95)] : 0;
    console.log(`${r.fail ? "✖" : "✔"} ${name.padEnd(42)} ${String(r.ok).padStart(3)}/${N}  p95 ${p95}ms${r.fail ? `  FAILED at #${r.fail.iteration}: ${r.fail.error}` : ""}`);
  }
  console.log(JSON.stringify({ iterations: N, at: new Date().toISOString(), results }, null, 0));
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
