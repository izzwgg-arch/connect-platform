/* CONSOLE STRESS (2026-08-20, Izzy: "stress test the fuck out of it. Creating
 * outbound routes, creating trunks, route selections, and ring groups and
 * cues"). Drives the DEPLOYED console HTTP routes — not the modules directly —
 * so what is stressed is exactly what a click stresses: requireOwner, the
 * panel replay, the reference guards, applyAndRebake, all of it.
 *
 * Phases: baseline → 15 trunks → 15 outbound routes → 15 route selections →
 * edits on every one (route trunk-reorder + CID; selection member off→verify→
 * on) → wrong-order delete probes (every guard must refuse) → 8 ring groups +
 * 8 queues on Loopcom Demo 2 with full-option edits → teardown in dependency
 * order, every delete verified by re-list → final counts must equal baseline.
 *
 * ⛔ Fake carrier only: trunks register to mirror-test.invalid (harmless
 * failures, same as the tenant stress), CIDs are 845555xx fakes. Run in a
 * ONE-OFF container (auto-deploys recreate app-api-1 and killed three
 * in-container runs on 2026-08-20 alone), targeting http://api:3001 by docker
 * DNS. TEARDOWN_ONLY=1 skips creation and deletes by the name prefixes.
 *   docker compose -f docker-compose.app.yml run -d --no-deps \
 *     -v /root/stress-routing-teams.js:/app/packages/db/stress-routing-teams.js \
 *     -w /app/packages/db --entrypoint node api stress-routing-teams.js */
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const N_ROUTING = 15;
const N_TEAMS = 8;
const T_PREFIX = "STRESS RT";
const R_PREFIX = "STRESS ROUTE";
const S_PREFIX = "STRESS SEL";
const RG_PREFIX = "STRESS RG";
const Q_PREFIX = "STRESS Q";

let failures = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failures++; };
const pw = () => "Aa2" + Array.from(crypto.randomBytes(14)).map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"[b % 55]).join("");

