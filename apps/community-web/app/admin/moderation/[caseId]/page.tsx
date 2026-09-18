"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Field, Skeleton, fmtDate, useToast } from "@/components/ui";

type Card = { id: string; name?: string; displayName?: string; username?: string; slug?: string; avatarAssetId?: string | null; logoAssetId?: string | null };
type SignalRow = { key: string; label: string; value: string | number; flagged?: boolean };
type ActionRow = { id: string; kind: string; note: string; userMessage: string | null; expiresAt: string | null; createdAt: string; moderatorId: string };
type AppealRow = { id: string; actionId: string; body: string; decision: string | null; decidedAt: string | null; createdAt: string; personId: string };
type ReportRow = { id: string; reason: string; details: string | null; createdAt: string; reporter: Card | null };
type AuditRow = { id: string; action: string; before: unknown; after: unknown; createdAt: string };

type CaseDetail = {
  id: string;
  targetType: string;
  targetId: string;
  target: { title: string; href: string | null };
  evidence: Record<string, unknown> | null;
  subject: Card | null;
  subjectKind: "person" | "organization" | null;
  reason: string;
  severity: string;
  status: string;
  reportCount: number;
  accountSignals: SignalRow[];
  assignedTo: Card | null;
  createdAt: string;
  reports: ReportRow[];
  actions: ActionRow[];
  priorActions: ActionRow[];
  appeals: AppealRow[];
  audit: AuditRow[];
};

const ACTION_KINDS = [
  { kind: "WARN", label: "Warn", needsDays: false, style: "" },
  { kind: "RESTRICT_OUTREACH", label: "Restrict outreach", needsDays: true, style: "p" },
  { kind: "REMOVE_CONTENT", label: "Remove content", needsDays: false, style: "" },
  { kind: "SUSPEND", label: "Suspend", needsDays: true, style: "d" },
  { kind: "BAN", label: "Ban", needsDays: false, style: "d" },
  { kind: "DISMISS", label: "Dismiss", needsDays: false, style: "g" },
] as const;

