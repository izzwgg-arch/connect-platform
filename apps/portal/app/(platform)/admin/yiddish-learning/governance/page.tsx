"use client";
/**
 * Yiddish Learning Engine — Governance & budgets (mockup screen 10).
 *
 *  GET  /admin/yiddish/governance          → walls, rights records, gaps
 *  GET  /admin/yiddish/queue               → job counts + recent failures
 *  POST /admin/yiddish/sources/:key/rights      { allowedUse, state, evidence }
 *  POST /admin/yiddish/sources/:key/audio-mode  { mode, acknowledgement }
 *  POST /admin/yiddish/sources/:key/budget      partial budget
 *
 * ⛔ THE AUDIO SWITCH IS THE ONE DELIBERATE ACT ON THIS SCREEN. Turning audio
 *    fetching ON for a source is the owner saying, in their own words, that a
 *    rights grant exists. It is behind a confirmation that requires typing the
 *    acknowledgement phrase exactly; nothing about it is a one-click toggle,
 *    and the button stays disabled until the typed text matches.
 *    Turning it OFF is always allowed and needs no ceremony.
 * ⛔ The customer data wall is counts only. No content ever renders here.
 */
import { useMemo, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiPost } from "../../../../../services/apiClient";
import {
  Card,
  CustomerWallCard,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  Kpi,
  LoadingCard,
  Modal,
  Note,
  OwnerOnlyNotice,
  PageHead,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  errText,
  fmtDateTime,
  listFrom,
  money,
  num,
  titleCase,
  useApi,
  type YcSourceSummary,
} from "../YiddishUi";

type GovernanceView = {
  walls?: { label: string; count: number; hours: number | null; note: string }[];
  walled?: { label: string; count: number; hours: number | null; note: string }[];
  rights?: {
    sourceKey: string;
    sourceName?: string | null;
    governanceClass?: string | null;
    trainingExportEligibility?: string | null;
    termsUrl?: string | null;
    termsCheckedAt?: string | null;
    allowedUse?: string | null;
    state?: string | null;
    decidedBy?: string | null;
    decidedAt?: string | null;
    note?: string | null;
  }[];
  gaps?: { key?: string | null; statement: string; severity?: string | null }[];
  budget?: {
    scope: string;
    apiCentsPerDay?: number | null;
    transcriptionMinutesPerDay?: number | null;
    storageBytesMax?: string | null;
    concurrency?: number | null;
    requestsPerMinute?: number | null;
    mode?: string | null;
    paused?: boolean;
    spentCentsToday?: number | null;
    transcribedMinutesToday?: number | null;
  } | null;
  worker?: { alive?: boolean; lastTickAt?: string | null; note?: string | null } | null;
  promotionStates?: { name: string; count?: number | null; note?: string | null }[];
  /** When the engine names the phrase it wants typed, that phrase wins. */
  audioModeAcknowledgementPhrase?: string | null;
};

type QueueView = {
  counts?: { state: string; count: number }[];
  states?: { state: string; count: number }[];
  failures?: { id: string; stage?: string | null; error?: string | null; failedAt?: string | null }[];
};

/** Used only when the engine does not name its own required phrase. */
const DEFAULT_ACK_PHRASE = "I AUTHORIZE AUDIO FETCHING";

const ALLOWED_USE_OPTIONS = [
  { value: "metadata_only", label: "Metadata only" },
  { value: "analysis", label: "Analysis" },
  { value: "store_audio", label: "Store audio" },
  { value: "training_export", label: "Training export" },
];
const RIGHTS_STATE_OPTIONS = [
  { value: "GRANTED", label: "Granted" },
  { value: "DENIED", label: "Denied" },
  { value: "UNKNOWN", label: "Unknown" },
];

