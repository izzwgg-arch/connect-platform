"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Field, Icon, Menu, Skeleton, fmtDate, fmtMoney, useToast } from "@/components/ui";
import { Uploader, type UploadedAsset } from "@/components/media/Uploader";
import "@/components/rfq/rfq.css";

type Card = { id: string; name?: string; username?: string; displayName?: string; avatarAssetId?: string | null; logoAssetId?: string | null; slug?: string };

type Quote = {
  id: string;
  rfqId: string;
  organization: Card | null;
  authorId: string;
  total: string;
  currency: string;
  perUnit: string | null;
  deliveryDate: string | null;
  validUntil: string | null;
  notes: string | null;
  alternateProposal: string | null;
  status: string;
  version: number;
  threadId: string | null;
  attachments: Array<{ id: string; url: string; mime: string; kind: string }>;
  createdAt: string;
};

type Question = {
  id: string;
  rfqId: string;
  organization: Card | null;
  askedBy: Card | null;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  isPublic: boolean;
  createdAt: string;
};

type RfqDetail = {
  id: string;
  number: string;
  title: string;
  description: string;
  status: string;
  visibility: string;
  category: { id: string; slug: string; name: string } | null;
  quantity: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  location: string | null;
  deadline: string | null;
  requirements: string[];
  closesAt: string | null;
  createdAt: string;
  buyer: Card | null;
  organization: Card | null;
  attachments: Array<{ id: string; url: string; mime: string; kind: string; originalName: string | null }>;
  stats: { invited: number; viewed: number; quoted: number; declined: number };
  quotes: Quote[];
  questions: Question[];
  timeline: Array<{ label: string; at: string }>;
  myRole: "buyer" | "vendor" | "visitor";
  myOrgOptions: Array<{ id: string; slug: string; displayName: string }>;
  canEdit: boolean;
};

const STATUS_KIND: Record<string, "" | "ok" | "warn" | "bad" | "ac"> = { OPEN: "ok", SHORTLISTING: "warn", ACCEPTED: "ac", CLOSED: "", CANCELLED: "bad" };
const QUOTE_KIND: Record<string, "" | "ok" | "warn" | "bad" | "ac"> = { SUBMITTED: "ac", SHORTLISTED: "warn", ACCEPTED: "ok", DECLINED: "bad", WITHDRAWN: "" };

function budgetLabel(rfq: RfqDetail): string | null {
  if (rfq.budgetMin && rfq.budgetMax) return `${fmtMoney(rfq.budgetMin)} – ${fmtMoney(rfq.budgetMax)}`;
  if (rfq.budgetMax) return `Under ${fmtMoney(rfq.budgetMax)}`;
  if (rfq.budgetMin) return `From ${fmtMoney(rfq.budgetMin)}`;
  return null;
}

