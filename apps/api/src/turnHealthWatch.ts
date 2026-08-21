/**
 * TURN health watch — texts Izzy when the TURN server behind ordinary phone
 * calls stops answering.
 *
 * Izzy, 2026-08-21: *"Make it so that when there's ever an issue or the turn
 * server is ever down, I should get a text message."*
 *
 * ⛔⛔ THE ONLY ALARM CHANNEL THAT REACHES A PERSON IS AN `AgentEscalation`
 * ROW. `agentEscalationDispatch.ts` turns one into the SMS to (562) 209-6644 +
 * (845) 723-1213 within 30 seconds. NEVER use `ADMIN_ALERT` here — it is muted
 * at the send door, so it would build clean, log clean, and reach nobody.
 *
 * ⛔ State lives in `AgentAuditLog`, never a module variable: this api restarts
 * dozens of times a day and an in-memory counter re-arms on every deploy (the
 * alert-cooldown lesson).
 *
 * ⛔ WHICH TURN THIS WATCHES: coturn on the PRIMARY IP (3478/5349), the one
 * behind ordinary phone calls. It is NOT LiveKit's TURN for video meetings,
 * which is a different process on a different IP, port and relay range. Do not
 * merge the two — a fault in one says nothing about the other.
 */
import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";

const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

/** ⛔ De-dupe keys. A persistent fault must text ONCE, not every cycle. The
 *  escalation is matched by `requestSummary` startsWith, so renaming one of
 *  these orphans its de-dupe and re-opens the floodgate. */
export const TURN_ALARM_PREFIX = {
  down: "TURN server is down",
  degraded: "TURN server is partly unreachable",
  certExpiring: "TURN certificate is about to expire",
} as const;

export const TURN_CHECK_INTERVAL_MS = Number(process.env.TURN_HEALTH_INTERVAL_MS || 2 * 60 * 1000);
/** Alert only after this many consecutive failed checks — one dropped UDP
 *  packet at 3am must never ring his phone. */
export const TURN_DOWN_STREAK = Number(process.env.TURN_HEALTH_DOWN_STREAK || 3);
/** Warn while there is still time to fix a renewal, not after it breaks. */
export const TURN_CERT_WARN_DAYS = Number(process.env.TURN_HEALTH_CERT_WARN_DAYS || 10);
const BOOT_CHECK_DELAY_MS = 90_000;
const AUDIT_EVENT = "turn_health.check";

const DISABLED = () => String(process.env.TURN_HEALTH_WATCH_DISABLED || "").trim() === "1";

export type TurnTransportResult = { target: string; ok: boolean; detail: string };
export type TurnProbe = {
  /** UDP STUN — the path the overwhelming majority of calls actually use. */
  udp: TurnTransportResult[];
  /** TCP fallback for UDP-blocked networks. */
  tcp: TurnTransportResult[];
  /** TURNS (TLS) — also where a silent certificate expiry would bite. */
  tls: TurnTransportResult[];
  certDaysLeft: number | null;
  certSubject: string | null;
};

export type TurnState = "ok" | "degraded" | "down" | "unknown";

/**
 * ⛔ PURE — no db, no clock, no network. Everything hard about this feature is
 * the decision, so the decision is testable on its own.
 *
 * "down"     = nothing answered at all. The server is gone.
 * "degraded" = something answered and something did not (e.g. UDP dead, TCP up).
 *              Worth a text: most WebRTC media is UDP, so this is a real fault
 *              even though a naive up/down check would call it healthy.
 */
export function classifyTurnProbe(probe: TurnProbe): TurnState {
  const all = [...probe.udp, ...probe.tcp, ...probe.tls];
  if (!all.length) return "unknown";
  const good = all.filter((r) => r.ok).length;
  if (good === 0) return "down";
  if (good < all.length) return "degraded";
  return "ok";
}

export type TurnAlertDecision =
  | { action: "none"; reason: string }
  | { action: "alert"; key: string; summary: string }
  | { action: "recovered"; key: string; summary: string };

/**
 * Edge-triggered. Alert on the crossing INTO trouble and once on the way back
 * out — never on every cycle while a known fault persists.
 */
