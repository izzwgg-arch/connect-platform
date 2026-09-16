"use client";
/**
 * Yiddish Learning Engine — Yiddish24, source #1 (mockup screens 11–18, as
 * tabs on one route).
 *
 *  Dashboard · Episodes · Episode · Queue · Priorities · Controls ·
 *  Discoveries · Progress
 *
 * Every tab reads the same engine routes as the rest of the section:
 *  GET  /admin/yiddish/sources                  → this source's summary
 *  GET  /admin/yiddish/sources/yiddish24/items  ?state&category&series&q&limit
 *  GET  /admin/yiddish/items/:id
 *  GET  /admin/yiddish/queue  ·  /findings  ·  /progress?window
 *  POST /admin/yiddish/sources/yiddish24/run | /discover | /budget
 *
 * ⛔ THE AUDIO BANNER IS NOT DECORATION. Yiddish24's audio is hotlink
 *    protected and the site carries no terms grant, so the engine reports an
 *    `audioBlockedReason` and this page prints it verbatim at the top of every
 *    tab. Controls that need audio are DISABLED with that reason on them.
 * ⛔ No episode title, series name or duration is written here — all of it is
 *    published by the site, read by the adapter, and rendered from the API.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import {
  Card,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  Kpi,
  LoadingCard,
  Note,
  OwnerOnlyNotice,
  PageHead,
  TableWrap,
  YC_API_PREFIX,
  YIDDISH24_SOURCE_KEY,
  YiddishPage,
  YiddishText,
  errText,
  fmtDateTime,
  hours,
  listFrom,
  money,
  num,
  titleCase,
  useApi,
  type YcSourceSummary,
} from "../YiddishUi";

const TABS = [
  ["dashboard", "Source dashboard"],
  ["episodes", "Episode browser"],
  ["episode", "Episode detail"],
  ["queue", "Processing queue"],
  ["priorities", "Category priorities"],
  ["controls", "Continuous learning"],
  ["discoveries", "Discoveries"],
  ["progress", "Progress over time"],
] as const;
type TabKey = (typeof TABS)[number][0];

type Episode = {
  id: string;
  externalId?: string | null;
  title?: string | null;
  seriesName?: string | null;
  category?: string | null;
  host?: string | null;
  publishedLabel?: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  state?: string | null;
  hasTranscript?: boolean;
  audioAnalyzed?: boolean;
  noveltyScore?: number | null;
  speechShare?: number | null;
};
type ItemsResponse = {
  items?: Episode[];
  rows?: Episode[];
  total?: number;
  cursor?: string | null;
  nextCursor?: string | null;
  categories?: string[];
  series?: string[];
  stateCounts?: { state: string; count: number }[];
};

export default function Yiddish24Page() {
  const { role } = useAppContext();
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = useApi<YcSourceSummary[] | { sources: YcSourceSummary[] }>(`${YC_API_PREFIX}/sources`);
  const source = listFrom<YcSourceSummary>(sources.data, "sources").find((s) => s.key === YIDDISH24_SOURCE_KEY) ?? null;

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Yiddish24" />;

  const post = async (path: string, body: Record<string, unknown>, okText: string) => {
    setBusy(true);
    setNote(null);
    try {
      await apiPost(path, body);
      setNote({ kind: "ok", text: okText });
      sources.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The engine refused that.") });
    } finally {
      setBusy(false);
    }
  };

  const openEpisode = (id: string) => {
    setEpisodeId(id);
    setTab("episode");
  };

  return (
    <YiddishPage>
      <PageHead
        title="Yiddish24"
        subtitle="Source #1 inside the Learning Engine — an external adapter in this section, not a separate product."
        actions={<button className="lbtn sm" onClick={sources.reload}>Refresh</button>}
      />

      {sources.loading && sources.data == null ? (
        <LoadingCard rows={3} label="Loading the source" />
      ) : sources.error ? (
        <ErrorCard error={sources.error} what="The Yiddish24 source" onRetry={sources.reload} />
      ) : !source ? (
        <Card>
          <EmptyState
            title="The Yiddish24 adapter is not registered"
            text={`The engine returned no source with the key "${YIDDISH24_SOURCE_KEY}". Nothing has been discovered from this site.`}
          />
        </Card>
      ) : (
        <>
          <AudioBanner source={source} />
          <NowListening />
          <Note note={note} />

          <div className="chips">
            {TABS.map(([key, label]) => (
              <button key={key} className={`chip ${tab === key ? "on" : ""}`} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "dashboard" ? <DashboardTab source={source} /> : null}
          {tab === "episodes" ? <EpisodesTab onOpen={openEpisode} /> : null}
          {tab === "episode" ? <EpisodeTab episodeId={episodeId} onBack={() => setTab("episodes")} /> : null}
          {tab === "queue" ? <QueueTab source={source} /> : null}
          {tab === "priorities" ? <PrioritiesTab /> : null}
          {tab === "controls" ? <ControlsTab source={source} busy={busy} post={post} /> : null}
          {tab === "discoveries" ? <DiscoveriesTab /> : null}
          {tab === "progress" ? <ProgressTab /> : null}
        </>
      )}
    </YiddishPage>
  );
}

// ── Now listening ───────────────────────────────────────────────────────────
//
// Izzy: "I want to be able to hear and see at all times what the agent is
// listening to." Visible above every tab, refreshed every 5 seconds.
//
// ⛔ "Hear" opens the episode on yiddish24.com, where the site's own player
// plays it. The portal never embeds the MP3: the site's CDN refuses any page
// but its own, and the engine does not hold the audio. Music series are
// excluded by the site's own "Music" category and shown as excluded.

type NowItem = {
  id: string;
  title: string | null;
  seriesName: string | null;
  category: string | null;
  publishedLabel: string | null;
  durationSec: number | null;
  listenUrl: string | null;
  itemState: string;
  kind: "SPEECH" | "MUSIC_EXCLUDED";
  excludedReason: string | null;
  stage: string | null;
  jobState: string | null;
  jobNote: string | null;
  touchedAt: string | null;
};

type NowView = {
  checkedAt: string;
  registered: boolean;
  note?: string;
  worker?: { alive: boolean; lastTickAt: string | null };
  crawl?: {
    state: "WALKING" | "WAITING" | "PAUSED" | "STOPPED";
    seriesId: string | null;
    seriesName: string | null;
    category: string | null;
    page: number | null;
    totalPages: number | null;
    pendingSeries: number;
    completedSeries: number;
    musicSeriesExcluded: number;
    lastRunAt: string | null;
    lastRunStoppedReason: string | null;
    nextCheckAt: string | null;
    note: string;
  };
  current?: NowItem | null;
  recent?: NowItem[];
  totals?: { items: number; speechItems: number; musicExcluded: number; speechHours: number; musicHoursExcluded: number };
  audio?: { fetching: boolean; blockedReason: string | null };
  listenNote?: string;
};

const NOW_POLL_MS = 5_000;

function clock(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return fmtDateTime(iso);
}

function ListenLink({ url }: { url: string | null }) {
  if (!url) return <span className="muted small">No episode page</span>;
  return (
    <a className="lbtn sm" href={url} target="_blank" rel="noopener noreferrer" title="Plays on yiddish24.com's own player">
      ▶ Listen on Yiddish24 ↗
    </a>
  );
}

function NowListening() {
  const [view, setView] = useState<NowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMusic, setShowMusic] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      // A hidden tab does not poll; it catches up the moment it is shown.
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(load, NOW_POLL_MS);
        return;
      }
      try {
        const out = await apiGet<NowView>(`${YC_API_PREFIX}/now`);
        if (!live) return;
        setView(out);
        setError(null);
      } catch (e: any) {
        if (!live) return;
        setError(errText(e, "The live view could not be loaded."));
      } finally {
        if (live) timer = setTimeout(load, NOW_POLL_MS);
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
  }, []);

  if (!view && !error) return <LoadingCard rows={2} label="Loading what the engine is on right now" />;
  if (!view) return <ErrorCard error={new Error(error ?? "No answer")} what="The live view" />;
  if (!view.registered) {
    return (
      <Card title="Now listening">
        <EmptyState title="Not registered" text={view.note ?? "The Yiddish24 source is not registered."} />
      </Card>
    );
  }

  const crawl = view.crawl!;
  const statePill =
    crawl.state === "WALKING" ? (
      <span className="pill ok">● Walking now</span>
    ) : crawl.state === "WAITING" ? (
      <span className="pill info">Waiting</span>
    ) : crawl.state === "PAUSED" ? (
      <span className="pill warn">Paused</span>
    ) : (
      <span className="pill bad">Stopped</span>
    );
  const cur = view.current;
  const recent = (view.recent ?? []).filter((r) => showMusic || r.kind !== "MUSIC_EXCLUDED");

  return (
    <Card
      title="Now listening"
      sub={
        <>
          Live · refreshes every 5 seconds · checked {ago(view.checkedAt)}
          {error ? <span className="pill warn" style={{ marginLeft: 8 }}>Last refresh failed — showing the previous answer</span> : null}
        </>
      }
      right={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {statePill}
          <span className={`pill ${view.worker?.alive ? "ok" : "bad"}`} title={view.worker?.lastTickAt ?? undefined}>
            Worker {view.worker?.alive ? "alive" : "not ticking"}
          </span>
        </div>
      }
    >
      <div className="g2">
        <div>
          <div className="small muted">Crawl</div>
          {crawl.seriesId ? (
            <div style={{ margin: "4px 0 8px" }}>
              <b>
                <YiddishText text={crawl.seriesName ?? `Series ${crawl.seriesId}`} />
              </b>
              {crawl.category ? (
                <>
                  {" · "}
                  <YiddishText text={crawl.category} />
                </>
              ) : null}
              <div className="small muted">
                Page {num(crawl.page)}
                {crawl.totalPages ? ` of ${num(crawl.totalPages)}` : ""}
              </div>
            </div>
          ) : (
            <div className="small" style={{ margin: "4px 0 8px" }}>
              {crawl.note}
              {crawl.nextCheckAt ? <div className="muted">Next check {fmtDateTime(crawl.nextCheckAt)}</div> : null}
            </div>
          )}
          <div className="small muted">
            {num(crawl.completedSeries)} series walked · {num(crawl.pendingSeries)} queued ·{" "}
            {num(crawl.musicSeriesExcluded)} music series never walked · last run {ago(crawl.lastRunAt)}
          </div>
        </div>

        <div>
          <div className="small muted">Last episode the engine touched</div>
          {cur ? (
            <div style={{ margin: "4px 0" }}>
              <b>
                <YiddishText text={cur.title ?? "(untitled)"} />
              </b>
              <div className="small muted">
                <YiddishText text={cur.seriesName ?? ""} />
                {cur.category ? (
                  <>
                    {" · "}
                    <YiddishText text={cur.category} />
                  </>
                ) : null}
                {" · "}
                {clock(cur.durationSec)}
                {cur.publishedLabel ? (
                  <>
                    {" · "}
                    <YiddishText text={cur.publishedLabel} />
                  </>
                ) : null}
              </div>
              <div className="small" style={{ margin: "4px 0 6px" }}>
                {cur.kind === "MUSIC_EXCLUDED" ? (
                  <span className="pill dim">Music — excluded</span>
                ) : (
                  <span className="pill ok">Speech</span>
                )}{" "}
                <span className="muted">
                  {cur.stage ? `${titleCase(cur.stage)} · ${titleCase(cur.jobState ?? "")}` : ""} · {ago(cur.touchedAt)}
                </span>
              </div>
              <ListenLink url={cur.listenUrl} />
            </div>
          ) : (
            <EmptyState title="Nothing touched yet" text="The worker has not processed an episode for this source." />
          )}
        </div>
      </div>

      {view.totals ? (
        <div className="kpis k3" style={{ marginTop: 12 }}>
          <Kpi label="People talking" value={num(view.totals.speechItems)} sub={`${hours(view.totals.speechHours)} catalogued`} />
          <Kpi label="Music excluded" value={num(view.totals.musicExcluded)} sub={`${hours(view.totals.musicHoursExcluded)} never used`} />
          <Kpi label="Audio downloaded" value="0" sub="Blocked until Yiddish24 grants permission" tone="warn" />
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 6px", gap: 8, flexWrap: "wrap" }}>
        <b className="small">Recent episodes</b>
        <label className="small muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showMusic} onChange={(e) => setShowMusic(e.target.checked)} />
          Show excluded music
        </label>
      </div>
      {recent.length ? (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Episode</th>
                <th>Series</th>
                <th>Length</th>
                <th>Kind</th>
                <th>Stage</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>
                    <YiddishText text={r.title ?? "(untitled)"} />
                  </td>
                  <td>
                    <YiddishText text={r.seriesName ?? ""} />
                  </td>
                  <td className="mono">{clock(r.durationSec)}</td>
                  <td>{r.kind === "MUSIC_EXCLUDED" ? <span className="pill dim">Music</span> : <span className="pill ok">Speech</span>}</td>
                  <td className="small">
                    {r.stage ? titleCase(r.stage) : "—"}
                    {r.jobState ? <span className="muted"> · {titleCase(r.jobState)}</span> : null}
                  </td>
                  <td className="small muted">{ago(r.touchedAt)}</td>
                  <td>
                    <ListenLink url={r.listenUrl} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <EmptyState title="No recent speech episodes" text="Nothing has been processed recently, or everything recent was music." />
      )}
      {view.listenNote ? <div className="small muted" style={{ marginTop: 8 }}>{view.listenNote}</div> : null}
    </Card>
  );
}

/** Printed at the top of every tab, in the engine's own words. */
function AudioBanner({ source }: { source: YcSourceSummary }) {
  if (!source.audioBlockedReason) {
    return (
      <div className="banner info">
        <span>ℹ</span>
        <div>
          <b>Audio fetching is authorized for this source.</b>
          <div className="sub">Audio mode is {titleCase(source.audioFetchMode)}. The audio stages may run inside the budgets.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="banner bad">
      <span>⛔</span>
      <div>
        <b>No audio stage can run for Yiddish24.</b>
        <div className="sub">{source.audioBlockedReason}</div>
        <div className="sub" style={{ marginTop: 4 }}>
          <Link href="/admin/yiddish-learning/governance" className="rowlink">
            Governance
          </Link>{" "}
          is where a rights grant is recorded. We do not work around an access control.
        </div>
      </div>
    </div>
  );
}

function DashboardTab({ source }: { source: YcSourceSummary }) {
  const audioBlocked = Boolean(source.audioBlockedReason);
  return (
    <>
      <div className="kpis k3">
        <Kpi label="Items in the catalog" value={num(source.itemCount)} sub="Public metadata the adapter has recorded" />
        <Kpi label="Audio hours analyzed" value={hours(source.audioHours)} sub={audioBlocked ? "Blocked — stays 0" : undefined} tone={audioBlocked ? "warn" : undefined} />
        <Kpi label="Transcripts" value={num(source.transcriptCount)} sub={audioBlocked ? "Needs permitted audio" : undefined} tone={audioBlocked ? "warn" : undefined} />
      </div>

      <div className="g2">
        <Card title="What is possible today" right={<span className="pill ok">Metadata</span>}>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Walk the public listings and record what the site publishes.</li>
            <li>Fingerprint and de-duplicate items.</li>
            <li>Keep a catalog that can be matched against internal records at metadata level.</li>
          </ul>
        </Card>
        <Card className="wall" title="What is blocked" right={<span className="pill bad">Audio</span>}>
          {audioBlocked ? (
            <>
              <div className="small" style={{ lineHeight: 1.6 }}>{source.audioBlockedReason}</div>
              <div className="wall-note">
                Fetch-audio, segment, speaker clustering, transcription and alignment are all held at the gate. Every figure
                that needs audio stays at zero and is shown as zero.
              </div>
            </>
          ) : (
            <div className="small dimtx">Nothing is blocked — the engine reported no audio block for this source.</div>
          )}
        </Card>
      </div>

      <div className="g2" style={{ marginTop: 14 }}>
        <Card title="Governance" sub="Inherited by every record this adapter emits.">
          <div className="row" style={{ gap: 6, marginBottom: 10 }}>
            <GovernanceChip value={source.governanceClass} />
            <EligibilityChip value={source.trainingExportEligibility} />
            <span className={`pill ${source.enabled ? "ok" : "dim"}`}>{source.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <dl className="dl">
            <div>
              <dt>Adapter</dt>
              <dd className="mono small">{source.adapterKey || "—"}</dd>
            </div>
            <div>
              <dt>Terms</dt>
              <dd className="mono small">{source.termsUrl || "None published"}</dd>
            </div>
            <div>
              <dt>Terms checked</dt>
              <dd>{fmtDateTime(source.termsCheckedAt)}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{fmtDateTime(source.lastRunAt)}</dd>
            </div>
          </dl>
          {source.rightsNote ? <div className="small dimtx" style={{ marginTop: 8, lineHeight: 1.55 }}>{source.rightsNote}</div> : null}
          {(source.rights ?? []).length === 0 ? (
            <div className="small dimtx" style={{ marginTop: 8 }}>No rights record exists for this source.</div>
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Allowed use</th>
                    <th>State</th>
                    <th>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {(source.rights ?? []).map((r) => (
                    <tr key={`${r.allowedUse}-${r.decidedAt}`}>
                      <td>{titleCase(r.allowedUse)}</td>
                      <td>
                        <span className={`pill ${r.state === "GRANTED" ? "ok" : r.state === "DENIED" ? "bad" : "dim"}`}>{titleCase(r.state)}</span>
                      </td>
                      <td className="small dimtx">
                        {r.decidedBy || "—"} · {fmtDateTime(r.decidedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card
          title="Site-change detection"
          sub="The adapter reads an undocumented custom site. If an assumption breaks it must alert, never silently report zero."
        >
          {(source.health ?? []).length === 0 ? (
            <EmptyState title="No probes have run" text="The adapter has recorded no health probe results yet." />
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Parser assumption</th>
                    <th>Health</th>
                    <th>Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {(source.health ?? []).map((h) => (
                    <tr key={h.probeKey}>
                      <td>
                        {h.probeKey}
                        {h.detail ? <span className="sub">{h.detail}</span> : null}
                      </td>
                      <td>
                        <span className={`pill ${h.state === "OK" ? "ok" : h.state === "FAIL" ? "bad" : "warn"}`}>{titleCase(h.state)}</span>
                      </td>
                      <td className="small dimtx">{fmtDateTime(h.checkedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          <div className="small dimtx" style={{ marginTop: 8, lineHeight: 1.55 }}>
            A run that finds nothing is never reported as &ldquo;nothing new&rdquo; — two consecutive empty runs, or any failing
            probe, is a fault.
          </div>
        </Card>
      </div>
    </>
  );
}

function EpisodesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [series, setSeries] = useState("");
  const [state, setState] = useState("");
  const [applied, setApplied] = useState(0);

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (category) p.set("category", category);
    if (series) p.set("series", series);
    if (state) p.set("state", state);
    p.set("limit", "50");
    return `${YC_API_PREFIX}/sources/${YIDDISH24_SOURCE_KEY}/items?${p.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, series, state, applied]);

  const items = useApi<ItemsResponse>(path);
  const rows = listFrom<Episode>(items.data?.items ?? items.data?.rows ?? items.data, "items");
  const categories = items.data?.categories ?? [];
  const seriesList = items.data?.series ?? [];

  return (
    <>
      <Card title="Filter" sub="The public catalog as the adapter sees it — nothing is completed or translated by us.">
        <div className="form">
          <div className="field">
            <label htmlFor="y24-cat">Main category</label>
            <ConnectSelect
              id="y24-cat"
              value={category}
              onChange={setCategory}
              options={[{ value: "", label: categories.length ? "All categories" : "No categories reported" }, ...categories.map((c) => ({ value: c, label: c }))]}
              ariaLabel="Main category"
            />
          </div>
          <div className="field">
            <label htmlFor="y24-ser">Series</label>
            <ConnectSelect
              id="y24-ser"
              value={series}
              onChange={setSeries}
              options={[{ value: "", label: seriesList.length ? "All series" : "No series reported" }, ...seriesList.map((s) => ({ value: s, label: s }))]}
              ariaLabel="Series"
            />
          </div>
          <div className="field">
            <label htmlFor="y24-state">Processing status</label>
            <ConnectSelect
              id="y24-state"
              value={state}
              onChange={setState}
              options={[
                { value: "", label: "Any status" },
                ...["DISCOVERED", "QUEUED", "PROCESSING", "INDEXED", "LEARNED", "SKIPPED", "DUPLICATE", "FAILED"].map((s) => ({
                  value: s,
                  label: titleCase(s),
                })),
              ]}
              ariaLabel="Processing status"
            />
          </div>
          <label className="field">
            <span>Search (title or id)</span>
            <input
              className="linput"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setApplied((n) => n + 1);
              }}
            />
          </label>
        </div>
      </Card>

      <Card title="Episodes" sub={items.data?.total != null ? `${num(items.data.total)} in the catalog` : undefined}>
        {items.loading && items.data == null ? (
          <div className="skel" style={{ height: 120 }} />
        ) : items.error ? (
          <ErrorCard error={items.error} what="The episode catalog" onRetry={items.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No episodes recorded"
            text="The adapter has recorded nothing from the public catalog for these filters. Discovery has not run, or it found nothing new."
          />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Series</th>
                  <th>Episode</th>
                  <th>Host</th>
                  <th>Date (as published)</th>
                  <th className="num">Duration</th>
                  <th>Status</th>
                  <th>Transcript</th>
                  <th>Audio analyzed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{e.category || "—"}</td>
                    <td>
                      <YiddishText text={e.seriesName} />
                    </td>
                    <td>
                      <YiddishText text={e.title} />
                      <span className="sub mono">{e.externalId || e.id}</span>
                    </td>
                    <td>
                      <YiddishText text={e.host} />
                    </td>
                    <td className="small dimtx">{e.publishedLabel || (e.publishedAt ? fmtDateTime(e.publishedAt) : "—")}</td>
                    <td className="num">{e.durationSeconds == null ? "—" : `${Math.round(Number(e.durationSeconds) / 60)} min`}</td>
                    <td>
                      <span className="pill dim">{titleCase(e.state)}</span>
                    </td>
                    <td>{e.hasTranscript ? <span className="pill ok">Yes</span> : <span className="pill dim">No</span>}</td>
                    <td>{e.audioAnalyzed ? <span className="pill ok">Yes</span> : <span className="pill dim">No</span>}</td>
                    <td>
                      <button className="lbtn sm" onClick={() => onOpen(e.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

function EpisodeTab({ episodeId, onBack }: { episodeId: string | null; onBack: () => void }) {
  const detail = useApi<any>(episodeId ? `${YC_API_PREFIX}/items/${encodeURIComponent(episodeId)}` : null);

  if (!episodeId) {
    return (
      <Card>
        <EmptyState title="No episode selected" text="Open one from the Episode browser.">
          <button className="lbtn sm" onClick={onBack}>
            Episode browser
          </button>
        </EmptyState>
      </Card>
    );
  }
  if (detail.loading && detail.data == null) return <LoadingCard rows={4} label="Loading the episode" />;
  if (detail.error) return <ErrorCard error={detail.error} what="This episode" onRetry={detail.reload} />;

  const item = detail.data?.item ?? detail.data ?? {};
  const assets = detail.data?.assets ?? [];
  const transcripts = detail.data?.transcripts ?? [];
  const related = detail.data?.related ?? [];

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="lbtn sm" onClick={onBack}>
          ← Episode browser
        </button>
      </div>
      <div className="g2">
        <Card title="Metadata as published" sub="Nothing here is invented, translated or completed by us.">
          <TableWrap>
            <table className="t">
              <tbody>
                <tr>
                  <th style={{ width: 150 }}>Title</th>
                  <td>
                    <YiddishText text={item.title} />
                  </td>
                </tr>
                <tr>
                  <th>Series</th>
                  <td>
                    <YiddishText text={item.seriesName} />
                  </td>
                </tr>
                <tr>
                  <th>Category</th>
                  <td className="small">{item.category || "—"}</td>
                </tr>
                <tr>
                  <th>Host</th>
                  <td>
                    <YiddishText text={item.host} />
                  </td>
                </tr>
                <tr>
                  <th>Date</th>
                  <td className="small">{item.publishedLabel || (item.publishedAt ? fmtDateTime(item.publishedAt) : "—")}</td>
                </tr>
                <tr>
                  <th>Duration</th>
                  <td>{item.durationSeconds == null ? "—" : `${Math.round(Number(item.durationSeconds) / 60)} min`}</td>
                </tr>
                <tr>
                  <th>External id</th>
                  <td className="mono small">{item.externalId || item.id || "—"}</td>
                </tr>
                <tr>
                  <th>State</th>
                  <td>
                    <span className="pill dim">{titleCase(item.state)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </Card>

        <div className="stack">
          <Card title="Audio" right={detail.data?.audioBlockedReason ? <span className="pill bad">Blocked</span> : null}>
            {detail.data?.audioBlockedReason ? (
              <div className="small" style={{ lineHeight: 1.6 }}>
                ⛔ {detail.data.audioBlockedReason}
              </div>
            ) : assets.length === 0 ? (
              <EmptyState title="No audio asset" text="The engine holds no audio for this episode." />
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Kind</th>
                      <th>Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a: any) => (
                      <tr key={a.id}>
                        <td className="mono small">{a.id}</td>
                        <td>{titleCase(a.kind)}</td>
                        <td>{a.available === false ? <span className="pill bad">{a.blockedReason || "Not available"}</span> : <span className="pill ok">Stored</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Learning value" sub="Computed from processed audio — nothing else can produce it.">
            {transcripts.length === 0 ? (
              <EmptyState
                title="Not computable"
                text="Learning value comes from listening: pronunciation observations, speaker clusters, prosody and novel vocabulary. A title, an image and a duration cannot produce any of it."
              />
            ) : (
              <dl className="dl">
                <div>
                  <dt>Transcripts</dt>
                  <dd>{num(transcripts.length)}</dd>
                </div>
                <div>
                  <dt>Novelty score</dt>
                  <dd>{item.noveltyScore == null ? "—" : Number(item.noveltyScore).toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Speech share</dt>
                  <dd>{item.speechShare == null ? "—" : `${(Number(item.speechShare) * 100).toFixed(0)}%`}</dd>
                </div>
              </dl>
            )}
          </Card>
        </div>
      </div>

      <Card title="Related internal corpus records" sub="Metadata-level only — the site publishes no text to match on.">
        {related.length === 0 ? (
          <EmptyState title="No related records" text="Nothing internal matches this episode at metadata level." />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Internal record</th>
                  <th>Match basis</th>
                  <th>Strength</th>
                </tr>
              </thead>
              <tbody>
                {related.map((r: any) => (
                  <tr key={r.id}>
                    <td className="mono small">{r.id}</td>
                    <td className="small">{r.basis || "—"}</td>
                    <td className="small">{r.strength == null ? "—" : Number(r.strength).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

function QueueTab({ source }: { source: YcSourceSummary }) {
  const items = useApi<ItemsResponse>(`${YC_API_PREFIX}/sources/${YIDDISH24_SOURCE_KEY}/items?limit=1`);
  const queue = useApi<{ counts?: { state: string; count: number }[]; states?: { state: string; count: number }[]; failures?: any[] }>(`${YC_API_PREFIX}/queue`);
  const stateCounts = items.data?.stateCounts ?? [];
  const jobCounts = queue.data?.counts ?? queue.data?.states ?? [];
  const audioBlocked = Boolean(source.audioBlockedReason);

  return (
    <>
      <Card title="Item states for this source" sub="What the adapter has recorded, by lifecycle state.">
        {items.loading && items.data == null ? (
          <div className="skel" style={{ height: 90 }} />
        ) : items.error ? (
          <ErrorCard error={items.error} what="The source's item states" onRetry={items.reload} />
        ) : stateCounts.length === 0 ? (
          <EmptyState
            title="No per-state counts reported"
            text="The items endpoint returned no state breakdown for this source. Nothing is shown in its place."
          />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>State</th>
                  <th className="num">Items</th>
                  <th>Can run today</th>
                </tr>
              </thead>
              <tbody>
                {stateCounts.map((s) => {
                  const needsAudio = ["PROCESSING", "AUDIO_ANALYZED", "NEEDS_TRANSCRIPTION", "TRANSCRIBED", "ALIGNED"].includes(s.state);
                  return (
                    <tr key={s.state}>
                      <td>{titleCase(s.state)}</td>
                      <td className="num">{num(s.count)}</td>
                      <td>
                        {needsAudio && audioBlocked ? (
                          <span className="pill bad" title={source.audioBlockedReason ?? undefined}>
                            Needs permitted audio
                          </span>
                        ) : (
                          <span className="pill ok">Yes</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Job queue" sub="Platform-wide job counts — the engine's queue endpoint is not per source.">
        {queue.loading && queue.data == null ? (
          <div className="skel" style={{ height: 80 }} />
        ) : queue.error ? (
          <ErrorCard error={queue.error} what="The job queue" onRetry={queue.reload} />
        ) : jobCounts.length === 0 ? (
          <EmptyState title="The queue is empty" text="No job is queued, leased or failed anywhere in the engine." />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>State</th>
                  <th className="num">Jobs</th>
                </tr>
              </thead>
              <tbody>
                {jobCounts.map((q) => (
                  <tr key={q.state}>
                    <td>{titleCase(q.state)}</td>
                    <td className="num">{num(q.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

/**
 * ⛔ HONEST STUB. The engine's contract has no category-priority route, so
 *    there is nothing real to draw here and nothing is drawn. The screen says
 *    what is missing rather than showing an editable order that saves nowhere.
 */
function PrioritiesTab() {
  const items = useApi<ItemsResponse>(`${YC_API_PREFIX}/sources/${YIDDISH24_SOURCE_KEY}/items?limit=1`);
  const categories = items.data?.categories ?? [];
  return (
    <>
      <div className="banner">
        <span>⚠</span>
        <div>
          <b>Not implemented — the engine exposes no category-priority endpoint.</b>
          <div className="sub">
            Priority is an order, not a filter: nothing is deleted and nothing is permanently ignored. Until the engine can
            store and return that order, this screen shows only the categories the adapter actually reported — there is no
            control here that would save nowhere.
          </div>
        </div>
      </div>
      <Card title="Categories the adapter reported">
        {items.loading && items.data == null ? (
          <div className="skel" style={{ height: 70 }} />
        ) : items.error ? (
          <ErrorCard error={items.error} what="The category list" onRetry={items.reload} />
        ) : categories.length === 0 ? (
          <EmptyState title="No categories reported" text="The items endpoint returned no category facet for this source." />
        ) : (
          <div className="chips" style={{ marginBottom: 0 }}>
            {categories.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function ControlsTab({
  source,
  busy,
  post,
}: {
  source: YcSourceSummary;
  busy: boolean;
  post: (path: string, body: Record<string, unknown>, okText: string) => Promise<void>;
}) {
  const base = `${YC_API_PREFIX}/sources/${YIDDISH24_SOURCE_KEY}`;
  const audioBlocked = Boolean(source.audioBlockedReason);
  const [limits, setLimits] = useState({
    requestsPerMinute: String(source.budget?.requestsPerMinute ?? ""),
    concurrency: String(source.budget?.concurrency ?? ""),
    transcriptionMinutesPerDay: String(source.budget?.transcriptionMinutesPerDay ?? ""),
    apiCentsPerDay: String(source.budget?.apiCentsPerDay ?? ""),
  });

  return (
    <div className="g2">
      <Card title="Run" sub="Starting walks the public listings and records metadata only. No audio is fetched.">
        <div className="row">
          <button className="lbtn primary" disabled={busy || !source.enabled} onClick={() => void post(`${base}/run`, { action: "start" }, "Run started — metadata only.")}>
            Start
          </button>
          <button className="lbtn" disabled={busy} onClick={() => void post(`${base}/run`, { action: "pause" }, "Run paused.")}>
            Pause
          </button>
          <button className="lbtn" disabled={busy} onClick={() => void post(`${base}/run`, { action: "resume" }, "Run resumed.")}>
            Resume
          </button>
          <button className="lbtn danger" disabled={busy} onClick={() => void post(`${base}/run`, { action: "stop" }, "Run stopped.")}>
            Stop
          </button>
          <button className="lbtn" disabled={busy} onClick={() => void post(`${base}/discover`, {}, "Discovery started — metadata only.")}>
            Discover now
          </button>
        </div>
        {!source.enabled ? <div className="blocked-why">The source is disabled on the Sources screen, so a run cannot start.</div> : null}

        <div className="seclbl" style={{ marginTop: 14 }}>
          Mode
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <div className="trow">
            <div>
              <b>Metadata only</b>
              <div className="sub">Walk the listings and record what the site publishes.</div>
            </div>
            <span className="pill ok">Available</span>
          </div>
          {["Audio only", "Selective", "Full"].map((m) => (
            <div className="trow" key={m}>
              <div>
                <b>{m}</b>
                <div className="sub">{audioBlocked ? source.audioBlockedReason : "Available once the source is running."}</div>
              </div>
              <span className={`pill ${audioBlocked ? "bad" : "dim"}`}>{audioBlocked ? "Blocked" : "Available"}</span>
            </div>
          ))}
        </div>
        <div className="small dimtx" style={{ marginTop: 10, lineHeight: 1.55 }}>
          The run mode is set with the source&apos;s budget, and the engine refuses a mode its rights do not allow. Modes are
          shown here as the engine reports them — this screen never offers one it knows would be refused.
        </div>
      </Card>

      <Card title="Limits & budgets" right={<span className="pill dim">Per source</span>}>
        <div className="form">
          <label className="field">
            <span>Requests per minute</span>
            <input className="linput" inputMode="numeric" value={limits.requestsPerMinute} onChange={(e) => setLimits({ ...limits, requestsPerMinute: e.target.value })} />
          </label>
          <label className="field">
            <span>Max concurrent jobs</span>
            <input className="linput" inputMode="numeric" value={limits.concurrency} onChange={(e) => setLimits({ ...limits, concurrency: e.target.value })} />
          </label>
          <label className="field">
            <span>Daily transcription minutes</span>
            <input
              className="linput"
              inputMode="numeric"
              value={limits.transcriptionMinutesPerDay}
              onChange={(e) => setLimits({ ...limits, transcriptionMinutesPerDay: e.target.value })}
              disabled={audioBlocked}
            />
            {audioBlocked ? <div className="help">Transcription is an audio stage; it cannot run for this source.</div> : null}
          </label>
          <label className="field">
            <span>Daily API spend (cents)</span>
            <input className="linput" inputMode="numeric" value={limits.apiCentsPerDay} onChange={(e) => setLimits({ ...limits, apiCentsPerDay: e.target.value })} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="lbtn primary"
            disabled={busy}
            onClick={() => {
              const body: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(limits)) {
                if (String(v).trim() !== "" && !Number.isNaN(Number(v))) body[k] = Number(v);
              }
              void post(`${base}/budget`, body, "Limits saved.");
            }}
          >
            Save limits
          </button>
          {source.budget ? (
            <span className="small dimtx">
              Spent today {money(source.budget.spentCentsToday)} · {num(source.budget.transcribedMinutesToday)} transcription minutes
            </span>
          ) : (
            <span className="small dimtx">No budget is recorded for this source.</span>
          )}
        </div>

        <div className="banner" style={{ marginTop: 14, marginBottom: 0 }}>
          <span>⚠</span>
          <div>
            <b>Polite crawl.</b>
            <div className="sub">
              The site is a small publisher&apos;s custom application. One listing page at a time, no parallel fetches, and a
              hard stop on any rate-limit or challenge response. The engine must never be a load problem.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function DiscoveriesTab() {
  const findings = useApi<{ findings?: any[]; rows?: any[] }>(`${YC_API_PREFIX}/findings`);
  const all = listFrom<any>(findings.data?.findings ?? findings.data?.rows ?? findings.data, "findings");
  const mine = all.filter((f) => !f.sourceKey || f.sourceKey === YIDDISH24_SOURCE_KEY);

  return (
    <Card title="What this source has taught the engine">
      {findings.loading && findings.data == null ? (
        <div className="skel" style={{ height: 100 }} />
      ) : findings.error ? (
        <ErrorCard error={findings.error} what="Discoveries" onRetry={findings.reload} />
      ) : mine.length === 0 ? (
        <EmptyState
          title="0 discoveries"
          text="Discoveries come from listening — pronunciation observations, speaker clusters, prosody and novel vocabulary. None has been produced from this source."
        >
          <Link className="lbtn sm" href="/admin/yiddish-learning/governance">
            Governance
          </Link>
        </EmptyState>
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Statement</th>
                <th>Status</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((f) => (
                <tr key={f.id}>
                  <td>{titleCase(f.kind)}</td>
                  <td>{f.statement || "—"}</td>
                  <td>
                    <span className="pill dim">{titleCase(f.status)}</span>
                  </td>
                  <td className="small dimtx">{fmtDateTime(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function ProgressTab() {
  const [win, setWin] = useState<"1h" | "24h" | "7d" | "30d">("30d");
  const state = useApi<any>(`${YC_API_PREFIX}/progress?window=${win}`);
  const bySource = (state.data?.bySource ?? []).filter((s: any) => s.sourceKey === YIDDISH24_SOURCE_KEY);
  const row = bySource[0] ?? null;

  return (
    <Card
      title="Progress over time"
      sub="Only the metadata line can move before permission exists."
      right={
        <div className="chips" style={{ marginBottom: 0 }}>
          {(["1h", "24h", "7d", "30d"] as const).map((w) => (
            <button key={w} className={`chip ${win === w ? "on" : ""}`} onClick={() => setWin(w)}>
              {w}
            </button>
          ))}
        </div>
      }
    >
      {state.loading && state.data == null ? (
        <div className="skel" style={{ height: 90 }} />
      ) : state.error ? (
        <ErrorCard error={state.error} what="Progress" onRetry={state.reload} />
      ) : !row ? (
        <EmptyState
          title="This source contributed nothing in this window"
          text="The progress endpoint reported no rows for Yiddish24 in this period."
        />
      ) : (
        <div className="kpis k3">
          <Kpi label="Items discovered" value={num(row.items)} />
          <Kpi label="Audio hours analyzed" value={hours(row.audioHours)} />
          <Kpi label="New lexemes" value={num(row.newLexemes)} />
        </div>
      )}
    </Card>
  );
}