export default function ModerationCasePage() {
  const { caseId } = useParams<{ caseId: string }>();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<CaseDetail | null>(null);
  const [dialogKind, setDialogKind] = useState<(typeof ACTION_KINDS)[number] | null>(null);
  const [note, setNote] = useState("");
  const [userMessage, setUserMessage] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [decideOpen, setDecideOpen] = useState<AppealRow | null>(null);
  const [decideNote, setDecideNote] = useState("");

  const load = useCallback(() => {
    api<CaseDetail>(`/admin/moderation/cases/${caseId}`).then(setData);
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  async function assign() {
    await api(`/admin/moderation/cases/${caseId}/assign`, { method: "POST" });
    toast("Assigned to you.");
    load();
  }

  async function submitAction() {
    if (!dialogKind) return;
    if (note.trim().length < 10) return toast("Write at least 10 characters explaining why.", { kind: "err" });
    setBusy(true);
    try {
      await api(`/admin/moderation/cases/${caseId}/action`, {
        method: "POST",
        body: { kind: dialogKind.kind, note: note.trim(), userMessage: userMessage.trim() || undefined, days: dialogKind.needsDays ? Number(days) || 7 : undefined },
      });
      toast(`${dialogKind.label} applied.`);
      setDialogKind(null);
      setNote("");
      setUserMessage("");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function decideAppeal(decision: "GRANTED" | "DENIED") {
    if (!decideOpen) return;
    if (decideNote.trim().length < 1) return toast("Add a short note.", { kind: "err" });
    setBusy(true);
    try {
      await api(`/admin/moderation/appeals/${decideOpen.id}/decide`, { method: "POST", body: { decision, note: decideNote.trim() } });
      toast(`Appeal ${decision.toLowerCase()}.`);
      setDecideOpen(null);
      setDecideNote("");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Skeleton h={400} />;

  const subjectName = data.subject?.name || data.subject?.displayName || "(unknown)";
  const pendingAppeal = data.appeals.find((a) => !a.decidedAt);

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{data.reason.replace(/_/g, " ").toLowerCase()}</h1>
          <p className="sub" style={{ margin: 0 }}>
            Case opened {fmtDate(data.createdAt)} · {data.reportCount} report{data.reportCount === 1 ? "" : "s"} · <Chip>{data.status.toLowerCase()}</Chip>
          </p>
        </div>
        <div className="row">
          {data.assignedTo ? <Chip>Assigned: {data.assignedTo.name || data.assignedTo.displayName}</Chip> : <Button small kind="g" onClick={assign} data-testid="moderation-assign-me">Assign to me</Button>}
        </div>
      </div>

      <div className="two">
        <div className="col">
          <div className="card">
            <div className="ct">Target</div>
            <p className="sm">
              <b>{data.targetType}</b> — {data.target.href ? <Link href={data.target.href}>{data.target.title}</Link> : data.target.title}
            </p>
            {data.evidence ? (
              <div className="embed">
                <span className="k">Evidence</span>
                {Object.entries(data.evidence).map(([k, v]) => (
                  <p className="sm" key={k}>
                    <b>{k}:</b> {typeof v === "string" ? v : JSON.stringify(v)}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          {data.subject ? (
            <div className="card">
              <div className="ct">Subject</div>
              <div className="li">
                <Avatar name={subjectName} assetId={data.subject.avatarAssetId ?? data.subject.logoAssetId ?? null} size={40} />
                <div className="t">
                  <b>{subjectName}</b>
                  <small>{data.subjectKind}</small>
                </div>
              </div>
              {data.accountSignals.length ? (
                <dl className="kv sm" style={{ marginTop: 10 }}>
                  {data.accountSignals.map((s) => (
                    <Fragment key={s.key}>
                      <dt>{s.label}</dt>
                      <dd style={s.flagged ? { color: "var(--ink-danger)", fontWeight: 700 } : undefined}>{s.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : null}
            </div>
          ) : null}

          <div className="card">
            <div className="ct">Reports ({data.reports.length})</div>
            <div className="list sm">
              {data.reports.map((r) => (
                <div className="li" key={r.id}>
                  <div className="t">
                    <b>{r.reporter?.name || r.reporter?.displayName || "Someone"}</b> reported <Chip>{r.reason}</Chip>
                    {r.details ? <small>{r.details}</small> : null}
                    <small className="dim">{fmtDate(r.createdAt)}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {pendingAppeal ? (
            <div className="card">
              <div className="ct">Pending appeal</div>
              <p className="sm">{pendingAppeal.body}</p>
              <Button small onClick={() => setDecideOpen(pendingAppeal)} data-testid="moderation-decide-appeal">
                Decide appeal
              </Button>
            </div>
          ) : null}

          <div className="card">
            <div className="ct">Take action</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {ACTION_KINDS.map((k) => (
                <Button key={k.kind} small kind={k.style} onClick={() => setDialogKind(k)} data-testid={`moderation-action-${k.kind.toLowerCase()}`}>
                  {k.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="ct">This case's actions</div>
            <div className="list sm">
              {data.actions.length ? (
                data.actions.map((a) => (
                  <div className="li" key={a.id}>
                    <div className="t">
                      <b>{a.kind.replace(/_/g, " ")}</b>
                      <small>{a.note}</small>
                      <small className="dim">{fmtDate(a.createdAt)}</small>
                    </div>
                  </div>
                ))
              ) : (
                <p className="sm dim">No action taken yet.</p>
              )}
            </div>
          </div>

          {data.priorActions.length ? (
            <div className="card">
              <div className="ct">Prior actions on this subject</div>
              <div className="list sm">
                {data.priorActions.map((a) => (
                  <div className="li" key={a.id}>
                    <div className="t">
                      <b>{a.kind.replace(/_/g, " ")}</b>
                      <small className="dim">{fmtDate(a.createdAt)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="ct">Audit trail</div>
            <div className="list sm">
              {data.audit.length ? (
                data.audit.map((a) => (
                  <div className="li" key={a.id}>
                    <div className="t">
                      <b>{a.action}</b>
                      <small className="dim">{fmtDate(a.createdAt)}</small>
                    </div>
                  </div>
                ))
              ) : (
                <p className="sm dim">Nothing logged yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={!!dialogKind}
        onClose={() => setDialogKind(null)}
        title={dialogKind ? dialogKind.label : ""}
        footer={
          <>
            <Button kind="g" onClick={() => setDialogKind(null)}>
              Cancel
            </Button>
            <Button kind="p" onClick={submitAction} loading={busy} data-testid="moderation-action-submit">
              Confirm {dialogKind?.label}
            </Button>
          </>
        }
      >
        <Field label="Moderator note (required, at least 10 characters)" htmlFor="mod-note">
          <textarea id="mod-note" className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="moderation-note" />
        </Field>
        <Field label="Message the person sees (optional — a default plain-English sentence is used otherwise)" htmlFor="mod-user-msg">
          <textarea id="mod-user-msg" className="in" rows={2} value={userMessage} onChange={(e) => setUserMessage(e.target.value)} data-testid="moderation-user-message" />
        </Field>
        {dialogKind?.needsDays ? (
          <Field label="Days" htmlFor="mod-days">
            <input id="mod-days" className="in" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} data-testid="moderation-days" />
          </Field>
        ) : null}
      </Dialog>

      <Dialog
        open={!!decideOpen}
        onClose={() => setDecideOpen(null)}
        title="Decide appeal"
        footer={
          <>
            <Button kind="g d" onClick={() => decideAppeal("DENIED")} loading={busy} data-testid="moderation-appeal-deny">
              Deny
            </Button>
            <Button kind="p" onClick={() => decideAppeal("GRANTED")} loading={busy} data-testid="moderation-appeal-grant">
              Grant
            </Button>
          </>
        }
      >
        <p className="sm">{decideOpen?.body}</p>
        <Field label="Note" htmlFor="appeal-note">
          <textarea id="appeal-note" className="in" rows={3} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} />
        </Field>
      </Dialog>

      <Button kind="g" small onClick={() => router.push("/admin/moderation")}>
        Back to queue
      </Button>
    </div>
  );
}
