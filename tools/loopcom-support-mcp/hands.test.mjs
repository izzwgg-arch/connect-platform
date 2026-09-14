/**
 * The support agent's HANDS (2026-09-14): it may fix what the ticket's filer is
 * allowed to do, only through act_as_filer, after texting the owner; 10 per
 * company per day.
 *
 * ⛔ What these defend: a tool the agent needs being silently denied under -p;
 * the guardrails losing the rules the api does not enforce (no commit/deploy,
 * no direct PBX write, no customer messages); the client posting somewhere other
 * than the gated routes; one company using up another's daily allowance.
 *
 * Kept separate from stress.test.mjs on purpose: that file holds literal NUL and
 * RLO bytes as hostile-input fixtures, so git treats it as binary and a diff of
 * it cannot be reviewed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideTicket, startedTodayForTenant, tenantKeyOf, DEFAULTS } from "./triage.mjs";
import { buildAgentArgs, ALLOWED_TOOLS, DENIED_TOOLS } from "./watch.mjs";
import { actAsFiler, postOwnerNotice, getOwnerNotices } from "./loopcom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = "2026-09-14";
const NOW = new Date(DAY + "T18:00:00.000Z").getTime();
const WATCHING_SINCE = DAY + "T00:00:00.000Z";

const ticket = (o = {}) => ({
  reference: "NEW001",
  tenantId: "tenant-trust",
  tenantName: "Trust Bookkeepings",
  userName: "vigdor",
  requestSummary: "my greeting does not play",
  createdAt: DAY + "T17:00:00.000Z",
  ...o,
});
const claims = (n, tenant, lane = "customer") => {
  const out = {};
  for (let i = 0; i < n; i++) out[`C${tenant}${i}`] = { at: DAY + "T09:00:00.000Z", status: "done", lane, tenant };
  return out;
};
const decide = (t, claimed = {}, cfg = {}) =>
  decideTicket({ ticket: t, state: { claimed, startedAt: WATCHING_SINCE }, now: NOW, cfg, watchingSince: WATCHING_SINCE });

describe("the per-company cap", () => {
  test("the default is 10 per company, with a larger lane backstop", () => {
    assert.equal(DEFAULTS.tenantCap, 10);
    assert.ok(DEFAULTS.customerCap > DEFAULTS.tenantCap);
  });

  test("⛔ the boundary is exact: 9 works, 10 defers — for that company only", () => {
    const key = tenantKeyOf(ticket());
    assert.equal(decide(ticket(), claims(9, key)).action, "work");
    const d = decide(ticket(), claims(10, key));
    assert.equal(d.action, "defer_cap");
    assert.match(d.why, /company cap/);
  });

  test("⛔ another company's busy day never defers this one", () => {
    const other = tenantKeyOf(ticket({ tenantId: "tenant-gesheft", tenantName: "Gesheft" }));
    assert.equal(decide(ticket(), claims(10, other)).action, "work");
  });

  test("⛔ platform alarms are never counted and never capped per company", () => {
    const key = tenantKeyOf(ticket());
    assert.equal(startedTodayForTenant({ claimed: claims(20, key, "platform") }, DAY, key), 0);
    const alarm = ticket({ userName: "email guardrail", tenantName: "Trust Bookkeepings" });
    assert.equal(decide(alarm, claims(10, key)).action, "work");
  });

  test("the company name is the fallback key; an unknown company is never capped", () => {
    assert.equal(tenantKeyOf({ tenantName: "  Trust Bookkeepings " }), "name:trust bookkeepings");
    assert.equal(tenantKeyOf({}), null);
    assert.equal(startedTodayForTenant({ claimed: claims(50, null) }, DAY, null), 0);
  });

  test("skips and yesterday's runs do not count", () => {
    const key = tenantKeyOf(ticket());
    const claimed = {};
    for (let i = 0; i < 20; i++) claimed["S" + i] = { at: DAY + "T08:00:00.000Z", status: "skipped_pre_existing", lane: "customer", tenant: key };
    for (let i = 0; i < 20; i++) claimed["Y" + i] = { at: "2026-09-13T08:00:00.000Z", status: "done", lane: "customer", tenant: key };
    assert.equal(decide(ticket(), claimed).action, "work");
  });

  test("⛔ SOURCE GUARD: the watcher records the company on every claim", () => {
    const src = fs.readFileSync(path.join(HERE, "watch.mjs"), "utf8").replace(/\r\n/g, "\n");
    assert.match(src, /claim\(state, t\.reference, d\.lane, tenantKeyOf\(t\)\)/);
    assert.match(src, /status: "running", lane, attempts, tenant/);
  });
});

describe("the agent's tools and rules", () => {
  const args = buildAgentArgs("3GTH9M");
  const sys = args[args.indexOf("--append-system-prompt") + 1];

  test("⛔ the hands are pre-approved — under -p an unlisted tool is DENIED, not asked", () => {
    for (const name of ["act_as_filer", "post_owner_notice", "get_owner_notices"]) {
      const t = "mcp__loopcom-support__" + name;
      assert.ok(ALLOWED_TOOLS.includes(t), t);
      assert.ok(args.includes(t), t + " missing from argv");
    }
  });

  test("⛔ the rules the api cannot enforce are still stated", () => {
    assert.match(sys, /Do NOT commit, push, or deploy/);
    assert.match(sys, /never write to the PBX/);
    assert.match(sys, /Never message, email or text a customer/);
    assert.match(sys, /READ-ONLY investigation only/);
    for (const frag of ["git push", "git commit", "docker restart", "systemctl", "rm:"]) {
      assert.ok(DENIED_TOOLS.some((d) => d.includes(frag)), "not denied: " + frag);
    }
  });

  test("the fixing rules are stated: filer's permissions, act_as_filer only, notice first, STOP, system waits, verify", () => {
    assert.match(sys, /person who FILED the ticket is allowed to do/);
    assert.match(sys, /The ONLY way you change anything is the act_as_filer tool/);
    assert.match(sys, /BEFORE your first change: call post_owner_notice with scope 'tenant'/);
    assert.match(sys, /If mayChange is false, the owner said STOP/);
    assert.match(sys, /scope 'system'/);
    assert.match(sys, /VERIFY/);
    assert.doesNotMatch(sys, /Do not fix anything/);
  });

  test("the run limit is 30 minutes by default", () => {
    const src = fs.readFileSync(path.join(HERE, "watch.mjs"), "utf8");
    assert.match(src, /WATCH_RUN_TIMEOUT_MS \|\| 30 \* 60 \* 1000/);
  });
});

describe("the client posts only to the gated routes", () => {
  const cfg = { base: "https://api.test/api", token: "tok", configured: true };

  async function capture(fn) {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  }

  test("act_as_filer → POST …/escalations/:ref/act with method, path and body", async () => {
    const [c] = await capture(() => actAsFiler(cfg, "3GTH9M", { method: "POST", path: "/voicemail/greeting/reset", body: { greetingType: "busy" } }));
    assert.equal(c.url, "https://api.test/api/admin/support/escalations/3GTH9M/act");
    assert.equal(c.method, "POST");
    assert.deepEqual(c.body, { method: "POST", path: "/voicemail/greeting/reset", body: { greetingType: "busy" } });
    assert.equal(c.auth, "Bearer tok");
  });

  test("post_owner_notice and get_owner_notices hit their routes", async () => {
    const seen = await capture(async () => {
      await postOwnerNotice(cfg, "3GTH9M", { scope: "tenant", summary: "Copy the greeting to busy." });
      await getOwnerNotices(cfg, "3GTH9M");
    });
    assert.equal(seen[0].url, "https://api.test/api/admin/support/escalations/3GTH9M/owner-notice");
    assert.deepEqual(seen[0].body, { scope: "tenant", summary: "Copy the greeting to busy." });
    assert.equal(seen[1].url, "https://api.test/api/admin/support/escalations/3GTH9M/owner-notices");
    assert.equal(seen[1].method, "GET");
  });

  test("⛔ a hostile reference cannot leave the escalation path", async () => {
    const [c] = await capture(() => actAsFiler(cfg, "../../tenants", { method: "GET", path: "/x" }));
    assert.ok(c.url.startsWith("https://api.test/api/admin/support/escalations/"));
    assert.ok(!c.url.includes("/../"));
  });

  test("⛔ the api's refusal reaches the agent as an error with the reason", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "stopped_by_owner" }), { status: 409 });
    try {
      await assert.rejects(actAsFiler(cfg, "3GTH9M", { method: "POST", path: "/x" }), /409.*stopped_by_owner/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("⛔ SOURCE GUARD: server.mjs registers the three tools and the watcher still has no POST of its own", () => {
    const server = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");
    for (const name of ["act_as_filer", "post_owner_notice", "get_owner_notices"]) {
      assert.ok(server.includes(`"${name}"`), name);
    }
    const watch = fs.readFileSync(path.join(HERE, "watch.mjs"), "utf8");
    assert.ok(!/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(watch));
  });
});
