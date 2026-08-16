import { connectOmbutelMysql } from "./pbxQueueDirectory";

/**
 * Queue history and reporting, read from `asterisk.queues_log` on the PBX.
 *
 * ── Five traps this module exists to encapsulate ──────────────────────────
 *
 * 1. ⛔ QUEUE NAMING. A queue is `750` in Ombutel and `T8_Q750` in the log.
 *    Callers pass `logName` from `pbxQueueDirectory` — never a bare extension.
 *    Querying by the bare number returns zero rows and reads like "no history".
 *
 * 2. ⛔ THE DATA COLUMNS ARE VARCHAR. `max(data1)` string-compares, so an
 *    abandon "max wait" once came back *below* its own average. Every numeric
 *    read here goes through CAST(... AS UNSIGNED).
 *
 * 3. ⛔ FIELD MEANING IS PER-EVENT, and the columns are reused:
 *      ENTERQUEUE       data2 = caller number, data3 = entry position
 *      CONNECT          data1 = holdtime,      data3 = agent ring time
 *      COMPLETECALLER   data1 = holdtime,      data2 = talktime, data3 = position
 *      COMPLETEAGENT    (same as COMPLETECALLER)
 *      ABANDON          data1 = position,      data2 = origposition, data3 = WAITTIME
 *      EXITWITHTIMEOUT  data1 = position
 *      EXITWITHKEY      data1 = key pressed,   data2 = position
 *      RINGNOANSWER     data1 = ring time (ms)
 *    Reading data1 as "wait" on an ABANDON row is the classic wrong answer.
 *
 * 4. ⛔ TIME. `time` is a **varchar in UTC**; `created` is a real timestamp in
 *    **server local time (EDT)** — proven exactly 240 minutes apart on live
 *    rows. We filter and group on `created`, because that is the clock the
 *    customer actually thinks in. NEVER mix the two in one expression.
 *
 * 5. ⛔ RINGNOANSWER IS NOT A FAULT COUNT. Under `ringall` every member who
 *    didn't win the race logs one, every round — 20,112 of them against 1,880
 *    answered calls on Gesheft's Phone Orders. Surfacing it as "missed calls"
 *    would be a fabricated accusation against every agent. It is reported only
 *    as `ringNoAnswer`, explicitly labelled, and never as a per-agent failure.
 *
 * ── Access ────────────────────────────────────────────────────────────────
 * Connect's PBX user (`connect_read`) is granted SELECT on `ombutel` only.
 * `queues_log` lives in the `asterisk` schema, so until a grant is added every
 * query here fails with an access error. That is detected and reported as the
 * distinct, actionable `queue_log_access_denied` rather than a generic failure,
 * so the UI can say precisely what is missing instead of showing empty charts
 * that look like "this customer has no calls".
 */

export const QUEUE_LOG_TABLE = "asterisk.queues_log";

/** Default service-level target. VitalPBX leaves `servicelevel` NULL on every
 *  queue we have, so a target has to come from somewhere — but the report
 *  always states which target it used so it is never mistaken for the
 *  customer's own configured SLA. */
export const DEFAULT_SERVICE_LEVEL_SEC = 20;

export type QueueStatsSkip =
  | { code: "queue_log_access_denied"; detail: string }
  | { code: "pbx_unavailable"; detail: string }
  | { code: "no_queues"; detail: string };

export type OutcomeCounts = {
  offered: number;
  answered: number;
  abandoned: number;
  timedOut: number;
  exitedWithKey: number;
  /** Structural under ringall — see trap 5. Never a per-agent fault count. */
  ringNoAnswer: number;
  answeredPct: number | null;
  abandonedPct: number | null;
  timedOutPct: number | null;
};

export type WaitBucket = { label: string; upToSec: number | null; count: number };

