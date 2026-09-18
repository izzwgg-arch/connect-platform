"use client";
/**
 * Yiddish Learning Engine — Pipeline monitor (2026-09-18).
 *
 *  GET /admin/yiddish/pipeline   (owner-only; polled every 5s)
 *
 * Izzy: "I want to see everything, exactly where the agent is up to,
 * progress, what it's doing now." Labelling, training-clip building and the
 * fine-tune all run off the server — the owner's PC and Kaggle — so this page
 * is a read-only mirror of whatever `/admin/yiddish/pipeline` last recorded.
 * Nothing here is computed in the browser; a stale or empty answer is shown
 * as exactly that.
 *
 * ⛔ Same rules as every other screen in this section: real data only (a
 * failed or unbuilt route says so, never a placeholder number); governance
 * stays visible per source; no Yiddish text is authored here.
 *
 * Refreshes every 5 seconds, and — same pattern as the "Now listening" panel
 * on the Yiddish24 page — does not poll while the tab is hidden; it catches
 * up the moment the tab is shown again.
 */
import { useEffect, useState } from "react";
import { apiGet } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  Card,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  Kpi,
  LoadingCard,
  OwnerOnlyNotice,
  PageHead,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  fmtDateTime,
  hours,
  money,
  num,
  titleCase,
} from "../YiddishUi";

/* ═══════════════════ contract mirror: GET /admin/yiddish/pipeline ═══════════════════ */

type StageRow = { stage: string; state: string; count: number };

type CorpusView = {
  itemsByState: { state: string; count: number }[];
  audioAssets: number;
  audioHours: number;
  transcripts: number;
  transcriptsTimed: number;
  segments: number;
  lexemes: number;
  observations: number;
  rules: number;
  findings: number;
};

type SourceRow = {
  key: string;
  governanceClass: string;
  contentAllowed: boolean;
  audioFetchMode: string;
  trainingExportEligibility: string;
  hasTrainingGrant: boolean;
  items: number;
  unlabelled: number;
};

type BudgetRow = {
  scope: string;
  paused: boolean;
  mode: string;
  apiCentsPerDay: number;
  transcriptionMinutesPerDay: number;
  spentCentsToday: number;
  transcribedMinutesToday: number;
};

type ProcessProgress = { current: number; total: number; unit: string; pct: number } | null;

type ProcessRow = {
  key: string;
  kind: string;
  status: string;
  headline: string;
  progress: ProcessProgress;
  detail: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

type RecentRow = {
  stage: string;
  state: string;
  sourceKey: string | null;
  error: string | null;
  updatedAt: string | null;
};

type PipelineView = {
  checkedAt: string;
  stages: StageRow[];
  corpus: CorpusView;
  sources: SourceRow[];
  budgets: BudgetRow[];
  spend: { today: { minutes: number; cents: number }; allTime: { minutes: number; cents: number } };
  worker: { alive: boolean; lastSeenAt: string | null };
  processes: ProcessRow[];
  recent: RecentRow[];
};

/* ═══════════════════ helpers ═══════════════════ */

const POLL_MS = 5_000;
const STALE_AFTER_SEC = 300; // 5 minutes

function agoText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return fmtDateTime(iso);
}

function isStale(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return secs > STALE_AFTER_SEC;
}

function stateTone(state: string): string {
  switch (String(state || "").toUpperCase()) {
    case "DONE":
      return "ok";
    case "RUNNING":
      return "info";
    case "FAILED":
      return "bad";
    case "SKIPPED":
      return "dim";
    case "PENDING":
      return "warn";
    default:
      return "dim";
  }
}

const STATUS_TONE: Record<string, string> = { running: "ok", idle: "dim", done: "info", error: "bad" };
const STAGE_STATE_ORDER = ["DONE", "RUNNING", "PENDING", "SKIPPED", "FAILED"];

/**
 * Polls `/admin/yiddish/pipeline` every 5s. Same "don't poll while hidden"
 * shape as the Yiddish24 "Now listening" panel — a hidden tab pauses the
 * timer and catches up the moment it is shown again.
 */
