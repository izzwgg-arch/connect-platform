"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Empty, Skeleton, useToast } from "@/components/ui";
import { ReportDialog } from "@/components/graph/ReportDialog";
import { JobDetailPanel, type JobDetail } from "@/components/jobs/JobDetailPanel";
import { ApplyDialog } from "@/components/jobs/ApplyDialog";
import { ReferralDialog } from "@/components/jobs/ReferralDialog";
import "@/components/jobs/jobs.css";

export default function PublicJobPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { me } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<JobDetail>(`/public/jobs/${id}`, { auth: !!me });
      setDetail(d);
      setMissing(false);
    } catch {
      setMissing(true);
    } finally {
      setLoading(false);
    }
  }, [id, me]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleSave() {
    if (!detail) return;
    setDetail((d) => (d ? { ...d, viewer: { ...d.viewer, saved: !d.viewer.saved } } : d));
    try {
      if (detail.viewer.saved) await api(`/jobs/${id}/save`, { method: "DELETE" });
      else await api(`/jobs/${id}/save`, { method: "POST" });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that.", { kind: "err" });
      void load();
    }
  }

  async function shareLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy the link.", { kind: "err" });
    }
  }

  if (loading) {
    return (
      <div className="content narrow">
        <Skeleton h={220} />
      </div>
    );
  }
  if (missing || !detail) {
    return (
      <div className="content narrow">
        <Empty title="Job not found" text="That job doesn't exist, or isn't open any more." />
      </div>
    );
  }

  const body = (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 720 }}>
      <JobDetailPanel
        detail={detail}
        onApply={() => setApplyOpen(true)}
        onToggleSave={() => void toggleSave()}
        onShare={() => void shareLink()}
        onReport={() => setReportOpen(true)}
        onAskReferral={() => setReferralOpen(true)}
        signInHref={`/login?next=${encodeURIComponent(`/jobs/${id}`)}`}
      />
      <ApplyDialog
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        jobId={id}
        onApplied={() => {
          setApplyOpen(false);
          setDetail((d) => (d ? { ...d, viewer: { ...d.viewer, applied: true, applicationStage: "APPLIED" } } : d));
        }}
      />
      <ReferralDialog open={referralOpen} onClose={() => setReferralOpen(false)} jobId={id} people={detail.peopleYouKnowHere.people} />
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} targetType="job" targetId={id} testId="jobs-report" />
    </div>
  );

  if (me) {
    return (
      <AppShell title={detail.job.title}>
        {body}
      </AppShell>
    );
  }

  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span style={{ flex: 1 }} />
        <Link className="btn" href="/login" data-testid="jobs-anon-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="jobs-anon-join">
          Join free
        </Link>
      </nav>
      <div className="content">{body}</div>
    </div>
  );
}