export type QueueReport = {
  logName: string;
  extension: string;
  name: string;
  outcomes: OutcomeCounts;
  avgWaitSec: number | null;
  maxWaitSec: number | null;
  avgTalkSec: number | null;
  maxTalkSec: number | null;
  totalTalkSec: number;
  avgAbandonWaitSec: number | null;
  maxAbandonWaitSec: number | null;
  /** % of answered calls picked up within `serviceLevelTargetSec`. */
  serviceLevelPct: number | null;
  serviceLevelTargetSec: number;
  /** Whether the target came from the queue's own config or our default. */
  serviceLevelTargetSource: "queue_config" | "default";
  answeredWaitBuckets: WaitBucket[];
  abandonWaitBuckets: WaitBucket[];
};

export type AgentReport = {
  agent: string;
  logName: string;
  callsTaken: number;
  avgTalkSec: number | null;
  maxTalkSec: number | null;
  totalTalkSec: number;
  /** Average time the caller had already waited before this agent answered. */
  avgCallerWaitSec: number | null;
  /** Share of this queue's answered calls, 0–100. */
  sharePct: number | null;
  lastCallAt: string | null;
};

export type TimeBucketRow = { bucket: string; offered: number; answered: number; abandoned: number };

export type QueueStatsResult =
  | {
      ok: true;
      rangeStart: string;
      rangeEnd: string;
      queues: QueueReport[];
      agents: AgentReport[];
      byHour: TimeBucketRow[];
      byDate: TimeBucketRow[];
      byWeekday: TimeBucketRow[];
      /** Agents configured on a queue that answered nothing in the window. */
      idleMembers: Array<{ logName: string; extension: string; name: string | null }>;
    }
  | { ok: false; skip: QueueStatsSkip };

type DbRow = Record<string, unknown>;

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const nOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/**
 * Is this MySQL error the missing GRANT rather than a real fault? Detected by
 * driver error code first and message shape second, because the message text
 * varies between MariaDB versions.
 */
function isAccessDenied(e: any): boolean {
  const code = String(e?.code || "");
  if (code === "ER_TABLEACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_ACCESS_DENIED_ERROR") {
    return true;
  }
  const msg = String(e?.message || "").toLowerCase();
  return msg.includes("access denied") || msg.includes("command denied");
}

/**
 * Agents arrive as bare extensions (`102`) on this PBX, but Asterisk can also
 * write `Local/102@from-queue/n` or `PJSIP/T8_102`. Normalise so a future
 * dialplan change doesn't silently split one agent into three rows.
 */
export function normalizeAgent(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^(Local|PJSIP|SIP|IAX2)\//i, "");
  s = s.split("@")[0] ?? s;
  s = s.replace(/\/n$/i, "");
  s = s.replace(/-[0-9a-f]{6,}$/i, "");
  s = s.replace(/^T\d+_/i, ""); // T8_102 → 102
  return s.trim();
}

const ANSWERED_EVENTS = ["COMPLETECALLER", "COMPLETEAGENT"];

/** Bucket edges in seconds; `null` upper bound = the overflow bucket. */
const BUCKET_EDGES: Array<{ label: string; upToSec: number | null }> = [
  { label: "0–10s", upToSec: 10 },
  { label: "11–30s", upToSec: 30 },
  { label: "31–60s", upToSec: 60 },
  { label: "1–2m", upToSec: 120 },
  { label: "2–5m", upToSec: 300 },
  { label: "over 5m", upToSec: null },
];

/** SQL CASE that maps a casted seconds expression onto BUCKET_EDGES labels. */
function bucketCase(expr: string): string {
  const parts: string[] = [];
  for (const b of BUCKET_EDGES) {
    if (b.upToSec == null) continue;
    parts.push(`WHEN ${expr} <= ${b.upToSec} THEN '${b.label}'`);
  }
  return `CASE ${parts.join(" ")} ELSE '${BUCKET_EDGES[BUCKET_EDGES.length - 1]!.label}' END`;
}

function emptyBuckets(): WaitBucket[] {
  return BUCKET_EDGES.map((b) => ({ label: b.label, upToSec: b.upToSec, count: 0 }));
}