async function main() {
  const db = new PrismaClient();
  const admin = await db.user.findFirst({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, select: { id: true, tenantId: true } });
  const mint = () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({ sub: admin.id, role: "SUPER_ADMIN", tenantId: admin.tenantId, iat: now, exp: now + 1800 });
    const sig = crypto.createHmac("sha256", process.env.JWT_SECRET).update(head + "." + payload).digest("base64url");
    return head + "." + payload + "." + sig;
  };
  let tok = mint(); let tokAt = Date.now();
  const call = async (method, path, body) => {
    if (Date.now() - tokAt > 20 * 60 * 1000) { tok = mint(); tokAt = Date.now(); }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const opts = { method, headers: { authorization: "Bearer " + tok } };
        if (method !== "GET") { opts.headers["content-type"] = "application/json"; opts.body = body ? JSON.stringify(body) : "{}"; }
        const res = await fetch("http://api:3001" + path, opts);
        return { status: res.status, json: await res.json().catch(() => null) };
      } catch (e) {
        // blue/green cutover window: docker-DNS "api" fails for ~67s while the
        // stable container is recreated. Wait it out rather than failing a phase.
        if (attempt === 3) throw e;
        console.log(`  (transport blip on ${method} ${path} — retry ${attempt} in 45s: ${e.message})`);
        await new Promise((r) => setTimeout(r, 45000));
      }
    }
  };
  const nn = (i) => String(i).padStart(2, "0");
  const t0 = Date.now();
  const teardownOnly = process.env.TEARDOWN_ONLY === "1";

  // ── baseline ──────────────────────────────────────────────────────────────
  const base = await call("GET", "/admin/pbx-console/routing");
  const baseTeams = await call("GET", "/admin/pbx-console/teams");
  console.log("BASELINE routing:", base.json.trunks.length, "trunks /", base.json.routes.length, "routes /", base.json.ars.length, "selections | teams:", baseTeams.json.ringGroups.length, "rgs /", baseTeams.json.queues.length, "queues");
  const t140 = baseTeams.json.tenants.find((t) => t.description === "Loopcom Demo 2");
  if (!t140) { console.error("ABORT: no Loopcom Demo 2"); process.exit(2); }
  const ext = (n) => t140.extensions.find((e) => e.number === n);

  if (!teardownOnly) {
    // ── create 15 trunks ────────────────────────────────────────────────────
    for (let i = 1; i <= N_ROUTING; i++) {
      const r = await call("POST", "/admin/pbx-console/trunks", { description: `${T_PREFIX} ${nn(i)} delete me`, username: `stress_rt_${nn(i)}`, password: pw(), server: "mirror-test.invalid" });
      check(r.status === 200 && r.json?.trunkId, `trunk ${nn(i)} created (#${r.json?.trunkId})`);
    }
    // ── create 15 routes, each on its stress trunk ──────────────────────────
    let routing = (await call("GET", "/admin/pbx-console/routing")).json;
    const strunk = (i) => routing.trunks.find((t) => t.description === `${T_PREFIX} ${nn(i)} delete me`);
    for (let i = 1; i <= N_ROUTING; i++) {
      const r = await call("POST", "/admin/pbx-console/outbound-routes", { description: `${R_PREFIX} ${nn(i)} delete me`, cidName: `Stress ${nn(i)}`, cidNumber: `84555540${nn(i)}`, trunkIds: [String(strunk(i).id)] });
      check(r.status === 200 && r.json?.routeId, `route ${nn(i)} created (#${r.json?.routeId})`);
    }
    // ── create 15 selections, each on its route ─────────────────────────────
    routing = (await call("GET", "/admin/pbx-console/routing")).json;
    const sroute = (i) => routing.routes.find((t) => t.description === `${R_PREFIX} ${nn(i)} delete me`);
    for (let i = 1; i <= N_ROUTING; i++) {
      const r = await call("POST", "/admin/pbx-console/route-selections", { description: `${S_PREFIX} ${nn(i)} delete me`, outboundRouteId: String(sroute(i).id) });
      check(r.status === 200 && r.json?.arsId, `selection ${nn(i)} created (#${r.json?.arsId})`);
    }
    // ── edit every route: second trunk PREPENDED (order is the feature) + CID ─
    routing = (await call("GET", "/admin/pbx-console/routing")).json;
    for (let i = 1; i <= N_ROUTING; i++) {
      const other = strunk((i % N_ROUTING) + 1);
      const mine = strunk(i);
      const rt = routing.routes.find((t) => t.description === `${R_PREFIX} ${nn(i)} delete me`);
      const r = await call("PATCH", `/admin/pbx-console/outbound-routes/${rt.id}`, { trunkIds: [String(other.id), String(mine.id)], cidName: `Stress ${nn(i)} edited` });
      check(r.status === 200, `route ${nn(i)} edited`);
    }
    routing = (await call("GET", "/admin/pbx-console/routing")).json;
    let orderOk = 0;
    for (let i = 1; i <= N_ROUTING; i++) {
      const rt = routing.routes.find((t) => t.description === `${R_PREFIX} ${nn(i)} delete me`);
      const ordered = [...rt.trunks].sort((a, b) => a.index - b.index).map((t) => t.description);
      const expect0 = `${T_PREFIX} ${nn((i % N_ROUTING) + 1)} delete me`;
      if (rt.trunks.length === 2 && ordered[0] === expect0 && rt.cidName === `Stress ${nn(i)} edited`) orderOk++;
    }
    check(orderOk === N_ROUTING, `all ${N_ROUTING} route edits verified from the rows (trunk ORDER + CID) — ${orderOk}/${N_ROUTING}`);
    // ── toggle every selection's member off, verify, back on ────────────────
    for (let i = 1; i <= N_ROUTING; i++) {
      const sel = routing.ars.find((a) => a.description === `${S_PREFIX} ${nn(i)} delete me`);
      const rid = sel.members[0].outboundRouteId;
      const off = await call("PATCH", `/admin/pbx-console/route-selections/${sel.id}/members`, { outboundRouteIds: [String(rid)], enabled: false });
      const mid = (await call("GET", "/admin/pbx-console/routing")).json.ars.find((a) => a.id === sel.id);
      const on = await call("PATCH", `/admin/pbx-console/route-selections/${sel.id}/members`, { outboundRouteIds: [String(rid)], enabled: true });
      check(off.status === 200 && on.status === 200 && mid.members[0].enabled === false, `selection ${nn(i)} member off→verified→on`);
    }
    // ── wrong-order delete probes: every guard must REFUSE ──────────────────
    routing = (await call("GET", "/admin/pbx-console/routing")).json;
    const probeTrunk = routing.trunks.find((t) => t.description === `${T_PREFIX} 01 delete me`);
    const probeRoute = routing.routes.find((t) => t.description === `${R_PREFIX} 01 delete me`);
    const g1 = await call("DELETE", `/admin/pbx-console/trunks/${probeTrunk.id}`);
    check(g1.status === 409 && g1.json?.error === "trunk_in_use", "GUARD: deleting an in-use trunk refused 409");
    const g2 = await call("DELETE", `/admin/pbx-console/outbound-routes/${probeRoute.id}`);
    check(g2.status === 409 && g2.json?.error === "route_in_use", "GUARD: deleting an in-use route refused 409");
    // ── teams: 8 ring groups + 8 queues on T140 ─────────────────────────────
    for (let i = 1; i <= N_TEAMS; i++) {
      const r = await call("POST", "/admin/pbx-console/ring-groups", { pbxTenantId: t140.tenantId, spec: {
        name: `${RG_PREFIX} ${nn(i)} delete me`, strategy: i % 2 ? "ringall" : "one_by_one", ringTime: 10 + i,
        members: [{ extensionId: ext("101").id }, { extensionId: ext("102").id }, { extensionId: ext("103").id }],
        lastDestination: { categoryId: "1", targetId: String(ext("101").id) },
      } });
      check(r.status === 200 && r.json?.number, `ring group ${nn(i)} created (${r.json?.number})`);
    }
    for (let i = 1; i <= N_TEAMS; i++) {
      const r = await call("POST", "/admin/pbx-console/queues", { pbxTenantId: t140.tenantId, spec: {
        name: `${Q_PREFIX} ${nn(i)} delete me`, strategy: i % 2 ? "linear" : "ringall", ringTime: 10 + i, retry: i, maxWaitSeconds: 60 * i, maxCallers: i,
        serviceLevelSeconds: 15 + i, wrapUpSeconds: i, autofill: i % 2 === 0, autoPause: i % 3 === 0,
        members: [{ extensionId: ext("104").id, penalty: 0 }, { extensionId: ext("105").id, penalty: i % 3 }],
        lastDestination: { categoryId: "25", targetId: String(ext("105").id) },
      } });
      check(r.status === 200 && r.json?.number, `queue ${nn(i)} created (${r.json?.number})`);
    }
    // ── edit every team ─────────────────────────────────────────────────────
    let teams = (await call("GET", "/admin/pbx-console/teams")).json;
    for (let i = 1; i <= N_TEAMS; i++) {
      const rg = teams.ringGroups.find((r) => r.description === `${RG_PREFIX} ${nn(i)} delete me`);
      const r = await call("PATCH", `/admin/pbx-console/ring-groups/${rg.id}`, {
        set: { description: `${RG_PREFIX} ${nn(i)} EDITED delete me`, ringtime: String(30 + i) },
        checks: { skip_busy: true },
        rgMembers: [ext("103").id, ext("101").id],
      });
      check(r.status === 200, `ring group ${nn(i)} edited`);
      const qu = teams.queues.find((x) => x.description === `${Q_PREFIX} ${nn(i)} delete me`);
      const r2 = await call("PATCH", `/admin/pbx-console/queues/${qu.id}`, {
        set: { description: `${Q_PREFIX} ${nn(i)} EDITED delete me`, retry: String(10 + i), servicelevel: String(40 + i) },
        checks: { autopause: i % 2 === 0, autofill: i % 2 === 1, answerchannel: true },
        queueMembers: [{ extensionId: ext("101").id, penalty: i }, { extensionId: ext("102").id, penalty: 0 }],
      });
      check(r2.status === 200, `queue ${nn(i)} edited`);
    }
    teams = (await call("GET", "/admin/pbx-console/teams")).json;
    let teamEditOk = 0;
    for (let i = 1; i <= N_TEAMS; i++) {
      const rg = teams.ringGroups.find((r) => r.description === `${RG_PREFIX} ${nn(i)} EDITED delete me`);
      const qu = teams.queues.find((x) => x.description === `${Q_PREFIX} ${nn(i)} EDITED delete me`);
      const rgOk = rg && rg.options.ringtime === String(30 + i) && rg.options.skip_busy === "yes" && rg.members.map((m) => m.extension).join(",") === "103,101";
      const quOk = qu && qu.options.retry === String(10 + i) && qu.options.servicelevel === String(40 + i) && qu.members.length === 2 && qu.members.some((m) => m.extension === "101" && Number(m.penalty) === i);
      if (rgOk && quOk) teamEditOk++;
      else console.log(`  detail ${nn(i)}: rgOk=${!!rgOk} quOk=${!!quOk}`, rg && JSON.stringify({ rt: rg.options.ringtime, sb: rg.options.skip_busy, m: rg.members.map((m) => m.extension) }), qu && JSON.stringify({ re: qu.options.retry, sl: qu.options.servicelevel, m: qu.members.map((m) => m.extension + ":" + m.penalty) }));
    }
    check(teamEditOk === N_TEAMS, `all ${N_TEAMS}x2 team edits verified from the rows — ${teamEditOk}/${N_TEAMS}`);
  }

  // ── teardown, dependency order, everything verified ──────────────────────
  const byPrefix = (list, prefix) => list.filter((x) => (x.description || "").startsWith(prefix));
  let teams = (await call("GET", "/admin/pbx-console/teams")).json;
  for (const qu of byPrefix(teams.queues, Q_PREFIX)) {
    const r = await call("DELETE", `/admin/pbx-console/queues/${qu.id}`);
    check(r.status === 200, `teardown queue ${qu.description}`);
  }
  for (const rg of byPrefix(teams.ringGroups, RG_PREFIX)) {
    const r = await call("DELETE", `/admin/pbx-console/ring-groups/${rg.id}`);
    check(r.status === 200, `teardown ring group ${rg.description}`);
  }
  let routing = (await call("GET", "/admin/pbx-console/routing")).json;
  for (const sel of byPrefix(routing.ars, S_PREFIX)) {
    const r = await call("DELETE", `/admin/pbx-console/route-selections/${sel.id}`);
    check(r.status === 200, `teardown selection ${sel.description}`);
  }
  routing = (await call("GET", "/admin/pbx-console/routing")).json;
  for (const rt of byPrefix(routing.routes, R_PREFIX)) {
    const r = await call("DELETE", `/admin/pbx-console/outbound-routes/${rt.id}`);
    check(r.status === 200, `teardown route ${rt.description}`);
  }
  routing = (await call("GET", "/admin/pbx-console/routing")).json;
  for (const tr of byPrefix(routing.trunks, T_PREFIX)) {
    const r = await call("DELETE", `/admin/pbx-console/trunks/${tr.id}`);
    check(r.status === 200, `teardown trunk ${tr.description}`);
  }
  // ── final counts must equal baseline ──────────────────────────────────────
  const fin = (await call("GET", "/admin/pbx-console/routing")).json;
  const finTeams = (await call("GET", "/admin/pbx-console/teams")).json;
  check(fin.trunks.length === base.json.trunks.length, `trunks back to baseline ${base.json.trunks.length} (now ${fin.trunks.length})`);
  check(fin.routes.length === base.json.routes.length, `routes back to baseline ${base.json.routes.length} (now ${fin.routes.length})`);
  check(fin.ars.length === base.json.ars.length, `selections back to baseline ${base.json.ars.length} (now ${fin.ars.length})`);
  check(finTeams.ringGroups.length === baseTeams.json.ringGroups.length, `ring groups back to baseline ${baseTeams.json.ringGroups.length}`);
  check(finTeams.queues.length === baseTeams.json.queues.length, `queues back to baseline ${baseTeams.json.queues.length}`);
  check([...fin.trunks, ...fin.routes, ...fin.ars].every((x) => !(x.description || "").includes("STRESS")), "no STRESS leftovers in routing");
  check([...finTeams.ringGroups, ...finTeams.queues].every((x) => !(x.description || "").includes("STRESS")), "no STRESS leftovers in teams");
  console.log(`${failures === 0 ? "ALL DONE PASS" : "ALL DONE WITH FAILURES"} failures=${failures} minutes=${Math.round((Date.now() - t0) / 60000)}`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