function usePipeline() {
  const [data, setData] = useState<PipelineView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(load, POLL_MS);
        return;
      }
      try {
        const out = await apiGet<PipelineView>(`${YC_API_PREFIX}/pipeline`);
        if (!live) return;
        setData(out);
        setError(null);
      } catch (e) {
        if (!live) return;
        setError(e);
      } finally {
        if (live) {
          setLoading(false);
          timer = setTimeout(load, POLL_MS);
        }
      }
    };
    void load();
    const onShow = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const reload = () => setNonce((n) => n + 1);
  return { data, error, loading, reload };
}

/* ═══════════════════ page ═══════════════════ */

export default function PipelinePage() {
  const { role } = useAppContext();
  const { data: view, error, loading, reload } = usePipeline();

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Pipeline" />;

  return (
    <YiddishPage>
      <PageHead
        title="Pipeline"
        subtitle="Everything, exactly where the agent is up to. Labelling, clip building and the fine-tune all run off the server — this mirrors exactly what it last reported, refreshed every 5 seconds."
        actions={
          <>
            {view ? (
              <span className="small dimtx" style={{ marginRight: 4 }}>
                Checked {agoText(view.checkedAt)}
                {error ? (
                  <span className="pill warn" style={{ marginLeft: 8 }}>
                    Last refresh failed — showing the previous answer
                  </span>
                ) : null}
              </span>
            ) : null}
            <button className="lbtn sm" onClick={reload}>
              Refresh
            </button>
          </>
        }
      />

      {loading && view == null ? (
        <LoadingCard rows={6} label="Loading the pipeline" />
      ) : error && view == null ? (
        <ErrorCard error={error} what="The pipeline" onRetry={reload} />
      ) : view == null ? (
        <ErrorCard error={new Error("The server returned no body.")} what="The pipeline" onRetry={reload} />
      ) : (
        <>
          <WorkerBanner worker={view.worker} />
          <ProcessesSection processes={view.processes} />
          <CorpusSection corpus={view.corpus} />
          <StagesMatrix stages={view.stages} />
          <SourcesSection sources={view.sources} />
          <SpendBudgetsSection spend={view.spend} budgets={view.budgets} />
          <RecentSection recent={view.recent} />
        </>
      )}
    </YiddishPage>
  );
}

/* ═══════════════════ sections ═══════════════════ */

function WorkerBanner({ worker }: { worker: PipelineView["worker"] }) {
  return (
    <div className={`banner ${worker.alive ? "info" : "bad"}`}>
      <span>{worker.alive ? "●" : "⛔"}</span>
      <div>
        <b>{worker.alive ? "Worker is alive" : "Worker is not ticking"}</b>
        <div className="sub">Last seen {agoText(worker.lastSeenAt)}</div>
      </div>
    </div>
  );
}

function ProcessCard({ p }: { p: ProcessRow }) {
  const stale = isStale(p.updatedAt);
  const tone = STATUS_TONE[String(p.status || "").toLowerCase()] ?? "dim";
  const isError = String(p.status || "").toLowerCase() === "error";
  const pct = p.progress ? Math.max(0, Math.min(100, Number(p.progress.pct) || 0)) : 0;
  return (
    <div className="linecard" style={{ cursor: "default" }}>
      <div className="top">
        <div>
          <b>{titleCase(p.key)}</b>
          <div className="who">{titleCase(p.kind)}</div>
        </div>
        <span className="row" style={{ gap: 6 }}>
          <span className={`pill ${tone}`}>{titleCase(p.status)}</span>
          <span className={`pill ${stale ? "warn" : "ok"}`} title={p.updatedAt ?? undefined}>
            {stale ? "Stale" : "Live"}
          </span>
        </span>
      </div>
      <div className="small">{p.headline || "No headline reported."}</div>
      {p.progress ? (
        <div>
          <div className="progress" style={{ marginBottom: 4 }}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="small dimtx">
            {num(p.progress.current)} / {num(p.progress.total)} {p.progress.unit} · {Math.round(pct)}%
          </div>
        </div>
      ) : (
        <div className="small dimtx">No progress reported for this process.</div>
      )}
      {p.detail && !isError ? <div className="small dimtx">{p.detail}</div> : null}
      {isError ? (
        <div className="small" style={{ color: "var(--danger)" }}>
          ⛔ {p.detail || "The process reported an error with no message."}
        </div>
      ) : null}
      <div className="small dimtx">
        Started {agoText(p.startedAt)} · Updated {agoText(p.updatedAt)}
      </div>
    </div>
  );
}