/**
 * The reporting window.
 *
 * ⛔ Deliberately NOT a pair of JS Dates. `created` is stamped in the PBX
 * server's local clock (EDT today, EST in winter), so converting a JS Date to
 * a SQL string means guessing that offset — and guessing it wrong shifts every
 * report by four hours without anything looking broken. Both forms below are
 * evaluated by MySQL against its OWN clock, the same clock that wrote the row,
 * so no conversion happens anywhere and there is nothing to get wrong.
 */
export type QueueStatsRange =
  | { kind: "lastDays"; days: number }
  /** `YYYY-MM-DD`, inclusive start, inclusive end — read in PBX local time. */
  | { kind: "dates"; startDate: string; endDate: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadQueueStats(params: {
  ombuMysqlUrlEncrypted: string | null | undefined;
  /** Queues to report on, from pbxQueueDirectory (carries logName + config). */
  queues: Array<{ logName: string; extension: string; name: string; serviceLevelSec: number | null; members: Array<{ extension: string; name: string | null }> }>;
  range: QueueStatsRange;
  serviceLevelTargetSec?: number;
}): Promise<QueueStatsResult> {
  const { ombuMysqlUrlEncrypted, queues, range } = params;
  if (queues.length === 0) return { ok: false, skip: { code: "no_queues", detail: "tenant has no queues" } };

  // Build the date predicate against MySQL's clock. `lastDays` uses NOW();
  // `dates` passes the day strings straight through (end is + 1 day so the
  // final day is included in full rather than cut off at midnight).
  let dateWhere: string;
  let dateArgs: any[];
  if (range.kind === "lastDays") {
    const days = Math.max(1, Math.min(366, Math.floor(range.days)));
    dateWhere = "created >= DATE_SUB(NOW(), INTERVAL ? DAY) AND created < DATE_ADD(NOW(), INTERVAL 1 DAY)";
    dateArgs = [days];
  } else {
    if (!DATE_RE.test(range.startDate) || !DATE_RE.test(range.endDate)) {
      return { ok: false, skip: { code: "pbx_unavailable", detail: "range dates must be YYYY-MM-DD" } };
    }
    dateWhere = "created >= ? AND created < DATE_ADD(?, INTERVAL 1 DAY)";
    dateArgs = [range.startDate, range.endDate];
  }

  const logNames = queues.map((q) => q.logName);
  const placeholders = logNames.map(() => "?").join(",");
  // queuename is indexed, created is not — so the queue filter leads and the
  // date range narrows what's left. On 169k rows this is comfortably fast.
  const scope = `queuename IN (${placeholders}) AND ${dateWhere}`;
  const scopeArgs = [...logNames, ...dateArgs];

  const c = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!c.ok) return { ok: false, skip: { code: "pbx_unavailable", detail: c.skipReason } };
  const { conn } = c;

  try {
    // 1. Outcome counts per queue per event.
    const [outcomeRows] = (await conn.query(
      `SELECT queuename, event, COUNT(*) AS c
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope}
        GROUP BY queuename, event`,
      scopeArgs,
    )) as [DbRow[], unknown];

    // 2. Wait + talk on answered calls. data1 = holdtime, data2 = talktime.
    const [answeredRows] = (await conn.query(
      `SELECT queuename,
              COUNT(*) AS c,
              AVG(CAST(data1 AS UNSIGNED)) AS avg_wait,
              MAX(CAST(data1 AS UNSIGNED)) AS max_wait,
              AVG(CAST(data2 AS UNSIGNED)) AS avg_talk,
              MAX(CAST(data2 AS UNSIGNED)) AS max_talk,
              SUM(CAST(data2 AS UNSIGNED)) AS total_talk
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope} AND event IN (?, ?)
        GROUP BY queuename`,
      [...scopeArgs, ...ANSWERED_EVENTS],
    )) as [DbRow[], unknown];

    // 3. Abandon wait. ⛔ data3, NOT data1 — data1 is the queue position.
    const [abandonRows] = (await conn.query(
      `SELECT queuename,
              COUNT(*) AS c,
              AVG(CAST(data3 AS UNSIGNED)) AS avg_wait,
              MAX(CAST(data3 AS UNSIGNED)) AS max_wait
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope} AND event = 'ABANDON'
        GROUP BY queuename`,
      scopeArgs,
    )) as [DbRow[], unknown];

    // 4. Service level — answered within target.
    const targets = new Map<string, { sec: number; source: "queue_config" | "default" }>();
    for (const q of queues) {
      const configured = q.serviceLevelSec && q.serviceLevelSec > 0 ? q.serviceLevelSec : null;
      targets.set(q.logName, configured
        ? { sec: configured, source: "queue_config" }
        : { sec: params.serviceLevelTargetSec ?? DEFAULT_SERVICE_LEVEL_SEC, source: "default" });
    }
    const slRows: DbRow[] = [];
    for (const [logName, t] of targets) {
      const [rows] = (await conn.query(
        `SELECT ? AS queuename,
                SUM(CASE WHEN CAST(data1 AS UNSIGNED) <= ? THEN 1 ELSE 0 END) AS within,
                COUNT(*) AS total
           FROM ${QUEUE_LOG_TABLE}
          WHERE queuename = ? AND ${dateWhere} AND event IN (?, ?)`,
        [logName, t.sec, logName, ...dateArgs, ...ANSWERED_EVENTS],
      )) as [DbRow[], unknown];
      if ((rows as DbRow[])[0]) slRows.push((rows as DbRow[])[0]!);
    }

    // 5. Wait distribution — answered (data1) and abandoned (data3).
    const [answeredBucketRows] = (await conn.query(
      `SELECT queuename, ${bucketCase("CAST(data1 AS UNSIGNED)")} AS bucket, COUNT(*) AS c
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope} AND event IN (?, ?)
        GROUP BY queuename, bucket`,
      [...scopeArgs, ...ANSWERED_EVENTS],
    )) as [DbRow[], unknown];

    const [abandonBucketRows] = (await conn.query(
      `SELECT queuename, ${bucketCase("CAST(data3 AS UNSIGNED)")} AS bucket, COUNT(*) AS c
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope} AND event = 'ABANDON'
        GROUP BY queuename, bucket`,
      scopeArgs,
    )) as [DbRow[], unknown];

    // 6. Per agent.
    const [agentRows] = (await conn.query(
      `SELECT queuename, agent,
              COUNT(*) AS c,
              AVG(CAST(data2 AS UNSIGNED)) AS avg_talk,
              MAX(CAST(data2 AS UNSIGNED)) AS max_talk,
              SUM(CAST(data2 AS UNSIGNED)) AS total_talk,
              AVG(CAST(data1 AS UNSIGNED)) AS avg_wait,
              MAX(created) AS last_call
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope} AND event IN (?, ?)
        GROUP BY queuename, agent`,
      [...scopeArgs, ...ANSWERED_EVENTS],
    )) as [DbRow[], unknown];

    // 7-9. Time profiles. One query, three groupings derived in JS from the
    // per-hour-per-date rollup so we only scan once.
    const [timeRows] = (await conn.query(
      `SELECT DATE(created) AS d,
              HOUR(created) AS h,
              DAYOFWEEK(created) AS dow,
              SUM(CASE WHEN event = 'ENTERQUEUE' THEN 1 ELSE 0 END) AS offered,
              SUM(CASE WHEN event IN (?, ?) THEN 1 ELSE 0 END) AS answered,
              SUM(CASE WHEN event = 'ABANDON' THEN 1 ELSE 0 END) AS abandoned
         FROM ${QUEUE_LOG_TABLE}
        WHERE ${scope}
        GROUP BY d, h, dow
        ORDER BY d ASC, h ASC`,
      [...ANSWERED_EVENTS, ...scopeArgs],
    )) as [DbRow[], unknown];

    // ── Assemble ──────────────────────────────────────────────────────────
    const byQueueEvent = new Map<string, Map<string, number>>();
    for (const r of outcomeRows as DbRow[]) {
      const q = String(r.queuename);
      const m = byQueueEvent.get(q) ?? new Map<string, number>();
      m.set(String(r.event).toUpperCase(), n(r.c));
      byQueueEvent.set(q, m);
    }
    const idx = <T extends DbRow>(rows: T[]) => {
      const m = new Map<string, T>();
      for (const r of rows) m.set(String((r as any).queuename), r);
      return m;
    };
    const answeredBy = idx(answeredRows as DbRow[]);
    const abandonBy = idx(abandonRows as DbRow[]);
    const slBy = idx(slRows);

    const bucketsBy = (rows: DbRow[]) => {
      const m = new Map<string, WaitBucket[]>();
      for (const r of rows) {
        const q = String((r as any).queuename);
        const list = m.get(q) ?? emptyBuckets();
        const hit = list.find((b) => b.label === String((r as any).bucket));
        if (hit) hit.count = n((r as any).c);
        m.set(q, list);
      }
      return m;
    };
    const answeredBucketsBy = bucketsBy(answeredBucketRows as DbRow[]);
    const abandonBucketsBy = bucketsBy(abandonBucketRows as DbRow[]);

    const queueReports: QueueReport[] = queues.map((q) => {
      const ev = byQueueEvent.get(q.logName) ?? new Map<string, number>();
      const offered = ev.get("ENTERQUEUE") ?? 0;
      const answered = (ev.get("COMPLETECALLER") ?? 0) + (ev.get("COMPLETEAGENT") ?? 0);
      const abandoned = ev.get("ABANDON") ?? 0;
      const timedOut = ev.get("EXITWITHTIMEOUT") ?? 0;
      const a = answeredBy.get(q.logName);
      const ab = abandonBy.get(q.logName);
      const sl = slBy.get(q.logName);
      const t = targets.get(q.logName)!;
      const slTotal = n((sl as any)?.total);
      return {
        logName: q.logName,
        extension: q.extension,
        name: q.name,
        outcomes: {
          offered,
          answered,
          abandoned,
          timedOut,
          exitedWithKey: ev.get("EXITWITHKEY") ?? 0,
          ringNoAnswer: ev.get("RINGNOANSWER") ?? 0,
          answeredPct: pct(answered, offered),
          abandonedPct: pct(abandoned, offered),
          timedOutPct: pct(timedOut, offered),
        },
        avgWaitSec: round(nOrNull((a as any)?.avg_wait)),
        maxWaitSec: nOrNull((a as any)?.max_wait),
        avgTalkSec: round(nOrNull((a as any)?.avg_talk)),
        maxTalkSec: nOrNull((a as any)?.max_talk),
        totalTalkSec: n((a as any)?.total_talk),
        avgAbandonWaitSec: round(nOrNull((ab as any)?.avg_wait)),
        maxAbandonWaitSec: nOrNull((ab as any)?.max_wait),
        serviceLevelPct: slTotal > 0 ? pct(n((sl as any)?.within), slTotal) : null,
        serviceLevelTargetSec: t.sec,
        serviceLevelTargetSource: t.source,
        answeredWaitBuckets: answeredBucketsBy.get(q.logName) ?? emptyBuckets(),
        abandonWaitBuckets: abandonBucketsBy.get(q.logName) ?? emptyBuckets(),
      };
    });

    const answeredTotalByQueue = new Map(queueReports.map((q) => [q.logName, q.outcomes.answered]));
    const agentAgg = new Map<string, AgentReport>();
    for (const r of agentRows as DbRow[]) {
      const logName = String((r as any).queuename);
      const agent = normalizeAgent(String((r as any).agent));
      if (!agent) continue;
      const key = `${logName}::${agent}`;
      // Normalisation can collapse two raw agent strings onto one extension —
      // merge rather than overwrite, or one of them silently disappears.
      const prev = agentAgg.get(key);
      const calls = n((r as any).c) + (prev?.callsTaken ?? 0);
      const totalTalk = n((r as any).total_talk) + (prev?.totalTalkSec ?? 0);
      agentAgg.set(key, {
        agent,
        logName,
        callsTaken: calls,
        avgTalkSec: calls > 0 ? Math.round(totalTalk / calls) : null,
        maxTalkSec: Math.max(nOrNull((r as any).max_talk) ?? 0, prev?.maxTalkSec ?? 0) || null,
        totalTalkSec: totalTalk,
        avgCallerWaitSec: round(nOrNull((r as any).avg_wait)) ?? prev?.avgCallerWaitSec ?? null,
        sharePct: pct(calls, answeredTotalByQueue.get(logName) ?? 0),
        lastCallAt: (r as any).last_call ? new Date((r as any).last_call as any).toISOString() : prev?.lastCallAt ?? null,
      });
    }
    const agents = [...agentAgg.values()].sort((x, y) => y.callsTaken - x.callsTaken);

    // Configured members who answered nothing in the window. This is the
    // "member on paper only" signal — real on Gesheft (108/117/118), and it is
    // only trustworthy because it comes from configured membership, not from
    // RINGNOANSWER counts (see trap 5).
    const answeredAgents = new Set(agents.filter((a) => a.callsTaken > 0).map((a) => `${a.logName}::${a.agent}`));
    const idleMembers: Array<{ logName: string; extension: string; name: string | null }> = [];
    for (const q of queues) {
      for (const m of q.members) {
        if (!answeredAgents.has(`${q.logName}::${normalizeAgent(m.extension)}`)) {
          idleMembers.push({ logName: q.logName, extension: m.extension, name: m.name });
        }
      }
    }

    const hourAgg = new Map<number, TimeBucketRow>();
    const dateAgg = new Map<string, TimeBucketRow>();
    const dowAgg = new Map<number, TimeBucketRow>();
    const addTo = <K>(map: Map<K, TimeBucketRow>, key: K, label: string, r: DbRow) => {
      const cur = map.get(key) ?? { bucket: label, offered: 0, answered: 0, abandoned: 0 };
      cur.offered += n((r as any).offered);
      cur.answered += n((r as any).answered);
      cur.abandoned += n((r as any).abandoned);
      map.set(key, cur);
    };
    const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const r of timeRows as DbRow[]) {
      const h = n((r as any).h);
      const dow = n((r as any).dow); // MySQL DAYOFWEEK: 1 = Sunday
      const d = formatDateOnly((r as any).d);
      addTo(hourAgg, h, String(h).padStart(2, "0") + ":00", r);
      addTo(dateAgg, d, d, r);
      addTo(dowAgg, dow, WEEKDAYS[Math.max(0, Math.min(6, dow - 1))] ?? String(dow), r);
    }

    // Report the window MySQL actually used, resolved on its own clock, so the
    // UI states a real range rather than one recomputed in the browser's zone.
    let rangeStart = "";
    let rangeEnd = "";
    try {
      const [[rr]] = (await conn.query(
        range.kind === "lastDays"
          ? `SELECT DATE(DATE_SUB(NOW(), INTERVAL ? DAY)) AS s, DATE(NOW()) AS e`
          : `SELECT DATE(?) AS s, DATE(?) AS e`,
        dateArgs,
      )) as [DbRow[], unknown];
      rangeStart = formatDateOnly((rr as any)?.s);
      rangeEnd = formatDateOnly((rr as any)?.e);
    } catch {
      /* range labelling is cosmetic — never fail the report over it */
    }

    return {
      ok: true,
      rangeStart,
      rangeEnd,
      queues: queueReports,
      agents,
      byHour: [...hourAgg.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      byDate: [...dateAgg.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v),
      byWeekday: [...dowAgg.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      idleMembers,
    };
  } catch (e: any) {
    if (isAccessDenied(e)) {
      return {
        ok: false,
        skip: {
          code: "queue_log_access_denied",
          detail:
            `Connect's PBX database user cannot read ${QUEUE_LOG_TABLE}. ` +
            `It is granted SELECT on the ombutel schema only. A read-only grant on ` +
            `${QUEUE_LOG_TABLE} is required before queue history can be reported.`,
        },
      };
    }
    return { ok: false, skip: { code: "pbx_unavailable", detail: e?.message || String(e) } };
  } finally {
    await conn.end().catch(() => {});
  }
}

function round(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

function formatDateOnly(v: unknown): string {
  if (v instanceof Date) {
    const p = (x: number) => String(x).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v ?? "").slice(0, 10);
}