export function decideTurnAlert(params: {
  state: TurnState;
  /** Consecutive bad checks INCLUDING this one. */
  streak: number;
  /** Did the last recorded check consider us already alerted? */
  alreadyAlerted: boolean;
  downStreak?: number;
}): TurnAlertDecision {
  const need = params.downStreak ?? TURN_DOWN_STREAK;
  if (params.state === "unknown") return { action: "none", reason: "probe_inconclusive" };

  if (params.state === "ok") {
    return params.alreadyAlerted
      ? { action: "recovered", key: TURN_ALARM_PREFIX.down, summary: "TURN server is back — calls can relay again." }
      : { action: "none", reason: "healthy" };
  }

  if (params.alreadyAlerted) return { action: "none", reason: "already_alerted" };
  if (params.streak < need) return { action: "none", reason: `streak_${params.streak}_of_${need}` };

  const key = params.state === "down" ? TURN_ALARM_PREFIX.down : TURN_ALARM_PREFIX.degraded;
  return { action: "alert", key, summary: key };
}

// ── Probes (node builtins only — ⛔ no new dependency in apps/api) ──────────

/** A STUN Binding Request. A real reply proves the server is answering, not
 *  merely that a socket is open. */
export function buildStunBindingRequest(): Buffer {
  const id = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) id[i] = Math.floor(Math.random() * 256);
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from([0x21, 0x12, 0xa4, 0x42]), id]);
}

export async function stunOverUdp(host: string, port: number, timeoutMs = 4000, attempts = 3): Promise<TurnTransportResult> {
  const target = `udp ${host}:${port}`;
  for (let i = 0; i < attempts; i++) {
    const result = await new Promise<TurnTransportResult | null>((resolve) => {
      const sock = dgram.createSocket("udp4");
      const timer = setTimeout(() => {
        try { sock.close(); } catch { /* already closed */ }
        resolve(null);
      }, timeoutMs);
      sock.on("message", (msg) => {
        clearTimeout(timer);
        try { sock.close(); } catch { /* already closed */ }
        const type = msg.length >= 2 ? msg.readUInt16BE(0) : 0;
        resolve({ target, ok: type === 0x0101, detail: `stun_type_0x${type.toString(16)}` });
      });
      sock.on("error", (err: any) => {
        clearTimeout(timer);
        try { sock.close(); } catch { /* already closed */ }
        resolve({ target, ok: false, detail: String(err?.message || err).slice(0, 120) });
      });
      try { sock.send(buildStunBindingRequest(), port, host); } catch (err: any) {
        clearTimeout(timer);
        resolve({ target, ok: false, detail: String(err?.message || err).slice(0, 120) });
      }
    });
    if (result) return result;
  }
  return { target, ok: false, detail: `no_reply_after_${attempts}_attempts` };
}

export async function tcpConnect(host: string, port: number, timeoutMs = 5000): Promise<TurnTransportResult> {
  const target = `tcp ${host}:${port}`;
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.on("connect", () => { sock.destroy(); resolve({ target, ok: true, detail: "connected" }); });
    sock.on("timeout", () => { sock.destroy(); resolve({ target, ok: false, detail: "timeout" }); });
    sock.on("error", (err: any) => resolve({ target, ok: false, detail: String(err?.code || err?.message).slice(0, 120) }));
  });
}

export async function tlsHandshake(host: string, port: number, timeoutMs = 6000): Promise<TurnTransportResult & { daysLeft: number | null; subject: string | null }> {
  const target = `tls ${host}:${port}`;
  return new Promise((resolve) => {
    // ⛔ rejectUnauthorized:false on purpose — we want to REPORT an expired or
    // mismatched certificate, not fail to see it.
    const sock = tls.connect({ host, port, timeout: timeoutMs, rejectUnauthorized: false, servername: host }, () => {
      const cert: any = sock.getPeerCertificate();
      let daysLeft: number | null = null;
      if (cert?.valid_to) {
        const ms = new Date(cert.valid_to).getTime() - Date.now();
        if (Number.isFinite(ms)) daysLeft = Math.floor(ms / 86_400_000);
      }
      const subject = cert?.subject?.CN ? String(cert.subject.CN) : null;
      sock.destroy();
      resolve({ target, ok: true, detail: `cert=${subject ?? "?"} days_left=${daysLeft ?? "?"}`, daysLeft, subject });
    });
    sock.on("timeout", () => { sock.destroy(); resolve({ target, ok: false, detail: "timeout", daysLeft: null, subject: null }); });
    sock.on("error", (err: any) => resolve({ target, ok: false, detail: String(err?.code || err?.message).slice(0, 120), daysLeft: null, subject: null }));
  });
}

