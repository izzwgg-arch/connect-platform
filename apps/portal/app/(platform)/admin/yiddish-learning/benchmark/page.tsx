"use client";
/**
 * Yiddish Learning Engine — Voice benchmark (mockup screen 6).
 *
 *  GET  /admin/yiddish/benchmark              → cases, profiles, runs
 *  POST /admin/yiddish/benchmark/run          { profileVersionId }
 *  POST /admin/yiddish/benchmark/results/:id/rate { rating, notes }
 *  POST /admin/yiddish/benchmark/cases        { text, category, tags, sourceRef }
 *
 * ⛔ There is NO accuracy percentage anywhere on this page. There is no
 *    ground-truth reference set for Yiddish telephone speech, so the engine
 *    reports human ratings and counts. A "% accurate" here would be invented.
 * ⛔ Every rating shown is a human's. Nothing is auto-scored.
 * ⛔ Yiddish case text is rendered from the API, never authored here — the
 *    "add a case" box takes the operator's own pasted text.
 */
import { useMemo, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiPost } from "../../../../../services/apiClient";
import {
  Card,
  EmptyState,
  ErrorCard,
  Kpi,
  LoadingCard,
  Note,
  OwnerOnlyNotice,
  PageHead,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  YiddishText,
  errText,
  fmtDateTime,
  num,
  titleCase,
  useApi,
} from "../YiddishUi";

type ProfileVersion = {
  id: string;
  key?: string | null;
  version?: number | null;
  status?: string | null;
  isBaseline?: boolean;
  model?: string | null;
  voice?: string | null;
  instructions?: string | null;
  frozenAt?: string | null;
  meanRating?: number | null;
  n?: number | null;
};
type BenchmarkCase = {
  id: string;
  text?: string | null;
  category?: string | null;
  tags?: string[] | null;
  sourceRef?: string | null;
};
type BenchmarkResult = {
  id: string;
  caseId?: string | null;
  caseText?: string | null;
  profileVersionId?: string | null;
  rating?: number | null;
  notes?: string | null;
  ratedBy?: string | null;
  ratedAt?: string | null;
};
type BenchmarkRun = {
  id: string;
  profileVersionId?: string | null;
  profileLabel?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  status?: string | null;
  cases?: number | null;
  rated?: number | null;
  meanRating?: number | null;
  results?: BenchmarkResult[];
};
type CategoryComparison = {
  category: string;
  cases?: number | null;
  baselineMean?: number | null;
  baselineN?: number | null;
  candidateMean?: number | null;
  candidateN?: number | null;
  delta?: number | null;
  verdict?: string | null;
};
type BenchmarkView = {
  baseline?: ProfileVersion | null;
  profiles?: ProfileVersion[];
  cases?: BenchmarkCase[];
  runs?: BenchmarkRun[];
  byCategory?: CategoryComparison[];
  minSamplesForConclusion?: number | null;
};

const RATINGS = [
  { value: "1", label: "1 — Bad" },
  { value: "2", label: "2 — Poor" },
  { value: "3", label: "3 — Good" },
  { value: "4", label: "4 — Excellent" },
];

