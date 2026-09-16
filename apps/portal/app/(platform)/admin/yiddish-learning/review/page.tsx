"use client";
/**
 * Yiddish Learning Engine — Review queue (mockup screen 5).
 *
 *  GET  /admin/yiddish/review            ?state&limit
 *  POST /admin/yiddish/review/:id/decide { decision, realization?, note? }
 *
 * Active learning: the engine asks the question whose answer resolves the
 * most occurrences first.
 *
 * ⛔ Customer-private items are never displayed here. The page says so, and
 *    if the engine ever returned one, the row renders walled (counts only)
 *    rather than showing content.
 */
import { useMemo, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { apiPost } from "../../../../../services/apiClient";
import {
  Card,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  LoadingCard,
  Note,
  OwnerOnlyNotice,
  PageHead,
  ServingOnlyChip,
  TableWrap,
  YC_API_PREFIX,
  YC_CUSTOMER_WALL_MESSAGE,
  YiddishPage,
  YiddishText,
  errText,
  listFrom,
  num,
  pct,
  titleCase,
  useApi,
  type YcVariantScore,
} from "../YiddishUi";

type ReviewItem = {
  id: string;
  question?: string | null;
  kind?: string | null;
  state?: string | null;
  lemma?: string | null;
  text?: string | null;
  context?: string | null;
  occurrences?: number | null;
  sourceKey?: string | null;
  governanceClass?: string | null;
  trainingExportEligibility?: string | null;
  contentAllowed?: boolean;
  ylDerived?: boolean;
  variants?: YcVariantScore[];
};
type ReviewResponse = { items?: ReviewItem[]; rows?: ReviewItem[]; total?: number };

const STATE_OPTIONS = [
  { value: "", label: "All open questions" },
  { value: "NEEDS_REVIEW", label: "Needs review" },
  { value: "QUEUED", label: "Queued" },
  { value: "LEARNED", label: "Learned" },
  { value: "SKIPPED", label: "Deferred / skipped" },
];

type Decision = "approve" | "reject" | "edit" | "variant" | "defer";

export default function ReviewQueuePage() {
  const { role } = useAppContext();
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [realization, setRealization] = useState("");
  const [comment, setComment] = useState("");

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (stateFilter) p.set("state", stateFilter);
    p.set("limit", "50");
    return `${YC_API_PREFIX}/review?${p.toString()}`;
  }, [stateFilter]);

  const queue = useApi<ReviewResponse>(path);
  const items = listFrom<ReviewItem>(queue.data?.items ?? queue.data?.rows ?? queue.data, "items");
  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Review queue" />;

  const decide = async (decision: Decision) => {
    if (!selected) return;
    if ((decision === "edit" || decision === "variant") && !realization.trim()) {
      setNote({ kind: "bad", text: "Type the realization first — an edit with no value would write nothing." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const body: Record<string, unknown> = { decision };
      if (realization.trim()) body.realization = realization.trim();
      if (comment.trim()) body.note = comment.trim();
      await apiPost(`${YC_API_PREFIX}/review/${encodeURIComponent(selected.id)}/decide`, body);
      setNote({ kind: "ok", text: `Recorded: ${decision}.` });
      setRealization("");
      setComment("");
      setSelectedId(null);
      queue.reload();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "The decision was not recorded.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <YiddishPage>
      <PageHead
        title="Review queue"
        subtitle="The engine asks the question whose answer resolves the most occurrences first."
        actions={
          <>
            <div style={{ minWidth: 210 }}>
              <ConnectSelect value={stateFilter} onChange={setStateFilter} options={STATE_OPTIONS} size="sm" ariaLabel="Queue state" />
            </div>
            <button className="lbtn sm" onClick={queue.reload}>
              Refresh
            </button>
          </>
        }
      />
      <Note note={note} />

      {queue.loading && queue.data == null ? (
        <LoadingCard rows={4} label="Loading the review queue" />
      ) : queue.error ? (
        <ErrorCard error={queue.error} what="The review queue" onRetry={queue.reload} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing waiting for review"
            text="The engine has no open questions. It asks only when processed evidence is genuinely ambiguous — an empty queue means nothing is ambiguous, not that review is switched off."
          />
        </Card>
      ) : (
        <div className="g2">
          <Card title="Prioritized" sub={`${num(queue.data?.total ?? items.length)} open`}>
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Word</th>
                    <th className="num">Resolves</th>
                    <th>Class</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} style={selected?.id === it.id ? { background: "color-mix(in srgb, var(--accent) 7%, transparent)" } : undefined}>
                      <td>
                        <b>{it.question || titleCase(it.kind)}</b>
                        <span className="sub">{it.sourceKey || "—"}</span>
                      </td>
                      <td>{it.contentAllowed === false ? <span className="dimtx small">Walled</span> : <YiddishText text={it.lemma ?? it.text} />}</td>
                      <td className="num">{num(it.occurrences)}</td>
                      <td>
                        <GovernanceChip value={it.governanceClass} />
                      </td>
                      <td>
                        <button className="lbtn sm" onClick={() => setSelectedId(it.id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="small dimtx" style={{ marginTop: 8 }}>{YC_CUSTOMER_WALL_MESSAGE}</div>
          </Card>

          <Card title="Decide" sub={selected ? selected.question || titleCase(selected.kind) : undefined}>
            {!selected ? (
              <EmptyState title="Nothing selected" text="Pick a question on the left." />
            ) : selected.contentAllowed === false ? (
              <EmptyState
                title="This item is behind the customer data wall"
                text={YC_CUSTOMER_WALL_MESSAGE}
              />
            ) : (
              <>
                <div style={{ marginBottom: 10 }}>
                  <YiddishText text={selected.lemma ?? selected.text} className="big" block />
                  {selected.context ? (
                    <div className="small dimtx" style={{ marginTop: 6 }}>
                      Context: <YiddishText text={selected.context} />
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    <GovernanceChip value={selected.governanceClass} />
                    <EligibilityChip value={selected.trainingExportEligibility} />
                    {selected.ylDerived ? <ServingOnlyChip /> : null}
                    <span className="pill dim">Resolves {num(selected.occurrences)} occurrences</span>
                  </div>
                </div>

                {(selected.variants ?? []).length > 0 ? (
                  <TableWrap>
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Variant</th>
                          <th>Realization</th>
                          <th className="num">Share</th>
                          <th className="num">Score</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {(selected.variants ?? []).map((v) => (
                          <tr key={v.variantKey}>
                            <td className="mono small">{v.variantKey}</td>
                            <td className="mono small">{v.realization || "—"}</td>
                            <td className="num">{pct(v.share, 1)}</td>
                            <td className="num">{v.score == null ? "—" : v.score.toFixed(2)}</td>
                            <td>
                              <button className="lbtn sm" onClick={() => setRealization(v.realization ?? v.variantKey)}>
                                Use
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                ) : (
                  <div className="small dimtx">The engine reported no scored variants for this question.</div>
                )}

                <div className="form" style={{ marginTop: 14 }}>
                  <label className="field full">
                    <span>Realization (for Edit or a new Variant)</span>
                    <input className="linput mono" value={realization} onChange={(e) => setRealization(e.target.value)} placeholder="e.g. a phonetic realization" />
                  </label>
                  <label className="field full">
                    <span>Note (optional)</span>
                    <input className="linput" value={comment} onChange={(e) => setComment(e.target.value)} />
                  </label>
                </div>

                <div className="row" style={{ marginTop: 12 }}>
                  <button className="lbtn primary" disabled={busy} onClick={() => decide("approve")}>
                    Approve
                  </button>
                  <button className="lbtn danger" disabled={busy} onClick={() => decide("reject")}>
                    Reject
                  </button>
                  <button className="lbtn" disabled={busy} onClick={() => decide("edit")}>
                    Edit
                  </button>
                  <button className="lbtn" disabled={busy} onClick={() => decide("variant")}>
                    Record as variant
                  </button>
                  <button className="lbtn ghost" disabled={busy} onClick={() => decide("defer")}>
                    Defer
                  </button>
                </div>
                <div className="help" style={{ marginTop: 8 }}>
                  A decision is recorded against this question only. Approving does not promote a rule to production — promotion
                  needs a benchmark run and a named approver on the Governance screen.
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </YiddishPage>
  );
}