export type TurnTarget = { kind: "udp" | "tcp" | "tls"; host: string; port: number; url: string };

/**
 * Turn `turn:`/`turns:` URLs into concrete probe targets. PURE.
 *
 * ⛔ The monitor probes the SAME urls the api hands clients, gathered from the
 * same two places `resolveWebrtcConfig` uses (env + the TurnConfig rows), so it
 * can never drift into watching an endpoint nobody actually calls. A monitor
 * that invents its own target is worse than no monitor.
 */
export function parseTurnUrls(urls: string[]): TurnTarget[] {
  const out: TurnTarget[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const s = String(raw || "").trim();
    const m = s.match(/^(turns?):([^:?/]+)(?::(\d+))?(?:\?transport=(udp|tcp))?/i);
    if (!m) continue;
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const port = m[3] ? Number(m[3]) : (scheme === "turns" ? 5349 : 3478);
    const transport = (m[4] || "").toLowerCase();
    const kind: TurnTarget["kind"] = scheme === "turns" ? "tls" : transport === "tcp" ? "tcp" : "udp";
    const key = `${kind}:${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, host, port, url: s });
  }
  return out;
}

/** env half: TURN_SERVER expands to udp+tcp exactly as buildEnvIceServers does. */
export function turnUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.TURN_HEALTH_TARGET || env.TURN_SERVER || "").trim();
  const out: string[] = [];
  if (raw) {
    if (/^turns?:/i.test(raw)) out.push(raw);
    else {
      const host = raw.replace(/:\d+$/, "");
      out.push(`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`);
    }
  }
  const tlsUrl = String(env.TURN_TLS_URL || "").trim();
  if (tlsUrl) out.push(tlsUrl);
  return out;
}

/** db half: the global TurnConfig row, which overrides/extends the env list. */
export async function turnUrlsFromDb(database: any): Promise<string[]> {
  try {
    const rows = await database.turnConfig.findMany({ select: { urls: true }, orderBy: { updatedAt: "desc" }, take: 5 });
    const out: string[] = [];
    for (const r of rows || []) {
      const u = r?.urls;
      if (Array.isArray(u)) out.push(...u.map((x: any) => (typeof x === "string" ? x : x?.urls)).flat().filter(Boolean));
      else if (typeof u === "string") out.push(u);
    }
    return out;
  } catch {
    return [];
  }
}

export async function probeTurn(targets: TurnTarget[]): Promise<TurnProbe> {
  const udp: TurnTransportResult[] = [];
  const tcp: TurnTransportResult[] = [];
  const tlsOut: TurnTransportResult[] = [];
  let certDaysLeft: number | null = null;
  let certSubject: string | null = null;
  for (const t of targets) {
    if (t.kind === "udp") udp.push(await stunOverUdp(t.host, t.port));
    else if (t.kind === "tcp") tcp.push(await tcpConnect(t.host, t.port));
    else {
      const r = await tlsHandshake(t.host, t.port);
      tlsOut.push({ target: r.target, ok: r.ok, detail: r.detail });
      if (r.daysLeft !== null && (certDaysLeft === null || r.daysLeft < certDaysLeft)) certDaysLeft = r.daysLeft;
      if (r.subject && !certSubject) certSubject = r.subject;
    }
  }
  return { udp, tcp, tls: tlsOut, certDaysLeft, certSubject };
}

// ── Message building ───────────────────────────────────────────────────────

/** ⛔ Plain ASCII, no emoji: one emoji flips the whole SMS to UCS-2 and cuts a
 *  segment from 160 characters to 70. */
export function buildTurnAlertSms(state: TurnState, probe: TurnProbe, host: string): string {
  const failed = [...probe.udp, ...probe.tcp, ...probe.tls].filter((r) => !r.ok).map((r) => r.target);
  const head = state === "down"
    ? `Connect alert: the TURN server (${host}) is DOWN.`
    : `Connect alert: the TURN server (${host}) is partly unreachable.`;
  const detail = failed.length ? ` Not answering: ${failed.join(", ")}.` : "";
  return `${head}${detail} Calls that need a relay may fail.`.slice(0, 300);
}

export function buildTurnAlertReport(state: TurnState, probe: TurnProbe, host: string): string {
  const line = (r: TurnTransportResult) => `  ${r.ok ? "OK  " : "FAIL"} ${r.target} — ${r.detail}`;
  return [
    `ISSUE`,
    `The TURN relay behind ordinary phone calls is ${state === "down" ? "not answering at all" : "only partly answering"}.`,
    `Host: ${host}`,
    ``,
    `FINDINGS`,
    ...[...probe.udp, ...probe.tcp, ...probe.tls].map(line),
    probe.certDaysLeft !== null ? `  TLS certificate: ${probe.certSubject ?? "?"}, ${probe.certDaysLeft} days left` : "",
    ``,
    `WHAT IT MEANS`,
    `TURN is the fallback that carries call media when a phone cannot reach the`,
    `phone system directly — typically filtered or locked-down office internet.`,
    `Calls on good networks keep working, so this can be invisible to most people`,
    `while completely breaking calls for the offices that depend on the relay.`,
    ``,
    `PROPOSED FIX`,
    `On loopcom: systemctl status coturn, then journalctl -u coturn -n 50.`,
    `Check ufw still allows 3478/tcp+udp, 5349/tcp and the relay range`,
    `49152-65535/udp, and that nothing else has taken those ports.`,
    ``,
    `NOTE`,
    `This watches coturn on the primary IP only. LiveKit's separate TURN for`,
    `video meetings is a different process on a different IP and is not covered.`,
  ].filter(Boolean).join("\n");
}

