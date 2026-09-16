"use client";
/**
 * Yiddish Learning Engine — Learning progress (mockup screen 7).
 *
 *  GET /admin/yiddish/progress ?window=1h|24h|7d|30d
 *
 * ⛔ NO ACCURACY FIGURE. There is no ground-truth reference set for Yiddish
 *    telephone speech, so this page reports what a window of processing added
 *    — counts, confidence distributions and human ratings. A "% accurate"
 *    would be a number nobody measured.
 */
import { useState } from "react";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  Bars,
  Card,
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
  hours,
  num,
  pct,
  titleCase,
  useApi,
} from "../YiddishUi";

type ProgressWindow = "1h" | "24h" | "7d" | "30d";

type ProgressView = {
  window?: string;
  from?: string | null;
  to?: string | null;
  added?: {
    items?: number | null;
    audioHours?: number | null;
    transcripts?: number | null;
    lexemes?: number | null;
    variants?: number | null;
    observations?: number | null;
    speakerClusters?: number | null;
    rules?: number | null;
  };
  bySource?: { sourceKey: string; sourceName?: string | null; governanceClass?: string | null; items?: number | null; audioHours?: number | null; newLexemes?: number | null }[];
  novelty?: { cumulativeHours: number; novelShare: number; items?: number | null }[];
  confidence?: { bucket: string; count: number }[];
  findings?: { id: string; kind?: string | null; statement?: string | null; evidence?: string | null; status?: string | null }[];
};

const WINDOWS: { key: ProgressWindow; label: string }[] = [
  { key: "1h", label: "1 hour" },
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export default function LearningProgressPage() {
  const { role } = useAppContext();
  const [win, setWin] = useState<ProgressWindow>("24h");
  const state = useApi<ProgressView>(`${YC_API_PREFIX}/progress?window=${win}`);

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Learning progress" />;

  const d = state.data;
  const added = d?.added ?? {};
  const bySource = d?.bySource ?? [];
  const novelty = d?.novelty ?? [];
  const confidence = d?.confidence ?? [];
  const findings = d?.findings ?? [];

  return (
    <YiddishPage>
      <PageHead
        title="Learning progress"
        subtitle="What each window of processing actually added."
        actions={
          <div className="chips" style={{ marginBottom: 0 }}>
            {WINDOWS.map((w) => (
              <button key={w.key} className={`chip ${win === w.key ? "on" : ""}`} onClick={() => setWin(w.key)}>
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="banner info">
        <span>ℹ</span>
        <div>
          <b>No accuracy number: there is no ground truth.</b>
          <div className="sub">
            No verified reference transcript set exists for Yiddish telephone speech, so the engine reports counts,
            confidence distributions and human benchmark ratings — never &ldquo;% accurate&rdquo;.
          </div>
        </div>
      </div>

      {state.loading && state.data == null ? (
        <LoadingCard rows={4} label="Loading progress" />
      ) : state.error ? (
        <ErrorCard error={state.error} what="Learning progress" onRetry={state.reload} />
      ) : (
        <>
          <div className="kpis k6">
            <Kpi label="Items processed" value={num(added.items)} sub={hours(added.audioHours)} />
            <Kpi label="Transcripts" value={num(added.transcripts)} />
            <Kpi label="New lexemes" value={num(added.lexemes)} />
            <Kpi label="New variants" value={num(added.variants)} />
            <Kpi label="Observations" value={num(added.observations)} />
            <Kpi label="Speaker clusters" value={num(added.speakerClusters)} sub={`${num(added.rules)} rules changed`} />
          </div>
          {d?.from || d?.to ? (
            <div className="small dimtx" style={{ margin: "-4px 0 12px" }}>
              Window {d?.from ?? "—"} → {d?.to ?? "—"}
            </div>
          ) : null}

          <div className="g2">
            <Card
              title="What this window added, by source"
              sub="Per-source so any source can be excluded later without recomputing everything else."
            >
              {bySource.length === 0 ? (
                <EmptyState title="Nothing was processed in this window" text="No source contributed anything in this period." />
              ) : (
                <TableWrap>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Class</th>
                        <th className="num">Items</th>
                        <th className="num">Audio</th>
                        <th className="num">New lexemes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bySource.map((s) => (
                        <tr key={s.sourceKey}>
                          <td>{s.sourceName || s.sourceKey}</td>
                          <td>
                            <GovernanceChip value={s.governanceClass} />
                          </td>
                          <td className="num">{num(s.items)}</td>
                          <td className="num">{hours(s.audioHours)}</td>
                          <td className="num">{num(s.newLexemes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>

            <Card
              title="Diminishing returns"
              sub="Share of utterances that added a new lexeme, variant or speaker, against cumulative hours processed."
            >
              {novelty.length === 0 ? (
                <EmptyState
                  title="No novelty measurements"
                  text="The curve is drawn from measured points only. None exists, so nothing is drawn — the shape is not sketched from expectation."
                />
              ) : (
                <Bars
                  rows={novelty.map((p) => ({
                    label: hours(p.cumulativeHours),
                    value: p.novelShare,
                    display: `${pct(p.novelShare, 1)}${p.items == null ? "" : ` · n=${num(p.items)}`}`,
                  }))}
                />
              )}
            </Card>
          </div>

          <div className="g2" style={{ marginTop: 14 }}>
            <Card title="Alignment confidence distribution" sub="Where the engine is sure, and where it is not.">
              {confidence.length === 0 ? (
                <EmptyState title="No confidence data" text="No aligned tokens were produced in this window." />
              ) : (
                <Bars rows={confidence.map((c) => ({ label: c.bucket, value: c.count }))} />
              )}
            </Card>

            <Card title="Style findings" sub="Stated as observations with their evidence, never as applied rules.">
              {findings.length === 0 ? (
                <EmptyState title="No findings in this window" text="The engine proposed nothing in this period." />
              ) : (
                <TableWrap>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Finding</th>
                        <th>Evidence</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {findings.map((f) => (
                        <tr key={f.id}>
                          <td>
                            <b>{f.statement || titleCase(f.kind)}</b>
                            <span className="sub">{titleCase(f.kind)}</span>
                          </td>
                          <td className="small dimtx">{f.evidence || "—"}</td>
                          <td>
                            <span className="pill dim">{titleCase(f.status)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          </div>
        </>
      )}
    </YiddishPage>
  );
}
