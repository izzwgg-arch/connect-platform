"use client";
/**
 * Yiddish Learning Engine — Training dataset export (mockup screen 9).
 *
 *  GET  /admin/yiddish/export/preview → counts + exclusion breakdown
 *  POST /admin/yiddish/export/build   → manifest path + row count
 *
 * ⛔ THE GOVERNANCE FILTERS ARE NOT SWITCHES. Yiddish Labs derived rows,
 *    customer-private rows and external rows whose rights are unknown or
 *    restricted are excluded before anything is written, and this screen shows
 *    them as locked-off with the reason. There is no UI path that turns one off.
 * ⛔ If the honest answer today is an empty manifest, the page says so and the
 *    build button is disabled — it never offers a build that would write nothing.
 */
import { useState } from "react";
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
  YC_CUSTOMER_WALL_MESSAGE,
  YC_YL_SERVING_ONLY_MESSAGE,
  YiddishPage,
  errText,
  num,
  titleCase,
  useApi,
} from "../YiddishUi";

type ExclusionRow = {
  origin: string;
  rows?: number | null;
  ylDerived?: number | null;
  customerPrivate?: number | null;
  externalRights?: number | null;
  included?: number | null;
  result?: string | null;
};
type ExportPreview = {
  fields?: string[];
  format?: string | null;
  includedRows?: number | null;
  excludedRows?: number | null;
  totalRows?: number | null;
  exclusions?: ExclusionRow[];
  sampleRow?: unknown;
  lastBuild?: { path?: string | null; rows?: number | null; builtAt?: string | null } | null;
};

type BuildResult = { path?: string | null; manifestPath?: string | null; rows?: number | null; rowCount?: number | null };

const LOCKED_OFF = [
  { label: "Yiddish Labs derived rows", why: YC_YL_SERVING_ONLY_MESSAGE },
  { label: "Customer-private rows", why: YC_CUSTOMER_WALL_MESSAGE },
  {
    label: "External rows with rights Unknown or Restricted",
    why: "An external row leaves only when the owner has recorded a rights grant that allows a training export for its source.",
  },
];

export default function TrainingExportPage() {
  const { role } = useAppContext();
  const state = useApi<ExportPreview>(`${YC_API_PREFIX}/export/preview`);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Training dataset export" />;

  const d = state.data;
  const included = d?.includedRows ?? null;
  const exclusions = d?.exclusions ?? [];
  const fields = d?.fields ?? [];

  const build = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await apiPost<BuildResult>(`${YC_API_PREFIX}/export/build`, {});
      const path = out?.manifestPath ?? out?.path ?? null;
      const rows = out?.rowCount ?? out?.rows ?? null;
      setNote({
        kind: "ok",
        text: `Manifest written${rows == null ? "" : ` with ${num(rows)} rows`}${path ? ` to ${path}` : ""}. It stays on the server — nothing is uploaded to a provider.`,
      });
      state.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The manifest was not built.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <YiddishPage>
      <PageHead
        title="Training dataset export"
        subtitle="Governance filters run before anything is written, and they cannot be switched off."
        actions={<button className="lbtn sm" onClick={state.reload}>Refresh</button>}
      />
      <Note note={note} />

      {state.loading && state.data == null ? (
        <LoadingCard rows={4} label="Loading the export preview" />
      ) : state.error ? (
        <ErrorCard error={state.error} what="The export preview" onRetry={state.reload} />
      ) : (
        <>
          <div className="kpis k3">
            <Kpi label="Rows that would be exported" value={num(included)} tone={included === 0 ? "warn" : undefined} />
            <Kpi label="Rows excluded by governance" value={num(d?.excludedRows)} />
            <Kpi label="Rows considered" value={num(d?.totalRows)} />
          </div>

          {included === 0 ? (
            <div className="banner">
              <span>⚠</span>
              <div>
                <b>An empty manifest is today&apos;s honest result.</b>
                <div className="sub">
                  Every row the engine holds is excluded by a governance rule. Build is disabled rather than writing an empty
                  file and calling it an export.
                </div>
              </div>
            </div>
          ) : null}

          <div className="g2">
            <Card title="Fields" sub={d?.format ? `${d.format} · provider-neutral` : "Provider-neutral"}>
              {fields.length === 0 ? (
                <EmptyState title="No field list reported" text="The engine did not describe the export schema." />
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 6 }}>
                  {fields.map((f) => (
                    <span key={f} className="mono small">
                      {f}
                    </span>
                  ))}
                </div>
              )}

              <div className="seclbl" style={{ marginTop: 14 }}>
                Locked off — not a setting
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {LOCKED_OFF.map((l) => (
                  <div key={l.label} className="trow">
                    <div>
                      <b>{l.label}</b>
                      <div className="sub">{l.why}</div>
                    </div>
                    <span className="pill bad">Locked off</span>
                  </div>
                ))}
              </div>

              <div className="row" style={{ marginTop: 14 }}>
                <button className="lbtn primary" disabled={busy || !included} onClick={build}>
                  Build manifest
                </button>
                <span className="small dimtx">Stays on the server. No provider upload.</span>
              </div>
              {!included ? <div className="blocked-why">⛔ Nothing would be written, so there is no manifest to build.</div> : null}
            </Card>

            <div className="stack">
              <Card
                title="Exclusion breakdown"
                sub="A row excluded for several reasons is counted once in the total."
              >
                {exclusions.length === 0 ? (
                  <EmptyState title="No breakdown reported" text="The engine returned no exclusion rows." />
                ) : (
                  <TableWrap>
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Origin</th>
                          <th className="num">Rows</th>
                          <th className="num">YL-derived</th>
                          <th className="num">Customer-private</th>
                          <th className="num">External rights</th>
                          <th className="num">Included</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exclusions.map((x) => (
                          <tr key={x.origin}>
                            <td>{titleCase(x.origin)}</td>
                            <td className="num">{num(x.rows)}</td>
                            <td className="num">{num(x.ylDerived)}</td>
                            <td className="num">{num(x.customerPrivate)}</td>
                            <td className="num">{num(x.externalRights)}</td>
                            <td className="num">{num(x.included)}</td>
                            <td className="small dimtx">{x.result || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>

              <Card title="Preview — first row" sub="Exactly what would be written, or nothing at all.">
                {d?.sampleRow == null ? (
                  <EmptyState
                    title="No row to preview"
                    text="No row survives the governance filters, so there is no first row. Nothing is shown in its place."
                  />
                ) : (
                  <pre className="req">{JSON.stringify(d.sampleRow, null, 2)}</pre>
                )}
              </Card>

              {d?.lastBuild ? (
                <Card title="Last build">
                  <dl className="dl">
                    <div>
                      <dt>Manifest</dt>
                      <dd className="mono small">{d.lastBuild.path || "—"}</dd>
                    </div>
                    <div>
                      <dt>Rows</dt>
                      <dd>{num(d.lastBuild.rows)}</dd>
                    </div>
                    <div>
                      <dt>Built</dt>
                      <dd>{d.lastBuild.builtAt || "—"}</dd>
                    </div>
                  </dl>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      )}
    </YiddishPage>
  );
}