export default function BenchmarkPage() {
  const { role } = useAppContext();
  const state = useApi<BenchmarkView>(`${YC_API_PREFIX}/benchmark`);
  const [candidateId, setCandidateId] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCase, setNewCase] = useState({ text: "", category: "", tags: "", sourceRef: "" });

  const profiles = state.data?.profiles ?? [];
  const baseline = state.data?.baseline ?? profiles.find((p) => p.isBaseline) ?? null;
  const candidates = profiles.filter((p) => p.id !== baseline?.id);
  const candidate = candidates.find((c) => c.id === candidateId) ?? null;
  const runs = state.data?.runs ?? [];
  const cases = state.data?.cases ?? [];
  const byCategory = state.data?.byCategory ?? [];

  const candidateOptions = useMemo(
    () => [
      { value: "", label: candidates.length ? "Choose a candidate…" : "No candidate profile exists" },
      ...candidates.map((c) => ({ value: c.id, label: `${c.key ?? "profile"} v${num(c.version)} — ${titleCase(c.status)}` })),
    ],
    [candidates],
  );

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Voice benchmark" />;

  const runBenchmark = async () => {
    if (!candidateId) return;
    setBusy(true);
    setNote(null);
    try {
      await apiPost(`${YC_API_PREFIX}/benchmark/run`, { profileVersionId: candidateId });
      setNote({ kind: "ok", text: "Benchmark run started. Ratings are entered by a person below as results arrive." });
      state.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The benchmark run did not start.") });
    } finally {
      setBusy(false);
    }
  };

  const rate = async (resultId: string, rating: string) => {
    if (!rating) return;
    setBusy(true);
    setNote(null);
    try {
      await apiPost(`${YC_API_PREFIX}/benchmark/results/${encodeURIComponent(resultId)}/rate`, { rating: Number(rating), notes: "" });
      setNote({ kind: "ok", text: "Rating recorded." });
      state.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The rating was not recorded.") });
    } finally {
      setBusy(false);
    }
  };

  const addCase = async () => {
    if (!newCase.text.trim()) {
      setNote({ kind: "bad", text: "Paste the case text first." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await apiPost(`${YC_API_PREFIX}/benchmark/cases`, {
        text: newCase.text,
        category: newCase.category.trim() || null,
        tags: newCase.tags.split(",").map((t) => t.trim()).filter(Boolean),
        sourceRef: newCase.sourceRef.trim() || null,
      });
      setNote({ kind: "ok", text: "Case added." });
      setNewCase({ text: "", category: "", tags: "", sourceRef: "" });
      state.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The case was not added.") });
    } finally {
      setBusy(false);
    }
  };

  const latestRun = runs[0] ?? null;
  const pendingResults = (latestRun?.results ?? []).filter((r) => r.rating == null);

  return (
    <YiddishPage>
      <PageHead
        title="Voice benchmark"
        subtitle="A baseline freezes today's model, voice, instructions and rules. Every candidate is rated against it by people before it can move toward production."
        actions={<button className="lbtn sm" onClick={state.reload}>Refresh</button>}
      />
      <Note note={note} />

      <div className="banner info">
        <span>ℹ</span>
        <div>
          <b>No accuracy number, on purpose.</b>
          <div className="sub">
            There is no verified reference transcript set for Yiddish telephone speech, so this page reports counts, human
            ratings and their sample sizes — never a percentage.
          </div>
        </div>
      </div>

      {state.loading && state.data == null ? (
        <LoadingCard rows={5} label="Loading the benchmark" />
      ) : state.error ? (
        <ErrorCard error={state.error} what="The benchmark" onRetry={state.reload} />
      ) : (
        <>
          <div className="kpis k3">
            <Kpi label="Benchmark cases" value={num(cases.length)} />
            <Kpi label="Runs recorded" value={num(runs.length)} />
            <Kpi
              label="Minimum n for a conclusion"
              value={state.data?.minSamplesForConclusion == null ? "—" : num(state.data.minSamplesForConclusion)}
              sub="Below this the engine refuses to call a winner"
            />
          </div>

          <div className="g2">
            <Card title="Baseline" right={baseline ? <span className="pill dim">frozen · immutable</span> : null}>
              {!baseline ? (
                <EmptyState
                  title="No baseline is frozen"
                  text="Nothing can be compared until a profile version is frozen as the baseline. There is no stand-in."
                />
              ) : (
                <ProfileTable p={baseline} />
              )}
            </Card>

            <Card
              title="Candidate"
              right={
                <div style={{ minWidth: 240 }}>
                  <ConnectSelect value={candidateId} onChange={setCandidateId} options={candidateOptions} size="sm" ariaLabel="Candidate profile" disabled={candidates.length === 0} />
                </div>
              }
            >
              {candidates.length === 0 ? (
                <EmptyState title="No candidate profile" text="There is no second profile version to compare with the baseline." />
              ) : !candidate ? (
                <EmptyState title="Pick a candidate" text="Choose a profile version to compare against the baseline." />
              ) : (
                <ProfileTable p={candidate} />
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button className="lbtn primary" disabled={!candidateId || busy || cases.length === 0} onClick={runBenchmark}>
                  Run benchmark
                </button>
                {cases.length === 0 ? (
                  <span className="blocked-why">⛔ There are no benchmark cases, so a run would produce nothing to rate.</span>
                ) : null}
              </div>
            </Card>
          </div>

          <Card
            title="By category"
            sub="Average human rating, 1 (Bad) to 4 (Excellent), with the sample size behind each figure."
          >
            {byCategory.length === 0 ? (
              <EmptyState
                title="No category comparison yet"
                text="A comparison needs rated results on both sides. None exists."
              />
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="num">Cases</th>
                      <th className="num">Baseline</th>
                      <th className="num">n</th>
                      <th className="num">Candidate</th>
                      <th className="num">n</th>
                      <th className="num">Δ</th>
                      <th>Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCategory.map((c) => (
                      <tr key={c.category}>
                        <td>{titleCase(c.category)}</td>
                        <td className="num">{num(c.cases)}</td>
                        <td className="num">{c.baselineMean == null ? "—" : c.baselineMean.toFixed(2)}</td>
                        <td className="num">{num(c.baselineN)}</td>
                        <td className="num">{c.candidateMean == null ? "—" : c.candidateMean.toFixed(2)}</td>
                        <td className="num">{num(c.candidateN)}</td>
                        <td className="num">{c.delta == null ? "—" : (c.delta >= 0 ? "+" : "") + c.delta.toFixed(2)}</td>
                        <td className="small dimtx">{c.verdict || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card
            title="Rate the latest run"
            sub={latestRun ? `${titleCase(latestRun.status)} · started ${fmtDateTime(latestRun.startedAt)}` : undefined}
          >
            {!latestRun ? (
              <EmptyState title="No run yet" text="No benchmark run has been recorded." />
            ) : pendingResults.length === 0 ? (
              <EmptyState
                title="Nothing waiting for a rating"
                text={`${num(latestRun.rated)} of ${num(latestRun.cases)} results are rated. Mean rating ${
                  latestRun.meanRating == null ? "not computed" : latestRun.meanRating.toFixed(2)
                }.`}
              />
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingResults.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <YiddishText text={r.caseText} block />
                        </td>
                        <td style={{ minWidth: 190 }}>
                          <ConnectSelect
                            value=""
                            onChange={(v) => void rate(r.id, v)}
                            options={[{ value: "", label: "Rate…" }, ...RATINGS]}
                            size="sm"
                            disabled={busy}
                            ariaLabel="Rating"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>

          <Card title="Add a benchmark case" sub="Paste the sentence to be spoken. It is stored exactly as pasted.">
            <div className="form">
              <label className="field full">
                <span>Case text</span>
                <input className="linput yi" dir="rtl" lang="yi" value={newCase.text} onChange={(e) => setNewCase({ ...newCase, text: e.target.value })} />
              </label>
              <label className="field">
                <span>Category</span>
                <input className="linput" value={newCase.category} onChange={(e) => setNewCase({ ...newCase, category: e.target.value })} />
              </label>
              <label className="field">
                <span>Tags (comma separated)</span>
                <input className="linput" value={newCase.tags} onChange={(e) => setNewCase({ ...newCase, tags: e.target.value })} />
              </label>
              <label className="field full">
                <span>Source reference</span>
                <input className="linput" value={newCase.sourceRef} onChange={(e) => setNewCase({ ...newCase, sourceRef: e.target.value })} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="lbtn" disabled={busy} onClick={addCase}>
                Add case
              </button>
            </div>
          </Card>
        </>
      )}
    </YiddishPage>
  );
}

function ProfileTable({ p }: { p: ProfileVersion }) {
  return (
    <TableWrap>
      <table className="t">
        <tbody>
          <tr>
            <th style={{ width: 150 }}>Profile</th>
            <td>
              {p.key ?? "—"} v{num(p.version)}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span className="pill dim">{titleCase(p.status)}</span>
            </td>
          </tr>
          <tr>
            <th>Model</th>
            <td className="mono small">{p.model || "—"}</td>
          </tr>
          <tr>
            <th>Voice</th>
            <td className="mono small">{p.voice || "—"}</td>
          </tr>
          <tr>
            <th>Frozen</th>
            <td>{fmtDateTime(p.frozenAt)}</td>
          </tr>
          <tr>
            <th>Mean human rating</th>
            <td>{p.meanRating == null ? <span className="dimtx">Not rated</span> : `${p.meanRating.toFixed(2)} (n=${num(p.n)})`}</td>
          </tr>
        </tbody>
      </table>
    </TableWrap>
  );
}
