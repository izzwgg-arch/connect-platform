"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Button, Chip, Dialog, Empty, Skeleton, useToast } from "@/components/ui";
import { ReportDialog } from "@/components/graph/ReportDialog";
import { JobCard, type JobListItem } from "@/components/jobs/JobCard";
import { JobDetailPanel, type JobDetail } from "@/components/jobs/JobDetailPanel";
import { ApplyDialog } from "@/components/jobs/ApplyDialog";
import { ReferralDialog } from "@/components/jobs/ReferralDialog";
import "@/components/jobs/jobs.css";

export default function JobsPage() {
  return (
    <RequireAuth>
      <AppShell title="Jobs" cols="two">
        <Inner />
      </AppShell>
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [location, setLocation] = useState("");
  const [employmentType, setEmploymentType] = useState<string | null>(null);
  const [workMode, setWorkMode] = useState<string | null>(null);
  const [postedWithin, setPostedWithin] = useState(false);
  const [verifiedEmployer, setVerifiedEmployer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<JobListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const search = useCallback(
    async (opts: { openFirst?: boolean } = {}) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (location.trim()) params.set("location", location.trim());
        if (employmentType) params.set("employmentType", employmentType);
        if (workMode) params.set("workMode", workMode);
        if (postedWithin) params.set("postedWithin", "7");
        if (verifiedEmployer) params.set("verifiedEmployer", "1");
        const r = await api<{ items: JobListItem[] }>(`/jobs?${params.toString()}`);
        setItems(r.items);
        if (opts.openFirst && r.items.length) void selectJob(r.items[0].job.id);
        else if (selectedId && !r.items.some((i) => i.job.id === selectedId)) setSelectedId(null);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Couldn't load jobs.", { kind: "err" });
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, location, employmentType, workMode, postedWithin, verifiedEmployer],
  );

  useEffect(() => {
    void search({ openFirst: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employmentType, workMode, postedWithin, verifiedEmployer]);

  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectJob(id: string) {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const d = await api<JobDetail>(`/public/jobs/${id}`);
      setDetail(d);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't load that job.", { kind: "err" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function toggleSave(item: JobListItem) {
    setItems((cur) => cur.map((i) => (i.job.id === item.job.id ? { ...i, saved: !i.saved } : i)));
    if (detail?.job.id === item.job.id) setDetail((d) => (d ? { ...d, viewer: { ...d.viewer, saved: !d.viewer.saved } } : d));
    try {
      if (item.saved) await api(`/jobs/${item.job.id}/save`, { method: "DELETE" });
      else await api(`/jobs/${item.job.id}/save`, { method: "POST" });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that.", { kind: "err" });
      void search();
    }
  }

  async function shareLink(jobId: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/jobs/${jobId}`);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy the link.", { kind: "err" });
    }
  }

  async function createAlert() {
    try {
      await api("/me/job-alerts", { method: "POST", body: { query: q.trim() || "jobs", location: location.trim() || undefined }, idempotencyKey: newIdempotencyKey() });
      toast("Alert created — we'll notify you about new matches.");
      setAlertOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't create that alert.", { kind: "err" });
    }
  }

  const selectedItem = items.find((i) => i.job.id === selectedId) ?? null;

  return (
    <>
      <div className="col">
        <div className="card">
          <div className="jobs-search-row">
            <input className="in" placeholder="Job title or keyword" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search({ openFirst: true })} data-testid="jobs-search-q" />
            <input className="in" style={{ maxWidth: 200 }} placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search({ openFirst: true })} data-testid="jobs-search-location" />
            <Button kind="p" icon="search" onClick={() => void search({ openFirst: true })} data-testid="jobs-search-submit">
              Search
            </Button>
          </div>
          <div className="pill-row">
            <Chip kind={employmentType === "FULL_TIME" ? "sel" : ""} onClick={() => setEmploymentType((v) => (v === "FULL_TIME" ? null : "FULL_TIME"))} testId="jobs-filter-fulltime">
              Full time
            </Chip>
            <Chip kind={employmentType === "PART_TIME" ? "sel" : ""} onClick={() => setEmploymentType((v) => (v === "PART_TIME" ? null : "PART_TIME"))} testId="jobs-filter-parttime">
              Part time
            </Chip>
            <Chip kind={workMode === "REMOTE" ? "sel" : ""} onClick={() => setWorkMode((v) => (v === "REMOTE" ? null : "REMOTE"))} testId="jobs-filter-remote">
              Remote
            </Chip>
            <Chip kind={postedWithin ? "sel" : ""} onClick={() => setPostedWithin((v) => !v)} testId="jobs-filter-postedweek">
              Posted this week
            </Chip>
            <Chip kind={verifiedEmployer ? "sel" : ""} icon="check" onClick={() => setVerifiedEmployer((v) => !v)} testId="jobs-filter-verified">
              Verified employer
            </Chip>
            <span style={{ flex: 1 }} />
            <Button small icon="bell" onClick={() => setAlertOpen(true)} data-testid="jobs-create-alert">
              Create alert
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="list" style={{ marginTop: 12 }}>
            <Skeleton h={72} />
            <Skeleton h={72} />
            <Skeleton h={72} />
          </div>
        ) : items.length ? (
          <div className="list" style={{ marginTop: 12 }} data-testid="jobs-list">
            {items.map((item) => (
              <JobCard key={item.job.id} item={item} selected={item.job.id === selectedId} onClick={() => void selectJob(item.job.id)} onToggleSave={() => void toggleSave(item)} testId={`jobs-card-${item.job.id}`} />
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <Empty title="No jobs match" text="Try a different keyword or clear a filter." />
          </div>
        )}
      </div>

      <div className="col">
        {detailLoading ? (
          <div className="card">
            <Skeleton h={200} />
          </div>
        ) : detail ? (
          <JobDetailPanel
            detail={detail}
            onApply={() => setApplyOpen(true)}
            onToggleSave={() => selectedItem && void toggleSave(selectedItem)}
            onShare={() => void shareLink(detail.job.id)}
            onReport={() => setReportOpen(true)}
            onAskReferral={() => setReferralOpen(true)}
            signInHref="/login?next=/jobs"
          />
        ) : (
          <div className="card">
            <Empty title="Select a job" text="Pick a job from the list to see the details." />
          </div>
        )}
      </div>

      {detail ? (
        <ApplyDialog
          open={applyOpen}
          onClose={() => setApplyOpen(false)}
          jobId={detail.job.id}
          onApplied={() => {
            setApplyOpen(false);
            setDetail((d) => (d ? { ...d, viewer: { ...d.viewer, applied: true, applicationStage: "APPLIED" } } : d));
            setItems((cur) => cur.map((i) => (i.job.id === detail.job.id ? { ...i, applied: true } : i)));
          }}
        />
      ) : null}

      <Dialog open={alertOpen} onClose={() => setAlertOpen(false)} title="Create a job alert" footer={
        <>
          <Button kind="g" onClick={() => setAlertOpen(false)}>Cancel</Button>
          <Button kind="p" onClick={() => void createAlert()} data-testid="jobs-alert-submit">Create alert</Button>
        </>
      }>
        <p className="sm dim">We'll notify you when a new job matches "{q.trim() || "jobs"}"{location.trim() ? ` in ${location.trim()}` : ""}.</p>
      </Dialog>

      {detail ? <ReferralDialog open={referralOpen} onClose={() => setReferralOpen(false)} jobId={detail.job.id} people={detail.peopleYouKnowHere.people} /> : null}

      {detail ? <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} targetType="job" targetId={detail.job.id} testId="jobs-report" /> : null}
    </>
  );
}