export default function GovernancePage() {
  const { role } = useAppContext();
  const gov = useApi<GovernanceView>(`${YC_API_PREFIX}/governance`);
  const sources = useApi<YcSourceSummary[] | { sources: YcSourceSummary[] }>(`${YC_API_PREFIX}/sources`);
  const queue = useApi<QueueView>(`${YC_API_PREFIX}/queue`);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioTarget, setAudioTarget] = useState<YcSourceSummary | null>(null);
  const [rightsTarget, setRightsTarget] = useState<YcSourceSummary | null>(null);

  const sourceList = listFrom<YcSourceSummary>(sources.data, "sources");
  const walls = gov.data?.walls ?? gov.data?.walled ?? [];
  const rights = gov.data?.rights ?? [];
  const gaps = gov.data?.gaps ?? [];
  const queueCounts = queue.data?.counts ?? queue.data?.states ?? [];
  const failures = queue.data?.failures ?? [];
  const ackPhrase = (gov.data?.audioModeAcknowledgementPhrase || DEFAULT_ACK_PHRASE).trim();

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Governance & budgets" />;

  const post = async (path: string, body: Record<string, unknown>, okText: string) => {
    setBusy(true);
    setNote(null);
    try {
      await apiPost(path, body);
      setNote({ kind: "ok", text: okText });
      gov.reload();
      sources.reload();
      return true;
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The engine refused that.") });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <YiddishPage>
      <PageHead
        title="Governance & budgets"
        subtitle="The rules that decide what the engine may read, keep, learn from and spend. Nothing here can be changed by the engine itself."
        actions={
          <button
            className="lbtn sm"
            onClick={() => {
              gov.reload();
              sources.reload();
              queue.reload();
            }}
          >
            Refresh
          </button>
        }
      />
      <Note note={note} />

      {gov.loading && gov.data == null ? (
        <LoadingCard rows={4} label="Loading governance" />
      ) : gov.error ? (
        <ErrorCard error={gov.error} what="Governance" onRetry={gov.reload} />
      ) : (
        <>
          <CustomerWallCard rows={walls} />

          <div className="g2" style={{ marginTop: 14 }}>
            <Card title="Per-source rights records" sub="What each source is permitted for, and who decided it.">
              {rights.length === 0 ? (
                <EmptyState title="No rights records" text="No source has a recorded rights decision. Until one exists, the engine treats the source as unknown." />
              ) : (
                <TableWrap>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Class</th>
                        <th>Training use</th>
                        <th>Allowed use</th>
                        <th>State</th>
                        <th>Decided</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rights.map((r) => (
                        <tr key={`${r.sourceKey}-${r.allowedUse}-${r.decidedAt ?? ""}`}>
                          <td>
                            <b>{r.sourceName || r.sourceKey}</b>
                            {r.termsUrl ? <span className="sub mono">{r.termsUrl}</span> : <span className="sub dimtx">No terms URL</span>}
                          </td>
                          <td>
                            <GovernanceChip value={r.governanceClass} />
                          </td>
                          <td>
                            <EligibilityChip value={r.trainingExportEligibility} />
                          </td>
                          <td>{titleCase(r.allowedUse)}</td>
                          <td>
                            <span className={`pill ${r.state === "GRANTED" ? "ok" : r.state === "DENIED" ? "bad" : "dim"}`}>{titleCase(r.state)}</span>
                          </td>
                          <td className="small dimtx">
                            {r.decidedBy || "—"}
                            <span className="sub">{fmtDateTime(r.decidedAt)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}

              <div className="seclbl" style={{ marginTop: 14 }}>
                Governance gaps found in production
              </div>
              {gaps.length === 0 ? (
                <div className="small dimtx">The engine reported no open gaps.</div>
              ) : (
                <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {gaps.map((g, i) => (
                    <li key={g.key ?? i}>
                      {g.severity ? <b>{titleCase(g.severity)}: </b> : null}
                      {g.statement}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Budgets" sub="The engine's spend ceiling. Reached, it stops — it never borrows from tomorrow.">
              {gov.data?.budget ? (
                <>
                  <div className="kpis k2" style={{ marginBottom: 12 }}>
                    <Kpi
                      label="API spend today"
                      value={money(gov.data.budget.spentCentsToday)}
                      sub={`of ${money(gov.data.budget.apiCentsPerDay)} per day`}
                    />
                    <Kpi
                      label="Transcription today"
                      value={`${num(gov.data.budget.transcribedMinutesToday)} min`}
                      sub={`of ${num(gov.data.budget.transcriptionMinutesPerDay)} min per day`}
                    />
                  </div>
                  <dl className="dl">
                    <div>
                      <dt>Scope</dt>
                      <dd>{gov.data.budget.scope}</dd>
                    </div>
                    <div>
                      <dt>Mode</dt>
                      <dd>{titleCase(gov.data.budget.mode)}</dd>
                    </div>
                    <div>
                      <dt>Concurrency</dt>
                      <dd>{num(gov.data.budget.concurrency)}</dd>
                    </div>
                    <div>
                      <dt>Requests / minute</dt>
                      <dd>{num(gov.data.budget.requestsPerMinute)}</dd>
                    </div>
                    <div>
                      <dt>State</dt>
                      <dd>
                        <span className={`pill ${gov.data.budget.paused ? "warn" : "ok"}`}>{gov.data.budget.paused ? "Paused" : "Running"}</span>
                      </dd>
                    </div>
                  </dl>
                  <div className="help" style={{ marginTop: 8 }}>
                    Per-source budgets are edited on the Sources screen; this is the platform ceiling they all sit under.
                  </div>
                </>
              ) : (
                <EmptyState title="No budget configured" text="The engine reported no platform budget. With no ceiling recorded, no spending stage may run." />
              )}

              <div className="seclbl" style={{ marginTop: 14 }}>
                Worker
              </div>
              {gov.data?.worker ? (
                <>
                  <div className="row">
                    <span className={`pill ${gov.data.worker.alive ? "ok" : "bad"}`}>{gov.data.worker.alive ? "Alive" : "Not provisioned"}</span>
                    <span className="small dimtx">Last tick {fmtDateTime(gov.data.worker.lastTickAt)}</span>
                  </div>
                  {gov.data.worker.note ? <div className="small dimtx" style={{ marginTop: 6, lineHeight: 1.55 }}>{gov.data.worker.note}</div> : null}
                </>
              ) : (
                <div className="small dimtx">The engine reported no worker heartbeat.</div>
              )}
            </Card>
          </div>

          <Card
            title="Audio fetching"
            sub="Audio bytes are only fetched where the owner has recorded a rights grant. This is the switch, and it is deliberate."
            className="wall"
          >
            {sources.loading && sources.data == null ? (
              <div className="skel" style={{ height: 90 }} />
            ) : sources.error ? (
              <ErrorCard error={sources.error} what="The source list" onRetry={sources.reload} />
            ) : sourceList.length === 0 ? (
              <EmptyState title="No sources registered" text="There is nothing to authorize." />
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Class</th>
                      <th>Audio mode</th>
                      <th>Why it is blocked</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sourceList.map((s) => (
                      <tr key={s.key}>
                        <td>
                          <b>{s.name}</b>
                          <span className="sub">{s.key}</span>
                        </td>
                        <td>
                          <GovernanceChip value={s.governanceClass} />
                        </td>
                        <td>
                          <span className={`pill ${s.audioFetchMode === "OWNER_AUTHORIZED" ? "ok" : "dim"}`}>{titleCase(s.audioFetchMode)}</span>
                        </td>
                        <td className="small dimtx" style={{ maxWidth: 420 }}>
                          {s.audioBlockedReason || <span className="dimtx">Not blocked.</span>}
                        </td>
                        <td>
                          {s.audioFetchMode === "OWNER_AUTHORIZED" ? (
                            <button
                              className="lbtn sm danger"
                              disabled={busy}
                              onClick={() =>
                                void post(
                                  `${YC_API_PREFIX}/sources/${encodeURIComponent(s.key)}/audio-mode`,
                                  { mode: "DISABLED", acknowledgement: "" },
                                  `Audio fetching turned off for ${s.name}.`,
                                )
                              }
                            >
                              Turn audio off
                            </button>
                          ) : (
                            <button className="lbtn sm" disabled={busy} onClick={() => setAudioTarget(s)}>
                              Enable audio…
                            </button>
                          )}
                          <button className="lbtn sm ghost" style={{ marginLeft: 6 }} disabled={busy} onClick={() => setRightsTarget(s)}>
                            Record rights…
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
            <div className="wall-note">
              Turning audio on does not fetch anything by itself — it lifts the gate the run stages check. Turning it off is
              always allowed and takes effect immediately.
            </div>
          </Card>

          <div className="g2" style={{ marginTop: 14 }}>
            <Card title="Promotion states" sub="Rules, dictionaries, profiles and evaluation sets move Candidate → Testing → Approved → Production.">
              {(gov.data?.promotionStates ?? []).length === 0 ? (
                <EmptyState title="Nothing in promotion" text="No rule or profile is anywhere in the promotion pipeline." />
              ) : (
                <TableWrap>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>State</th>
                        <th className="num">Items</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(gov.data?.promotionStates ?? []).map((p) => (
                        <tr key={p.name}>
                          <td>{titleCase(p.name)}</td>
                          <td className="num">{num(p.count)}</td>
                          <td className="small dimtx">{p.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>
                <span>⛔</span>
                <div>
                  <b>No uncontrolled self-modification.</b>
                  <div className="sub">
                    Production needs a benchmark run against the baseline, A/B evidence and a named human approver. Learning
                    algorithms are versioned so old results stay reproducible.
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Processing queue" sub="DB-row leases, so a restart never loses a job.">
              {queue.loading && queue.data == null ? (
                <div className="skel" style={{ height: 80 }} />
              ) : queue.error ? (
                <ErrorCard error={queue.error} what="The processing queue" onRetry={queue.reload} />
              ) : queueCounts.length === 0 ? (
                <EmptyState title="The queue is empty" text="No job is queued, leased or failed." />
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
                      {queueCounts.map((q) => (
                        <tr key={q.state}>
                          <td>{titleCase(q.state)}</td>
                          <td className="num">{num(q.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              {failures.length > 0 ? (
                <>
                  <div className="seclbl" style={{ marginTop: 14 }}>
                    Recent failures
                  </div>
                  <TableWrap>
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Stage</th>
                          <th>Error</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {failures.map((f) => (
                          <tr key={f.id}>
                            <td>{titleCase(f.stage)}</td>
                            <td className="small">{f.error || "—"}</td>
                            <td className="small dimtx">{fmtDateTime(f.failedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </>
              ) : null}
            </Card>
          </div>
        </>
      )}

      {audioTarget ? (
        <EnableAudioModal
          source={audioTarget}
          phrase={ackPhrase}
          busy={busy}
          onClose={() => setAudioTarget(null)}
          onConfirm={async (acknowledgement) => {
            const ok = await post(
              `${YC_API_PREFIX}/sources/${encodeURIComponent(audioTarget.key)}/audio-mode`,
              { mode: "OWNER_AUTHORIZED", acknowledgement },
              `Audio fetching authorized for ${audioTarget.name}.`,
            );
            if (ok) setAudioTarget(null);
          }}
        />
      ) : null}

      {rightsTarget ? (
        <RecordRightsModal
          source={rightsTarget}
          busy={busy}
          onClose={() => setRightsTarget(null)}
          onConfirm={async (body) => {
            const ok = await post(
              `${YC_API_PREFIX}/sources/${encodeURIComponent(rightsTarget.key)}/rights`,
              body,
              `Rights record saved for ${rightsTarget.name}.`,
            );
            if (ok) setRightsTarget(null);
          }}
        />
      ) : null}
    </YiddishPage>
  );
}

/**
 * ⛔ The deliberate human act. The button cannot be pressed until the typed
 *    text matches the phrase exactly — there is no click-through path, and the
 *    copy says whose decision this is and what it means.
 */
function EnableAudioModal({
  source,
  phrase,
  busy,
  onClose,
  onConfirm,
}: {
  source: YcSourceSummary;
  phrase: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (acknowledgement: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = useMemo(() => typed.trim() === phrase, [typed, phrase]);

  return (
    <Modal
      title={`Enable audio fetching — ${source.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="lbtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="lbtn danger" disabled={!matches || busy} onClick={() => onConfirm(typed.trim())}>
            Enable audio fetching
          </button>
        </>
      }
    >
      <div className="ylx">
        <div className="ack">
          <h4>This is your decision, and it is recorded against your name.</h4>
          <p>
            Enabling audio fetching for <b>{source.name}</b> tells the engine that a rights grant exists for this source&apos;s
            audio. From that point the audio stages — fetch, segment, speaker clustering, transcription and alignment — are
            allowed to run against it, subject to the budgets on this page.
          </p>
          <p>
            It does not create permission and it does not check for one. If no written grant exists, this switch makes the
            engine do something it is not permitted to do. Turn it on only when the grant is in hand.
          </p>
          {source.audioBlockedReason ? (
            <p>
              <b>The engine currently reports:</b> {source.audioBlockedReason}
            </p>
          ) : null}
          <p>
            Type <span className="phrase">{phrase}</span> to confirm.
          </p>
          <input
            className="linput mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={phrase}
            aria-label="Acknowledgement"
            autoComplete="off"
          />
          {typed.trim() && !matches ? <div className="help">That does not match the phrase yet.</div> : null}
        </div>
        <div className="small dimtx" style={{ marginTop: 10 }}>
          You can turn this off again at any time, and turning it off takes effect immediately.
        </div>
      </div>
    </Modal>
  );
}

function RecordRightsModal({
  source,
  busy,
  onClose,
  onConfirm,
}: {
  source: YcSourceSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: Record<string, unknown>) => void;
}) {
  const [allowedUse, setAllowedUse] = useState("metadata_only");
  const [rightsState, setRightsState] = useState("UNKNOWN");
  const [evidence, setEvidence] = useState("");

  return (
    <Modal
      title={`Record a rights decision — ${source.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="lbtn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="lbtn primary"
            disabled={busy || !evidence.trim()}
            onClick={() => onConfirm({ allowedUse, state: rightsState, evidence: evidence.trim() })}
          >
            Save rights record
          </button>
        </>
      }
    >
      <div className="ylx">
        <div className="form">
          <div className="field">
            <label htmlFor="rt-use">Allowed use</label>
            <ConnectSelect id="rt-use" value={allowedUse} onChange={setAllowedUse} options={ALLOWED_USE_OPTIONS} ariaLabel="Allowed use" />
          </div>
          <div className="field">
            <label htmlFor="rt-state">State</label>
            <ConnectSelect id="rt-state" value={rightsState} onChange={setRightsState} options={RIGHTS_STATE_OPTIONS} ariaLabel="Rights state" />
          </div>
          <label className="field full">
            <span>Evidence — where this permission comes from</span>
            <input
              className="linput"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="e.g. written permission from the publisher, dated and on file"
            />
            <div className="help">Required. A rights record with no stated basis is not a record of anything.</div>
          </label>
        </div>
      </div>
    </Modal>
  );
}