function ProcessesSection({ processes }: { processes: ProcessRow[] }) {
  return (
    <Card
      title="What it's doing now"
      sub="Every active loop — labelling, clip building, the fine-tune run, the PC runner — as the server last recorded it."
    >
      {processes.length === 0 ? (
        <EmptyState
          title="No active processes reported"
          text="The engine returned an empty process list. Nothing is running right now, or nothing has checked in yet — this is the server's own answer, not a gap in this page."
        />
      ) : (
        <div className="g2">
          {processes.map((p) => (
            <ProcessCard key={p.key} p={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CorpusSection({ corpus }: { corpus: CorpusView }) {
  return (
    <Card title="Corpus" sub="What has been captured so far. Transcripts and hours labelled are the numbers that grow.">
      <div className="kpis k3">
        <Kpi label="Hours labelled" value={hours(corpus.audioHours)} sub={`${num(corpus.audioAssets)} audio assets`} />
        <Kpi label="Transcripts" value={num(corpus.transcripts)} sub={`${num(corpus.transcriptsTimed)} time-aligned`} />
        <Kpi label="Segments" value={num(corpus.segments)} />
      </div>
      <div className="kpis k5">
        <Kpi label="Lexemes" value={num(corpus.lexemes)} />
        <Kpi label="Observations" value={num(corpus.observations)} />
        <Kpi label="Rules" value={num(corpus.rules)} />
        <Kpi label="Findings" value={num(corpus.findings)} />
        <Kpi label="Audio assets" value={num(corpus.audioAssets)} />
      </div>
      <div className="seclbl">Items by state</div>
      {corpus.itemsByState.length === 0 ? (
        <EmptyState title="No item states reported" text="The engine returned no item-state breakdown." />
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>State</th>
                <th className="num">Items</th>
              </tr>
            </thead>
            <tbody>
              {corpus.itemsByState.map((s) => (
                <tr key={s.state}>
                  <td>{titleCase(s.state)}</td>
                  <td className="num">{num(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function StagesMatrix({ stages }: { stages: StageRow[] }) {
  if (stages.length === 0) {
    return (
      <Card title="Pipeline stages" sub="Where work is queued, running or stuck.">
        <EmptyState title="No stage counts reported" text="The engine returned no stage/state breakdown." />
      </Card>
    );
  }
  const stageNames = Array.from(new Set(stages.map((s) => s.stage)));
  const stateNames = Array.from(new Set([...STAGE_STATE_ORDER, ...stages.map((s) => s.state)]));
  const byKey = new Map<string, number>();
  for (const s of stages) byKey.set(`${s.stage}\u0000${s.state}`, s.count);
  const hasFailed = stages.some((s) => s.state === "FAILED" && s.count > 0);

  return (
    <Card
      title="Pipeline stages"
      sub="Where work is queued, running or stuck, by stage."
      right={hasFailed ? <span className="pill bad">Failures present</span> : <span className="pill ok">No failures</span>}
    >
      <TableWrap>
        <table className="t">
          <thead>
            <tr>
              <th>Stage</th>
              {stateNames.map((st) => (
                <th key={st} className="num">
                  {titleCase(st)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stageNames.map((stage) => (
              <tr key={stage}>
                <td>{titleCase(stage)}</td>
                {stateNames.map((st) => {
                  const count = byKey.get(`${stage}\u0000${st}`) ?? 0;
                  return (
                    <td key={st} className="num">
                      {count > 0 ? <span className={`pill ${stateTone(st)}`}>{num(count)}</span> : <span className="dimtx">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

function SourcesSection({ sources }: { sources: SourceRow[] }) {
  return (
    <Card title="Sources" sub="Governance and labelling backlog, per source.">
      {sources.length === 0 ? (
        <EmptyState title="No sources reported" text="The engine returned no sources." />
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>Source</th>
                <th>Governance</th>
                <th>Training</th>
                <th>Audio fetch</th>
                <th>Training grant</th>
                <th className="num">Items</th>
                <th className="num">Unlabelled</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key}>
                  <td className="mono small">{s.key}</td>
                  <td>
                    <GovernanceChip value={s.governanceClass} />
                  </td>
                  <td>
                    <EligibilityChip value={s.trainingExportEligibility} />
                  </td>
                  <td>
                    <span className={`pill ${s.audioFetchMode === "OWNER_AUTHORIZED" ? "ok" : "dim"}`}>{titleCase(s.audioFetchMode)}</span>
                    {!s.contentAllowed ? (
                      <span className="pill bad" style={{ marginLeft: 6 }}>
                        Content walled
                      </span>
                    ) : null}
                  </td>
                  <td>{s.hasTrainingGrant ? <span className="pill ok">Granted</span> : <span className="pill dim">None</span>}</td>
                  <td className="num">{num(s.items)}</td>
                  <td className="num">{num(s.unlabelled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function SpendBudgetsSection({ spend, budgets }: { spend: PipelineView["spend"]; budgets: BudgetRow[] }) {
  return (
    <Card title="Spend & budgets" sub="Today's usage against every scope's caps. Zero is shown as zero, never a dash.">
      <div className="kpis k3">
        <Kpi label="Spent today" value={money(spend.today.cents)} sub={`${num(spend.today.minutes)} transcription min`} />
        <Kpi label="Spent all time" value={money(spend.allTime.cents)} sub={`${num(spend.allTime.minutes)} transcription min`} />
        <Kpi label="Budgets configured" value={num(budgets.length)} />
      </div>
      {budgets.length === 0 ? (
        <EmptyState title="No budgets reported" text="The engine returned no budget rows." />
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Mode</th>
                <th>State</th>
                <th className="num">API cap/day</th>
                <th className="num">Transcription cap/day</th>
                <th className="num">Spent today</th>
                <th className="num">Transcribed today</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr key={b.scope}>
                  <td>{titleCase(b.scope)}</td>
                  <td>{titleCase(b.mode)}</td>
                  <td>{b.paused ? <span className="pill bad">Paused</span> : <span className="pill ok">Running</span>}</td>
                  <td className="num">{money(b.apiCentsPerDay)}</td>
                  <td className="num">{num(b.transcriptionMinutesPerDay)} min</td>
                  <td className="num">{money(b.spentCentsToday)}</td>
                  <td className="num">{num(b.transcribedMinutesToday)} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function RecentSection({ recent }: { recent: RecentRow[] }) {
  return (
    <Card title="Recent activity" sub="The last things the engine touched.">
      {recent.length === 0 ? (
        <EmptyState title="Nothing recent" text="The engine returned no recent activity rows." />
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>Stage</th>
                <th>State</th>
                <th>Source</th>
                <th>Error</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.stage}-${r.sourceKey ?? ""}-${r.updatedAt ?? ""}-${i}`}>
                  <td>{titleCase(r.stage)}</td>
                  <td>
                    <span className={`pill ${stateTone(r.state)}`}>{titleCase(r.state)}</span>
                  </td>
                  <td className="mono small">{r.sourceKey ?? "—"}</td>
                  <td className="small" style={r.error ? { color: "var(--danger)" } : undefined}>
                    {r.error ?? "—"}
                  </td>
                  <td className="small dimtx">{agoText(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}
