"use client";
/**
 * Yiddish Learning Engine — External source manager (mockup screen 8).
 *
 *  GET  /admin/yiddish/sources
 *  POST /admin/yiddish/sources/:key/enable   { enabled }
 *  POST /admin/yiddish/sources/:key/budget   partial budget
 *  POST /admin/yiddish/sources/:key/discover
 *  POST /admin/yiddish/sources/:key/run      { action: start|pause|resume|stop }
 *
 * ⛔ Rights and the audio switch are NOT on this page. They are deliberate,
 *    owner-only decisions and live on Governance, behind a typed acknowledgement.
 * ⛔ A source whose audio stages are blocked shows the engine's own plain-English
 *    reason, and the run controls that need audio are DISABLED with that reason
 *    attached — never enabled-and-failing.
 */
import { useState } from "react";
import Link from "next/link";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiPost } from "../../../../../services/apiClient";
import {
  Card,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  LoadingCard,
  Modal,
  Note,
  OwnerOnlyNotice,
  PageHead,
  ServingOnlyChip,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
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

export default function SourceManagerPage() {
  const { role } = useAppContext();
  const state = useApi<YcSourceSummary[] | { sources: YcSourceSummary[] }>(`${YC_API_PREFIX}/sources`);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const sources = listFrom<YcSourceSummary>(state.data, "sources");
  const open = sources.find((s) => s.key === openKey) ?? null;

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Sources" />;

  const act = async (path: string, body: Record<string, unknown>, okText: string) => {
    setBusy(true);
    setNote(null);
    try {
      await apiPost(path, body);
      setNote({ kind: "ok", text: okText });
      state.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The engine refused that.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <YiddishPage>
      <PageHead
        title="External source manager"
        subtitle="Every source is an adapter that emits normalized records. No source logic leaks downstream, and every record inherits its source's governance."
        actions={<button className="lbtn sm" onClick={state.reload}>Refresh</button>}
      />
      <Note note={note} />

      {state.loading && state.data == null ? (
        <LoadingCard rows={5} label="Loading sources" />
      ) : state.error ? (
        <ErrorCard error={state.error} what="The source list" onRetry={state.reload} />
      ) : sources.length === 0 ? (
        <Card>
          <EmptyState title="No sources registered" text="The engine has no source adapters registered. Nothing has been discovered or counted." />
        </Card>
      ) : (
        <Card title="Sources">
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Adapter</th>
                  <th>Class</th>
                  <th>Training use</th>
                  <th>Audio</th>
                  <th>Budget</th>
                  <th>State</th>
                  <th className="num">Items</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <b>{s.name}</b>
                      <span className="sub">
                        {s.key} · {titleCase(s.kind)}
                      </span>
                    </td>
                    <td className="mono small">{s.adapterKey || "—"}</td>
                    <td>
                      <GovernanceChip value={s.governanceClass} />
                    </td>
                    <td>
                      <EligibilityChip value={s.trainingExportEligibility} />
                      {s.key.includes("yiddishlabs") || s.key === "voicelab" ? (
                        <div style={{ marginTop: 4 }}>
                          <ServingOnlyChip />
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {s.audioBlockedReason ? (
                        <span className="pill bad" title={s.audioBlockedReason}>
                          Blocked
                        </span>
                      ) : (
                        <span className="pill ok">{titleCase(s.audioFetchMode)}</span>
                      )}
                    </td>
                    <td className="small">
                      {s.budget ? (
                        <>
                          {money(s.budget.apiCentsPerDay)}/day · {num(s.budget.transcriptionMinutesPerDay)} min
                          <span className="sub">
                            spent {money(s.budget.spentCentsToday)} · {num(s.budget.transcribedMinutesToday)} min today
                          </span>
                        </>
                      ) : (
                        <span className="dimtx">No budget set</span>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${s.enabled ? "ok" : "dim"}`}>{s.enabled ? "Enabled" : "Disabled"}</span>
                      {s.budget?.paused ? <span className="pill warn" style={{ marginLeft: 6 }}>Paused</span> : null}
                      <span className="sub">last run {fmtDateTime(s.lastRunAt)}</span>
                    </td>
                    <td className="num">
                      {num(s.itemCount)}
                      <span className="sub">{hours(s.audioHours)}</span>
                    </td>
                    <td>
                      <button className="lbtn sm" onClick={() => setOpenKey(s.key)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="small dimtx" style={{ marginTop: 8 }}>
            Rights records and the audio switch are on{" "}
            <Link href="/admin/yiddish-learning/governance" className="rowlink">
              Governance
            </Link>
            . They are the owner&apos;s decision, not a source setting.
          </div>
        </Card>
      )}

      {open ? (
        <SourceDrawer
          s={open}
          busy={busy}
          onClose={() => setOpenKey(null)}
          onEnable={(enabled) => act(`${YC_API_PREFIX}/sources/${encodeURIComponent(open.key)}/enable`, { enabled }, enabled ? "Source enabled." : "Source disabled.")}
          onRun={(action) => act(`${YC_API_PREFIX}/sources/${encodeURIComponent(open.key)}/run`, { action }, `Run ${action} sent.`)}
          onDiscover={() => act(`${YC_API_PREFIX}/sources/${encodeURIComponent(open.key)}/discover`, {}, "Discovery started — metadata only.")}
          onBudget={(body) => act(`${YC_API_PREFIX}/sources/${encodeURIComponent(open.key)}/budget`, body, "Budget saved.")}
        />
      ) : null}
    </YiddishPage>
  );
}

function SourceDrawer({
  s,
  busy,
  onClose,
  onEnable,
  onRun,
  onDiscover,
  onBudget,
}: {
  s: YcSourceSummary;
  busy: boolean;
  onClose: () => void;
  onEnable: (enabled: boolean) => void;
  onRun: (action: "start" | "pause" | "resume" | "stop") => void;
  onDiscover: () => void;
  onBudget: (body: Record<string, unknown>) => void;
}) {
  const [budget, setBudget] = useState({
    apiCentsPerDay: String(s.budget?.apiCentsPerDay ?? ""),
    transcriptionMinutesPerDay: String(s.budget?.transcriptionMinutesPerDay ?? ""),
    concurrency: String(s.budget?.concurrency ?? ""),
    requestsPerMinute: String(s.budget?.requestsPerMinute ?? ""),
  });
  const audioBlocked = Boolean(s.audioBlockedReason);

  return (
    <Modal title={s.name} onClose={onClose}>
      <div className="ylx">
        <div className="row" style={{ gap: 6, marginBottom: 10 }}>
          <GovernanceChip value={s.governanceClass} />
          <EligibilityChip value={s.trainingExportEligibility} />
          <span className={`pill ${s.enabled ? "ok" : "dim"}`}>{s.enabled ? "Enabled" : "Disabled"}</span>
        </div>

        {audioBlocked ? <div className="banner bad" style={{ marginBottom: 12 }}>⛔ {s.audioBlockedReason}</div> : null}

        <div className="seclbl">Run</div>
        <div className="row">
          <button className="lbtn" disabled={busy || !s.enabled} onClick={() => onRun("start")}>
            Start
          </button>
          <button className="lbtn" disabled={busy} onClick={() => onRun("pause")}>
            Pause
          </button>
          <button className="lbtn" disabled={busy} onClick={() => onRun("resume")}>
            Resume
          </button>
          <button className="lbtn danger" disabled={busy} onClick={() => onRun("stop")}>
            Stop
          </button>
          <button className="lbtn" disabled={busy} onClick={onDiscover}>
            Discover (metadata only)
          </button>
        </div>
        {!s.enabled ? <div className="blocked-why">The source is disabled, so a run cannot start.</div> : null}
        {audioBlocked ? (
          <div className="blocked-why">
            ⛔ Audio stages (fetch, segment, cluster, transcribe, align) are held at the gate for this source. A run will do
            metadata only until the reason above is resolved on Governance.
          </div>
        ) : null}

        <div className="seclbl" style={{ marginTop: 14 }}>
          Enable
        </div>
        <div className="row">
          <button className="lbtn" disabled={busy} onClick={() => onEnable(!s.enabled)}>
            {s.enabled ? "Disable this source" : "Enable this source"}
          </button>
        </div>

        <div className="seclbl" style={{ marginTop: 14 }}>
          Budget
        </div>
        <div className="form">
          <label className="field">
            <span>Daily API spend (cents)</span>
            <input className="linput" inputMode="numeric" value={budget.apiCentsPerDay} onChange={(e) => setBudget({ ...budget, apiCentsPerDay: e.target.value })} />
          </label>
          <label className="field">
            <span>Transcription minutes / day</span>
            <input
              className="linput"
              inputMode="numeric"
              value={budget.transcriptionMinutesPerDay}
              onChange={(e) => setBudget({ ...budget, transcriptionMinutesPerDay: e.target.value })}
              disabled={audioBlocked}
            />
            {audioBlocked ? <div className="help">Transcription is an audio stage and cannot run for this source.</div> : null}
          </label>
          <label className="field">
            <span>Concurrency</span>
            <input className="linput" inputMode="numeric" value={budget.concurrency} onChange={(e) => setBudget({ ...budget, concurrency: e.target.value })} />
          </label>
          <label className="field">
            <span>Requests per minute</span>
            <input className="linput" inputMode="numeric" value={budget.requestsPerMinute} onChange={(e) => setBudget({ ...budget, requestsPerMinute: e.target.value })} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="lbtn primary"
            disabled={busy}
            onClick={() => {
              const body: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(budget)) {
                if (String(v).trim() !== "" && !Number.isNaN(Number(v))) body[k] = Number(v);
              }
              onBudget(body);
            }}
          >
            Save budget
          </button>
        </div>

        <div className="seclbl" style={{ marginTop: 14 }}>
          Rights records
        </div>
        {(s.rights ?? []).length === 0 ? (
          <div className="small dimtx">No rights record exists for this source. Until one does, the engine treats it as unknown.</div>
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Allowed use</th>
                  <th>State</th>
                  <th>Decided by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {(s.rights ?? []).map((r) => (
                  <tr key={`${r.allowedUse}-${r.decidedAt}`}>
                    <td>{titleCase(r.allowedUse)}</td>
                    <td>
                      <span className={`pill ${r.state === "GRANTED" ? "ok" : r.state === "DENIED" ? "bad" : "dim"}`}>{titleCase(r.state)}</span>
                    </td>
                    <td className="small">{r.decidedBy || "—"}</td>
                    <td className="small dimtx">{fmtDateTime(r.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {s.termsUrl ? (
          <div className="small dimtx" style={{ marginTop: 6 }}>
            Terms: <span className="mono">{s.termsUrl}</span> · checked {fmtDateTime(s.termsCheckedAt)}
          </div>
        ) : (
          <div className="small dimtx" style={{ marginTop: 6 }}>No terms URL recorded.</div>
        )}
        {s.rightsNote ? <div className="small dimtx" style={{ marginTop: 4 }}>{s.rightsNote}</div> : null}

        <div className="seclbl" style={{ marginTop: 14 }}>
          Adapter health
        </div>
        {(s.health ?? []).length === 0 ? (
          <div className="small dimtx">No health probes have run for this adapter.</div>
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
                {(s.health ?? []).map((h) => (
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
      </div>
    </Modal>
  );
}