export default function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();

  const [rfq, setRfq] = useState<RfqDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound404, setNotFound404] = useState(false);
  const [quoteDialog, setQuoteDialog] = useState<Quote | null | "new">(null);
  const [acceptTarget, setAcceptTarget] = useState<Quote | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Question | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<RfqDetail>(`/public/rfq/${id}`);
      setRfq(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound404(true);
      else toast(e instanceof ApiError ? e.message : "Couldn't load that request.", { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (rfq?.myRole === "vendor" && rfq.myOrgOptions.length) {
      void api("/rfq/" + id + "/view", { method: "POST", body: { organizationId: rfq.myOrgOptions[0].id } }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq?.id, rfq?.myRole]);

  const isBuyer = rfq?.myRole === "buyer";
  const myQuote = useMemo(() => (rfq && !isBuyer ? rfq.quotes.find((q) => rfq.myOrgOptions.some((o) => o.id === q.organization?.id)) : undefined), [rfq, isBuyer]);

  async function shareLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy the link.", { kind: "err" });
    }
  }

  async function closeRfq() {
    if (!rfq) return;
    try {
      await api(`/rfq/${rfq.id}/close`, { method: "POST" });
      toast("Request closed.");
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't close that.", { kind: "err" });
    }
  }

  async function decline(organizationId: string) {
    if (!rfq) return;
    try {
      await api(`/rfq/${rfq.id}/decline`, { method: "POST", body: { organizationId } });
      toast("Declined.");
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't decline that.", { kind: "err" });
    }
  }

  async function withdraw(qid: string) {
    if (!rfq) return;
    try {
      await api(`/rfq/${rfq.id}/quotes/${qid}/withdraw`, { method: "POST" });
      toast("Quote withdrawn.");
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't withdraw that.", { kind: "err" });
    }
  }

  async function shortlist(qid: string) {
    if (!rfq) return;
    try {
      await api(`/rfq/${rfq.id}/quotes/${qid}/shortlist`, { method: "POST" });
      toast("Shortlisted.");
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't shortlist that.", { kind: "err" });
    }
  }

  async function declineQuote(qid: string) {
    if (!rfq) return;
    try {
      await api(`/rfq/${rfq.id}/quotes/${qid}/decline`, { method: "POST" });
      toast("Quote declined.");
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't decline that quote.", { kind: "err" });
    }
  }

  async function accept() {
    if (!rfq || !acceptTarget) return;
    try {
      await api(`/rfq/${rfq.id}/quotes/${acceptTarget.id}/accept`, { method: "POST", idempotencyKey: newIdempotencyKey() });
      toast("Quote accepted.");
      setAcceptTarget(null);
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't accept that quote.", { kind: "err" });
    }
  }

  async function message(q: Quote) {
    if (!rfq) return;
    try {
      const r = await api<{ threadId: string }>(`/rfq/${rfq.id}/quotes/${q.id}/thread`, { method: "POST" });
      router.push(`/messages/${r.threadId}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't open that conversation.", { kind: "err" });
    }
  }

  if (loading) {
    return (
      <AppShell cols="two" title="Loading request…">
        <div className="col"><Skeleton h={220} /></div>
        <div className="col"><Skeleton h={220} /></div>
      </AppShell>
    );
  }
  if (notFound404 || !rfq) {
    return (
      <AppShell title="Request not found">
        <div className="col" style={{ gridColumn: "1/-1" }}>
          <Empty title="That request wasn't found" text="It may have been removed, or it isn't visible to you." />
        </div>
      </AppShell>
    );
  }

  const budget = budgetLabel(rfq);

  return (
    <AppShell cols="two" title={rfq.title}>
      <div className="col">
        <div className="card hair" data-testid="rfq-detail-header">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row xs">
              <Chip kind={STATUS_KIND[rfq.status] ?? ""} icon={rfq.status === "OPEN" ? "check" : undefined}>
                {rfq.status === "OPEN" ? `Open${rfq.closesAt ? ` · closes ${fmtDate(rfq.closesAt)}` : ""}` : rfq.status[0] + rfq.status.slice(1).toLowerCase()}
              </Chip>
              <Chip>{rfq.number}</Chip>
            </div>
            <div className="row">
              {rfq.canEdit ? (
                <Button kind="g" small icon="edit" href={`/rfq/${rfq.id}/edit`} data-testid="rfq-detail-edit">
                  Edit
                </Button>
              ) : null}
              <Button kind="g" small icon="share" onClick={() => void shareLink()} data-testid="rfq-detail-share">
                Share
              </Button>
              {isBuyer && (rfq.status === "OPEN" || rfq.status === "SHORTLISTING") ? (
                <Button kind="" small onClick={() => void closeRfq()} data-testid="rfq-detail-close">
                  Close request
                </Button>
              ) : null}
            </div>
          </div>
          <h2 style={{ fontSize: 19, marginTop: 10 }}>{rfq.title}</h2>
          <p className="sm" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
            {rfq.description}
          </p>
          <div className="grid3" style={{ marginTop: 12 }}>
            {rfq.category ? (
              <div className="rfq-field">
                <small>Category</small>
                <b className="sm">{rfq.category.name}</b>
              </div>
            ) : null}
            {rfq.quantity ? (
              <div className="rfq-field">
                <small>Quantity</small>
                <b className="sm">{rfq.quantity}</b>
              </div>
            ) : null}
            {budget ? (
              <div className="rfq-field">
                <small>Budget</small>
                <b className="sm">{budget}</b>
              </div>
            ) : null}
            {rfq.deadline ? (
              <div className="rfq-field">
                <small>Deadline</small>
                <b className="sm">{fmtDate(rfq.deadline)}</b>
              </div>
            ) : null}
            {rfq.location ? (
              <div className="rfq-field">
                <small>Location</small>
                <b className="sm">{rfq.location}</b>
              </div>
            ) : null}
            {rfq.requirements.length ? (
              <div className="rfq-field">
                <small>Requirements</small>
                <b className="sm">{rfq.requirements.join(" · ")}</b>
              </div>
            ) : null}
          </div>
          {rfq.attachments.length ? (
            <div className="row xs dim" style={{ marginTop: 10, flexWrap: "wrap" }}>
              {rfq.attachments.map((a) => (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="row xs">
                  <Icon name="paper" />
                  {a.originalName ?? "Attachment"}
                </a>
              ))}
            </div>
          ) : null}
          {isBuyer ? (
            <div className="row xs dim" style={{ marginTop: 10 }}>
              Notified {rfq.stats.invited} matching vendor{rfq.stats.invited === 1 ? "" : "s"} · {rfq.stats.viewed} viewed · {rfq.stats.quoted} quoted · {rfq.stats.declined} declined
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="ct">
            Quotes <Chip kind="ac">{rfq.quotes.length}</Chip>
            {rfq.quotes.length > 1 ? (
              <button type="button" className="more" onClick={() => setCompareOpen(true)} data-testid="rfq-detail-compare">
                Compare side by side
              </button>
            ) : null}
          </div>
          {rfq.quotes.length ? (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th className="num">Total</th>
                    <th className="num">Per unit</th>
                    <th>Delivery</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rfq.quotes.map((q) => (
                    <tr key={q.id} data-testid={`rfq-quote-row-${q.id}`}>
                      <td>
                        <div className="row">
                          <Avatar name={q.organization?.displayName ?? "Vendor"} assetId={q.organization?.logoAssetId} size={28} square />
                          <b>{q.organization?.displayName ?? "Vendor"}</b>
                        </div>
                      </td>
                      <td className="num mono">
                        <b>{fmtMoney(q.total, q.currency)}</b>
                      </td>
                      <td className="num mono dim">{q.perUnit ? fmtMoney(q.perUnit, q.currency) : "—"}</td>
                      <td className="mono">{q.deliveryDate ? fmtDate(q.deliveryDate) : "—"}</td>
                      <td>
                        <Chip kind={QUOTE_KIND[q.status] ?? ""}>{q.status[0] + q.status.slice(1).toLowerCase()}</Chip>
                      </td>
                      <td>
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <Button kind="" small icon="msg" onClick={() => void message(q)} data-testid={`rfq-quote-message-${q.id}`}>
                            Message
                          </Button>
                          {isBuyer && (q.status === "SUBMITTED" || q.status === "SHORTLISTED") ? (
                            <>
                              <Button kind="p" small onClick={() => setAcceptTarget(q)} data-testid={`rfq-quote-accept-${q.id}`}>
                                Accept
                              </Button>
                              <Menu testId={`rfq-quote-menu-${q.id}`}>
                                {q.status === "SUBMITTED" ? (
                                  <button type="button" onClick={() => void shortlist(q.id)} data-testid={`rfq-quote-shortlist-${q.id}`}>
                                    Shortlist
                                  </button>
                                ) : null}
                                <button type="button" onClick={() => void declineQuote(q.id)} data-testid={`rfq-quote-decline-${q.id}`}>
                                  Decline
                                </button>
                              </Menu>
                            </>
                          ) : null}
                          {!isBuyer && myQuote?.id === q.id && (q.status === "SUBMITTED" || q.status === "SHORTLISTED") ? (
                            <>
                              <Button kind="g" small onClick={() => setQuoteDialog(q)} data-testid={`rfq-quote-edit-${q.id}`}>
                                Edit
                              </Button>
                              <Button kind="g" small onClick={() => void withdraw(q.id)} data-testid={`rfq-quote-withdraw-${q.id}`}>
                                Withdraw
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No quotes yet" text={isBuyer ? "Invited vendors haven't quoted this request yet." : undefined} />
          )}
        </div>

        <div className="card">
          <div className="ct">
            Questions <span className="more">{rfq.questions.length}</span>
            {!isBuyer && rfq.myOrgOptions.length ? (
              <button type="button" className="more" onClick={() => setAskOpen(true)} data-testid="rfq-detail-ask">
                Ask a question
              </button>
            ) : null}
          </div>
          {rfq.questions.length ? (
            <div className="list sm">
              {rfq.questions.map((q) => (
                <div className="li" key={q.id} data-testid={`rfq-question-${q.id}`}>
                  <Avatar name={q.organization?.displayName ?? "Vendor"} assetId={q.organization?.logoAssetId} size={30} square />
                  <div className="t">
                    <b>{q.question}</b>
                    <small>
                      {q.organization?.displayName ?? "Vendor"} · {fmtDate(q.createdAt)}
                    </small>
                    {q.answer ? <p style={{ marginTop: 4 }}>You: “{q.answer}”</p> : null}
                  </div>
                  {isBuyer && !q.answer ? (
                    <Button kind="" small onClick={() => setReplyTarget(q)} data-testid={`rfq-question-reply-${q.id}`}>
                      Reply
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No questions yet" />
          )}
        </div>
      </div>

      <div className="col">
        <div className="card">
          <div className="ct">Timeline</div>
          <div className="list sm">
            {rfq.timeline.map((t, i) => (
              <div className="li" key={i}>
                <span className="sev" style={{ background: "var(--border)" }} />
                <div className="t">
                  <b>{t.label}</b>
                  <small className="mono">{fmtDate(t.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as any)}</small>
                </div>
              </div>
            ))}
          </div>
        </div>

        {!isBuyer ? (
          <div className="card">
            <div className="ct">As a vendor</div>
            {!me ? (
              <>
                <p className="sm dim">Sign in as a business to send a quote or ask a question.</p>
                <Button kind="p" href="/login" small>
                  Sign in
                </Button>
              </>
            ) : !rfq.myOrgOptions.length ? (
              <p className="sm dim">You need a company page with quoting permission to respond to this request.</p>
            ) : myQuote ? (
              <p className="sm dim">Your quote status: {myQuote.status[0] + myQuote.status.slice(1).toLowerCase()}.</p>
            ) : (
              <>
                <p className="sm dim">You've been invited to quote on this request.</p>
                <div className="row" style={{ marginTop: 8 }}>
                  <Button kind="p" small onClick={() => setQuoteDialog("new")} data-testid="rfq-detail-quote">
                    Quote
                  </Button>
                  <Button kind="g" small onClick={() => void decline(rfq.myOrgOptions[0].id)} data-testid="rfq-detail-decline">
                    Decline
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {compareOpen ? <CompareDialog rfq={rfq} onClose={() => setCompareOpen(false)} /> : null}
      {quoteDialog ? (
        <QuoteDialog
          rfq={rfq}
          existing={quoteDialog === "new" ? null : quoteDialog}
          onClose={() => setQuoteDialog(null)}
          onSaved={() => {
            setQuoteDialog(null);
            void load();
          }}
        />
      ) : null}
      <Dialog open={!!acceptTarget} onClose={() => setAcceptTarget(null)} title="Accept this quote?" footer={
        <>
          <Button kind="g" onClick={() => setAcceptTarget(null)}>Cancel</Button>
          <Button kind="p" onClick={() => void accept()} data-testid="rfq-accept-confirm">Accept quote</Button>
        </>
      }>
        <p className="sm">Accepting closes this request to other vendors — every other quote is declined automatically. This can't be undone.</p>
      </Dialog>
      {replyTarget ? <ReplyDialog rfqId={rfq.id} question={replyTarget} onClose={() => setReplyTarget(null)} onSaved={() => { setReplyTarget(null); void load(); }} /> : null}
      {askOpen && rfq.myOrgOptions.length ? (
        <AskDialog rfqId={rfq.id} organizationId={rfq.myOrgOptions[0].id} onClose={() => setAskOpen(false)} onSaved={() => { setAskOpen(false); void load(); }} />
      ) : null}
    </AppShell>
  );
}

function CompareDialog({ rfq, onClose }: { rfq: RfqDetail; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Compare quotes" wide>
      <div className="rfq-compare" data-testid="rfq-compare-dialog">
        {rfq.quotes.map((q) => (
          <div className="card tight" key={q.id}>
            <b>{q.organization?.displayName ?? "Vendor"}</b>
            <dl className="kv sm" style={{ marginTop: 8 }}>
              <dt>Total</dt>
              <dd>{fmtMoney(q.total, q.currency)}</dd>
              <dt>Per unit</dt>
              <dd>{q.perUnit ? fmtMoney(q.perUnit, q.currency) : "—"}</dd>
              <dt>Delivery</dt>
              <dd>{q.deliveryDate ? fmtDate(q.deliveryDate) : "—"}</dd>
              <dt>Valid until</dt>
              <dd>{q.validUntil ? fmtDate(q.validUntil) : "—"}</dd>
              <dt>Status</dt>
              <dd>{q.status}</dd>
            </dl>
            {q.notes ? <p className="sm" style={{ marginTop: 8 }}>{q.notes}</p> : null}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function QuoteDialog({ rfq, existing, onClose, onSaved }: { rfq: RfqDetail; existing: Quote | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [organizationId, setOrganizationId] = useState(existing?.organization?.id ?? rfq.myOrgOptions[0]?.id ?? "");
  const [total, setTotal] = useState(existing?.total ?? "");
  const [perUnit, setPerUnit] = useState(existing?.perUnit ?? "");
  const [deliveryDate, setDeliveryDate] = useState(existing?.deliveryDate?.slice(0, 10) ?? "");
  const [validUntil, setValidUntil] = useState(existing?.validUntil?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [alternateProposal, setAlternateProposal] = useState(existing?.alternateProposal ?? "");
  const [attachments, setAttachments] = useState<UploadedAsset[]>([]);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!total.trim()) {
      toast("Enter a total.", { kind: "err" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        organizationId,
        total: Number(total),
        perUnit: perUnit ? Number(perUnit) : undefined,
        deliveryDate: deliveryDate || undefined,
        validUntil: validUntil || undefined,
        notes: notes || undefined,
        alternateProposal: alternateProposal || undefined,
        attachmentAssetIds: attachments.map((a) => a.id),
      };
      if (existing) await api(`/rfq/${rfq.id}/quotes/${existing.id}`, { method: "PATCH", body, idempotencyKey: newIdempotencyKey() });
      else await api(`/rfq/${rfq.id}/quotes`, { method: "POST", body, idempotencyKey: newIdempotencyKey() });
      toast(existing ? "Quote updated." : "Quote sent.");
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that quote.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? "Edit your quote" : "Submit a quote"}
      footer={
        <>
          <Button kind="g" onClick={onClose}>Cancel</Button>
          <Button kind="p" loading={saving} onClick={() => void save()} data-testid="rfq-quote-save">
            {existing ? "Save changes" : "Send quote"}
          </Button>
        </>
      }
    >
      {rfq.myOrgOptions.length > 1 && !existing ? (
        <Field label="Quoting as" htmlFor="qd-org">
          <select id="qd-org" className="in" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
            {rfq.myOrgOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="grid2">
        <Field label="Total ($)" htmlFor="qd-total">
          <input id="qd-total" className="in" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} data-testid="rfq-quote-total" />
        </Field>
        <Field label="Per unit ($, optional)" htmlFor="qd-perunit">
          <input id="qd-perunit" className="in" inputMode="decimal" value={perUnit} onChange={(e) => setPerUnit(e.target.value)} />
        </Field>
        <Field label="Delivery date" htmlFor="qd-delivery">
          <input id="qd-delivery" type="date" className="in" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
        </Field>
        <Field label="Valid until" htmlFor="qd-valid">
          <input id="qd-valid" type="date" className="in" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="qd-notes">
        <textarea id="qd-notes" className="rfq-textarea" style={{ minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="Alternate proposal (optional)" htmlFor="qd-alt">
        <textarea id="qd-alt" className="rfq-textarea" style={{ minHeight: 60 }} value={alternateProposal} onChange={(e) => setAlternateProposal(e.target.value)} />
      </Field>
      <Uploader accept={["image", "document"]} multiple maxFiles={4} onChange={setAttachments} testId="rfq-quote-uploader" />
    </Dialog>
  );
}

function ReplyDialog({ rfqId, question, onClose, onSaved }: { rfqId: string; question: Question; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!answer.trim()) return;
    setSaving(true);
    try {
      await api(`/rfq/${rfqId}/questions/${question.id}/answer`, { method: "POST", body: { answer: answer.trim(), isPublic } });
      toast("Answer sent.");
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't send that answer.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Reply" footer={
      <>
        <Button kind="g" onClick={onClose}>Cancel</Button>
        <Button kind="p" loading={saving} onClick={() => void save()} data-testid="rfq-reply-send">Send</Button>
      </>
    }>
      <p className="sm dim">{question.question}</p>
      <Field label="Your answer" htmlFor="reply-answer">
        <textarea id="reply-answer" className="rfq-textarea" style={{ minHeight: 80 }} value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="rfq-reply-text" />
      </Field>
    </Dialog>
  );
}

function AskDialog({ rfqId, organizationId, onClose, onSaved }: { rfqId: string; organizationId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!question.trim()) return;
    setSaving(true);
    try {
      await api(`/rfq/${rfqId}/questions`, { method: "POST", body: { organizationId, question: question.trim() } });
      toast("Question sent.");
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't send that question.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Ask a question" footer={
      <>
        <Button kind="g" onClick={onClose}>Cancel</Button>
        <Button kind="p" loading={saving} onClick={() => void save()} data-testid="rfq-ask-send">Send</Button>
      </>
    }>
      <Field label="Your question" htmlFor="ask-question">
        <textarea id="ask-question" className="rfq-textarea" style={{ minHeight: 80 }} value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="rfq-ask-text" />
      </Field>
    </Dialog>
  );
}
