"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Chip, Dialog, Empty, Field, Skeleton, fmtDate, useToast } from "@/components/ui";

type MyModeration = {
  actions: Array<{ id: string; kind: string; message: string; createdAt: string; expiresAt: string | null; canAppeal: boolean }>;
  restrictions: Array<{ kind: string; reason: string; expiresAt: string | null }>;
  appeals: Array<{ id: string; actionId: string; body: string; decision: string | null; decidedAt: string | null; createdAt: string }>;
};

export default function AccountNoticesPage() {
  const toast = useToast();
  const [data, setData] = useState<MyModeration | null>(null);
  const [appealing, setAppealing] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<MyModeration>("/me/moderation").then(setData);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submitAppeal() {
    if (!appealing) return;
    if (body.trim().length < 10) return toast("Write at least 10 characters.", { kind: "err" });
    setBusy(true);
    try {
      await api("/appeals", { method: "POST", body: { actionId: appealing, body: body.trim() } });
      toast("Appeal sent.");
      setAppealing(null);
      setBody("");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Skeleton h={200} />;

  return (
    <>
      <div className="card">
        <div className="ct">Account notices</div>
        {data.restrictions.length ? (
          <div className="list sm" style={{ marginBottom: 12 }}>
            {data.restrictions.map((r, i) => (
              <div className="li" key={i}>
                <div className="t">
                  <b>{r.kind.replace(/_/g, " ")}</b>
                  <small>{r.reason}</small>
                  <small className="dim">{r.expiresAt ? `Until ${fmtDate(r.expiresAt)}` : "No end date"}</small>
                </div>
                <Chip kind="warn">active</Chip>
              </div>
            ))}
          </div>
        ) : null}
        {data.actions.length ? (
          <div className="list sm">
            {data.actions.map((a) => {
              const appeal = data.appeals.find((ap) => ap.actionId === a.id);
              return (
                <div className="li" key={a.id}>
                  <div className="t">
                    <b>{a.kind.replace(/_/g, " ")}</b>
                    <small>{a.message}</small>
                    <small className="dim">{fmtDate(a.createdAt)}</small>
                    {appeal ? <small className="dim">Appeal: {appeal.decision ? appeal.decision.toLowerCase() : "pending review"}</small> : null}
                  </div>
                  {a.canAppeal ? (
                    <Button small kind="g" onClick={() => setAppealing(a.id)} data-testid={`notices-appeal-${a.id}`}>
                      Appeal
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty title="Nothing here" text="No moderation notices on your account." />
        )}
      </div>

      <Dialog
        open={!!appealing}
        onClose={() => setAppealing(null)}
        title="Appeal this action"
        footer={
          <>
            <Button kind="g" onClick={() => setAppealing(null)}>
              Cancel
            </Button>
            <Button kind="p" onClick={submitAppeal} loading={busy} data-testid="notices-appeal-submit">
              Send appeal
            </Button>
          </>
        }
      >
        <Field label="Tell us why this should be reversed" htmlFor="notices-appeal-body">
          <textarea id="notices-appeal-body" className="in" rows={4} value={body} onChange={(e) => setBody(e.target.value)} data-testid="notices-appeal-body" />
        </Field>
      </Dialog>
    </>
  );
}
