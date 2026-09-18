"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Field, Skeleton, fmtDate, useToast } from "@/components/ui";

type UserDetail = {
  person: { id: string; username: string; name: string; email: string | null; phoneE164: string | null; status: string; createdAt: string; avatarAssetId: string | null };
  sessionsCount: number;
  restrictions: Array<{ id: string; kind: string; reason: string; expiresAt: string | null; createdAt: string }>;
  actions: Array<{ id: string; kind: string; note: string; createdAt: string }>;
  memberships: Array<{ id: string; role: string; organization: { id: string; slug: string; displayName: string } }>;
  staffRole: string | null;
  audit: Array<{ id: string; action: string; createdAt: string }>;
};

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [data, setData] = useState<UserDetail | null>(null);
  const [statusOpen, setStatusOpen] = useState<"ACTIVE" | "SUSPENDED" | "BANNED" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<UserDetail>(`/admin/users/${id}`).then(setData);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function applyStatus() {
    if (!statusOpen) return;
    if (note.trim().length < 5) return toast("Add a short note (at least 5 characters).", { kind: "err" });
    setBusy(true);
    try {
      await api(`/admin/users/${id}/status`, { method: "POST", body: { status: statusOpen, note: note.trim() } });
      toast(`Status set to ${statusOpen.toLowerCase()}.`);
      setStatusOpen(null);
      setNote("");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function setStaffRole(role: "MODERATOR" | "ADMIN" | null) {
    await api(`/admin/users/${id}/staff`, { method: "POST", body: { role } });
    toast(role ? `Granted ${role}.` : "Staff access removed.");
    load();
  }

  async function verifyEmail() {
    try {
      await api(`/admin/users/${id}/verify-email`, { method: "POST" });
      toast("Email marked verified.");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  if (!data) return <Skeleton h={300} />;
  const p = data.person;

  return (
    <div className="col">
      <div className="row">
        <Avatar name={p.name} assetId={p.avatarAssetId} size={48} />
        <div>
          <h1 style={{ margin: 0 }}>{p.name}</h1>
          <p className="sub" style={{ margin: 0 }}>
            @{p.username} · {p.email || "no email"} · <Chip>{p.status.toLowerCase()}</Chip>
          </p>
        </div>
      </div>

      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button small kind="g" onClick={() => setStatusOpen("ACTIVE")} data-testid="admin-user-set-active">
          Set active
        </Button>
        <Button small kind="" onClick={() => setStatusOpen("SUSPENDED")} data-testid="admin-user-set-suspended">
          Suspend
        </Button>
        <Button small kind="d" onClick={() => setStatusOpen("BANNED")} data-testid="admin-user-set-banned">
          Ban
        </Button>
        {p.email ? (
          <Button small kind="g" onClick={verifyEmail} data-testid="admin-user-verify-email">
            Mark email verified
          </Button>
        ) : null}
        {data.staffRole ? (
          <Button small kind="g d" onClick={() => setStaffRole(null)} data-testid="admin-user-remove-staff">
            Remove staff access
          </Button>
        ) : (
          <>
            <Button small kind="g" onClick={() => setStaffRole("MODERATOR")} data-testid="admin-user-grant-moderator">
              Grant moderator
            </Button>
            <Button small kind="g" onClick={() => setStaffRole("ADMIN")} data-testid="admin-user-grant-admin">
              Grant admin
            </Button>
          </>
        )}
      </div>

      <div className="two">
        <div className="col">
          <div className="card">
            <div className="ct">Account</div>
            <dl className="kv sm">
              <dt>Phone</dt>
              <dd>{p.phoneE164 || "—"}</dd>
              <dt>Joined</dt>
              <dd>{fmtDate(p.createdAt)}</dd>
              <dt>Active sessions</dt>
              <dd>{data.sessionsCount}</dd>
              <dt>Staff role</dt>
              <dd>{data.staffRole || "—"}</dd>
            </dl>
          </div>
          {data.restrictions.length ? (
            <div className="card">
              <div className="ct">Restrictions</div>
              <div className="list sm">
                {data.restrictions.map((r) => (
                  <div className="li" key={r.id}>
                    <div className="t">
                      <b>{r.kind}</b>
                      <small>{r.reason}</small>
                      <small className="dim">{r.expiresAt ? `until ${fmtDate(r.expiresAt)}` : "indefinite"}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {data.memberships.length ? (
            <div className="card">
              <div className="ct">Companies</div>
              <div className="list sm">
                {data.memberships.map((m) => (
                  <div className="li" key={m.id}>
                    <div className="t">
                      <b>{m.organization.displayName}</b>
                      <small>{m.role}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="col">
          <div className="card">
            <div className="ct">Moderation actions</div>
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
                <p className="sm dim">None.</p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="ct">Audit trail</div>
            <div className="list sm">
              {data.audit.map((a) => (
                <div className="li" key={a.id}>
                  <div className="t">
                    <b>{a.action}</b>
                    <small className="dim">{fmtDate(a.createdAt)}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={!!statusOpen}
        onClose={() => setStatusOpen(null)}
        title={`Set status: ${statusOpen ?? ""}`}
        footer={
          <>
            <Button kind="g" onClick={() => setStatusOpen(null)}>
              Cancel
            </Button>
            <Button kind="p" onClick={applyStatus} loading={busy} data-testid="admin-user-status-confirm">
              Confirm
            </Button>
          </>
        }
      >
        <Field label="Note (visible to the person if suspended/banned)" htmlFor="admin-user-status-note">
          <textarea id="admin-user-status-note" className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
