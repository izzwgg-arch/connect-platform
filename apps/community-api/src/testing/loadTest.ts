/**
 * Load / soak test (brief §50–51): realistic user behaviour, not one endpoint.
 * Each virtual user signs up once, then loops a weighted scenario mix
 * (feed reads, search, profile views, posting, reacting, messaging, notifications)
 * with think time. Reports per-endpoint p50/p95/p99, error rate and throughput.
 *
 *   LOAD_USERS=100 LOAD_SECONDS=60 pnpm --filter @loopcom/community-api test:load
 *   LOAD_USERS=1000 LOAD_SECONDS=120 …      (needs COMMUNITY_RATE_LIMIT_OFF=1 on the api)
 *   LOAD_SECONDS=3600 → soak: memory/handles are sampled from /health every 30 s.
 *
 * Never point this at production.
 */
import "dotenv/config";

const BASE = (process.env.COMMUNITY_API_URL || "http://localhost:3101").replace(/\/$/, "");
const USERS = Number(process.env.LOAD_USERS || 100);
const SECONDS = Number(process.env.LOAD_SECONDS || 60);
const RAMP_MS = Number(process.env.LOAD_RAMP_MS || 10_000);
if (/loopcom\.net|connectcomunications/.test(BASE) && !process.env.LOAD_I_KNOW) {
  console.error("Refusing to load-test a production hostname.");
  process.exit(2);
}

type Sample = { route: string; ms: number; status: number };
const samples: Sample[] = [];
let inflight = 0;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function call(route: string, path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const t0 = performance.now();
  inflight++;
  let status = 0;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    status = res.status;
    const text = await res.text();
    return { status, body: text ? JSON.parse(text) : null };
  } catch {
    status = 0;
    return { status: 0, body: null };
  } finally {
    inflight--;
    samples.push({ route, ms: performance.now() - t0, status });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = () => sleep(200 + Math.random() * 800);

type VU = { token: string; id: string; username: string; postIds: string[]; peers: string[] };
const vus: VU[] = [];

async function signup(i: number): Promise<VU | null> {
  const email = `load-${i}-${uid()}@example.test`;
  const reg = await call("POST /auth/register", "/auth/register", { body: { firstName: "Load", lastName: `User${i}`, email, password: "Blue-anchor-marble-99" } });
  if (reg.status !== 201) return null;
  const codeRes = await call("GET /dev/last-code", `/dev/last-code?target=${encodeURIComponent(email)}`);
  if (codeRes.body?.code) await call("POST /auth/verify/confirm", "/auth/verify/confirm", { token: reg.body.accessToken, body: { purpose: "email", target: email, code: codeRes.body.code } });
  await call("PATCH /me/profile", "/me/profile", { method: "PATCH", token: reg.body.accessToken, body: { headline: `Load tester ${i}`, industry: "Apparel & uniforms", location: "Monroe, NY" } });
  return { token: reg.body.accessToken, id: reg.body.person.id, username: reg.body.person.username, postIds: [], peers: [] };
}

const SCENARIOS: Array<[number, (vu: VU) => Promise<void>]> = [
  [30, async (vu) => { await call("GET /feed", `/feed?mode=${["for_you", "latest", "following"][Math.floor(Math.random() * 3)]}`, { token: vu.token }); }],
  [12, async (vu) => { await call("GET /search", `/search?q=${["embroidery", "load tester", "monroe", "uniform"][Math.floor(Math.random() * 4)]}`, { token: vu.token }); }],
  [12, async (vu) => { const peer = vus[Math.floor(Math.random() * vus.length)]; if (peer) await call("GET /public/people/:u", `/public/people/${peer.username}`, { token: vu.token }); }],
  [8, async (vu) => { const r = await call("POST /posts", "/posts", { token: vu.token, body: { kind: "TEXT", body: `Load post ${uid()} from ${vu.username}`, visibility: "PUBLIC" } }); const id = r.body?.post?.id ?? r.body?.id; if (id) vu.postIds.push(id); }],
  [10, async (vu) => { const peer = vus[Math.floor(Math.random() * vus.length)]; const id = peer?.postIds[Math.floor(Math.random() * (peer?.postIds.length || 1))]; if (id) await call("POST /posts/:id/react", `/posts/${id}/react`, { token: vu.token, body: { kind: "LIKE" } }); }],
  [6, async (vu) => { const peer = vus[Math.floor(Math.random() * vus.length)]; if (peer && peer.id !== vu.id) { const r = await call("POST /connections/request", "/connections/request", { token: vu.token, body: { personId: peer.id } }); if (r.status === 201 || r.status === 200) vu.peers.push(peer.id); } }],
  [8, async (vu) => { const peer = vus[Math.floor(Math.random() * vus.length)]; if (peer && peer.id !== vu.id) { const t = await call("POST /threads", "/threads", { token: vu.token, body: { personIds: [peer.id] } }); const tid = t.body?.thread?.id ?? t.body?.id; if (tid) await call("POST /threads/:id/messages", `/threads/${tid}/messages`, { token: vu.token, body: { kind: "TEXT", body: `hello ${uid()}` } }); } }],
  [8, async (vu) => { await call("GET /notifications", "/notifications", { token: vu.token }); }],
  [6, async (vu) => { await call("GET /threads", "/threads?tab=inbox", { token: vu.token }); }],
];
const TOTAL_W = SCENARIOS.reduce((a, [w]) => a + w, 0);
function pick() {
  let r = Math.random() * TOTAL_W;
  for (const [w, fn] of SCENARIOS) {
    if ((r -= w) <= 0) return fn;
  }
  return SCENARIOS[0][1];
}

function pct(arr: number[], p: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`api not reachable at ${BASE}`);
    process.exit(2);
  }
  console.log(`load: ${USERS} virtual users, ${SECONDS}s, ramp ${RAMP_MS}ms → ${BASE}`);
  const start = Date.now();
  const end = start + SECONDS * 1000;
  const healthSamples: Array<{ at: number; dbMs: number; rssMb: number; inflight: number }> = [];
  const monitor = setInterval(async () => {
    const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
    healthSamples.push({ at: Date.now() - start, dbMs: h?.dbMs ?? -1, rssMb: h?.rssMb ?? -1, inflight });
  }, 30_000);
  const workers = Array.from({ length: USERS }, async (_, i) => {
    await sleep((i / USERS) * RAMP_MS);
    const vu = await signup(i);
    if (!vu) return;
    vus.push(vu);
    while (Date.now() < end) {
      await pick()(vu);
      await think();
    }
  });
  await Promise.all(workers);
  clearInterval(monitor);
  const elapsed = (Date.now() - start) / 1000;
  const byRoute = new Map<string, Sample[]>();
  for (const s of samples) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);
  const rows = [...byRoute.entries()].map(([route, list]) => {
    const ms = list.map((s) => s.ms);
    const errors = list.filter((s) => s.status === 0 || s.status >= 500).length;
    return { route, count: list.length, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), p99: Math.round(pct(ms, 0.99)), errors, errPct: +((errors / list.length) * 100).toFixed(2) };
  }).sort((a, b) => b.count - a.count);
  console.table(rows);
  const total = samples.length;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  const summary = { users: vus.length, requested: USERS, seconds: elapsed, requests: total, rps: +(total / elapsed).toFixed(1), errorPct: +((errors / total) * 100).toFixed(2), p95All: Math.round(pct(samples.map((s) => s.ms), 0.95)), healthSamples };
  console.log(JSON.stringify(summary));
  process.exit(errors / total > 0.01 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