// ── Runner ─────────────────────────────────────────────────────────────────

type LastState = { state: TurnState; streak: number; alerted: boolean };

async function readLastState(database: any): Promise<LastState | null> {
  const row = await database.agentAuditLog.findFirst({
    where: { event: AUDIT_EVENT },
    orderBy: { ts: "desc" },
    select: { payload: true },
  }).catch(() => null);
  if (!row?.payload) return null;
  const p: any = row.payload;
  return {
    state: (p.state as TurnState) ?? "unknown",
    streak: Number(p.streak) || 0,
    alerted: Boolean(p.alerted),
  };
}

async function raiseTurnEscalation(database: any, key: string, summary: string, sms: string, report: string, fix: string): Promise<boolean> {
  // ⛔ De-dupe: a fault that persists must text ONCE. Resolving the row
  // (status no longer QUEUED/SENT) re-arms the alarm.
  const open = await database.agentEscalation.findFirst({
    where: { requestSummary: { startsWith: key }, status: { in: ["QUEUED", "SENT"] } },
    select: { id: true },
  }).catch(() => null);
  if (open) return false;
  await database.agentEscalation.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      tenantName: "Loopcom platform",
      clientUserId: null,
      userName: "TURN monitor",
      userEmail: null,
      requestSummary: summary,
      smsBody: sms,
      report,
      proposedFix: fix,
      researchDegraded: false,
      status: "QUEUED",
    },
  });
  return true;
}

export type TurnWatchDeps = {
  db?: any;
  env?: NodeJS.ProcessEnv;
  probe?: (t: any) => Promise<TurnProbe>;
  now?: () => Date;
};

