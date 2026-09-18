"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Skeleton, fmtDate, useToast } from "@/components/ui";
import type { OrgCard } from "@/components/company/CompanyCard";
import { EMPLOYMENT_TYPE_LABEL, salaryLabel, type JobData } from "@/components/jobs/JobCard";
import "@/components/jobs/jobs.css";

type ApplicationRow = {
  id: string;
  job: JobData;
  organization: OrgCard | null;
  stage: string;
  coverNote: string | null;
  viewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const STAGE_KIND: Record<string, "" | "ok" | "warn" | "bad" | "ac"> = {
  APPLIED: "",
  REVIEWED: "ac",
  INTERVIEW: "warn",
  OFFER: "ok",
  HIRED: "ok",
  CLOSED: "bad",
};

const STAGE_ORDER = ["APPLIED", "REVIEWED", "INTERVIEW", "OFFER", "HIRED"];

function ApplicationsInner() {
  const toast = useToast();
  const [items, setItems] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [withdrawTarget, setWithdrawTarget] = useState<ApplicationRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: ApplicationRow[] }>("/me/applications");
      setItems(r.items);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't load your applications.", { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw() {
    if (!withdrawTarget) return;
    setBusy(true);
    try {
      await api(`/jobs/${withdrawTarget.job.id}/apply`, { method: "DELETE" });
      toast("Application withdrawn.");
      setWithdrawTarget(null);
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't withdraw that application.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <div className="card">
        <h2 style={{ fontSize: 18 }}>My applications</h2>
      </div>

      {loading ? (
        <div className="list" style={{ marginTop: 12 }}>
          <Skeleton h={90} />
          <Skeleton h={90} />
        </div>
      ) : items.length ? (
        <div className="list" style={{ marginTop: 12 }} data-testid="applications-list">
          {items.map((a) => {
            const canWithdraw = a.stage !== "HIRED" && a.stage !== "CLOSED";
            return (
              <div className="card tight" key={a.id} data-testid={`applications-row-${a.id}`}>
                <div className="li">
                  <Avatar name={a.organization?.displayName ?? a.job.title} assetId={a.organization?.logoAssetId} size={44} square />
                  <div className="t">
                    <b style={{ fontSize: 14.5 }}>{a.job.title}</b>
                    <small>
                      {a.organization?.displayName} · {EMPLOYMENT_TYPE_LABEL[a.job.employmentType]}
                      {salaryLabel(a.job) ? ` · ${salaryLabel(a.job)}` : ""} · applied {fmtDate(a.createdAt)}
                    </small>
                  </div>
                  <Chip kind={STAGE_KIND[a.stage] ?? ""}>{a.stage[0] + a.stage.slice(1).toLowerCase()}</Chip>
                </div>
                <div className="row sm dim" style={{ marginTop: 8, flexWrap: "wrap", gap: 4 }}>
                  {STAGE_ORDER.map((s, i) => (
                    <span key={s} style={{ opacity: STAGE_ORDER.indexOf(a.stage) >= i ? 1 : 0.35 }}>
                      {s !== "APPLIED" ? " → " : ""}
                      {s[0] + s.slice(1).toLowerCase()}
                    </span>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <Button small href={`/jobs/${a.job.id}`} data-testid={`applications-view-${a.id}`}>
                    View job
                  </Button>
                  {canWithdraw ? (
                    <Button small kind="g d" onClick={() => setWithdrawTarget(a)} data-testid={`applications-withdraw-${a.id}`}>
                      Withdraw
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <Empty title="No applications yet" text="Jobs you apply to show up here with their status." action={<Button kind="p" href="/jobs">Browse jobs</Button>} />
        </div>
      )}

      <Dialog
        open={!!withdrawTarget}
        onClose={() => setWithdrawTarget(null)}
        title="Withdraw this application?"
        footer={
          <>
            <Button kind="g" onClick={() => setWithdrawTarget(null)}>
              Cancel
            </Button>
            <Button kind="d" loading={busy} onClick={() => void withdraw()} data-testid="applications-withdraw-confirm">
              Withdraw
            </Button>
          </>
        }
      >
        <p className="sm">This removes your application to "{withdrawTarget?.job.title}". You can apply again later if the job is still open.</p>
      </Dialog>
    </div>
  );
}

export default function MyApplicationsPage() {
  return (
    <RequireAuth>
      <AppShell title="My applications">
        <ApplicationsInner />
      </AppShell>
    </RequireAuth>
  );
}