export async function runTurnHealthCheck(deps: TurnWatchDeps = {}, log?: any): Promise<{ state: TurnState; alerted: boolean; skipped?: string }> {
  const database = deps.db ?? (await import("@connect/db")).db;
  const env = deps.env ?? process.env;
  const urls = [...turnUrlsFromEnv(env), ...(await turnUrlsFromDb(database))];
  const targets = parseTurnUrls(urls);
  if (!targets.length) {
    // ⛔ Loud, not silent: a monitor that cannot find its target must say so,
    // or "no alerts" is indistinguishable from "all healthy".
    log?.warn?.({}, "[TURN_HEALTH] no TURN urls found in env or TurnConfig — not monitoring");
    return { state: "unknown", alerted: false, skipped: "no_target" };
  }

  const probe = await (deps.probe ? deps.probe(targets) : probeTurn(targets));
  const host = targets[0]?.host ?? "unknown";
  const state = classifyTurnProbe(probe);
  const last = await readLastState(database);
  const streak = state === "ok" ? 0 : (last && last.state !== "ok" ? last.streak + 1 : 1);
  const decision = decideTurnAlert({ state, streak, alreadyAlerted: Boolean(last?.alerted) });

  let alerted = Boolean(last?.alerted);
  if (decision.action === "alert") {
    const sent = await raiseTurnEscalation(
      database,
      decision.key,
      `${decision.summary} — ${host}`,
      buildTurnAlertSms(state, probe, host),
      buildTurnAlertReport(state, probe, host),
      "Check coturn on loopcom (systemctl status coturn) and the ufw rules for 3478/5349.",
    ).catch((e: any) => { log?.error?.({ err: e?.message }, "[TURN_HEALTH] escalation write failed"); return false; });
    if (sent) alerted = true;
    log?.error?.({ state, streak, host: host }, "[TURN_HEALTH] TURN unhealthy — escalation raised");
  } else if (decision.action === "recovered") {
    await raiseTurnEscalation(
      database,
      "TURN server is back",
      `TURN server is back — ${host}`,
      `Connect alert: the TURN server (${host}) is answering again. Relayed calls should work.`,
      `ISSUE\nThe TURN relay recovered.\n\nFINDINGS\n  all probes OK on ${host}\n\nPROPOSED FIX\nNothing to do — this is the all-clear.`,
      "None — informational.",
    ).catch(() => false);
    alerted = false;
    log?.info?.({ host: host }, "[TURN_HEALTH] TURN recovered");
  }

  // ⛔ Always record, including healthy checks: the heartbeat is what proves
  // the monitor itself is alive, and the streak/alerted flags must survive the
  // next restart.
  await database.agentAuditLog.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      event: AUDIT_EVENT,
      payload: {
        state,
        streak,
        alerted,
        host: host,
        certDaysLeft: probe.certDaysLeft,
        results: [...probe.udp, ...probe.tcp, ...probe.tls].map((r) => ({ t: r.target, ok: r.ok, d: r.detail })),
      },
    },
  }).catch(() => { /* the check must never fail on its own bookkeeping */ });

  // Certificate expiry — its own alarm, warned while there is still time.
  if (probe.certDaysLeft !== null && probe.certDaysLeft <= TURN_CERT_WARN_DAYS) {
    await raiseTurnEscalation(
      database,
      TURN_ALARM_PREFIX.certExpiring,
      `${TURN_ALARM_PREFIX.certExpiring} — ${probe.certDaysLeft} days left`,
      `Connect alert: the TURN certificate (${host}) expires in ${probe.certDaysLeft} days. TURNS calls will fail when it does.`,
      `ISSUE\nThe TURN TLS certificate expires in ${probe.certDaysLeft} days.\n\nFINDINGS\n  subject: ${probe.certSubject ?? "?"}\n  host: ${host}\n\nPROPOSED FIX\nRenew it (certbot) and restart coturn so it picks the new cert up.`,
      "Renew the certificate and restart coturn.",
    ).catch(() => false);
  }

  return { state, alerted };
}

export function startTurnHealthWatch(log?: any): NodeJS.Timeout | null {
  if (DISABLED()) {
    log?.warn?.({}, "[TURN_HEALTH] disabled by TURN_HEALTH_WATCH_DISABLED=1");
    return null;
  }
  // ⛔ A boot check as well as the interval: on a heavy deploy day a timer
  // alone can be reset before it ever fires (the yiddishLabs lesson).
  const first = setTimeout(() => { void runTurnHealthCheck({}, log); }, BOOT_CHECK_DELAY_MS) as unknown as NodeJS.Timeout;
  (first as any).unref?.();
  const timer = setInterval(() => { void runTurnHealthCheck({}, log); }, TURN_CHECK_INTERVAL_MS) as unknown as NodeJS.Timeout;
  (timer as any).unref?.();
  log?.info?.({ intervalMs: TURN_CHECK_INTERVAL_MS, downStreak: TURN_DOWN_STREAK }, "TURN_HEALTH_WATCH_ARMED");
  return timer;
}
