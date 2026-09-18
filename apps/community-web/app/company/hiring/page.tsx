"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Field, Skeleton, fmtDate, useToast } from "@/components/ui";
import { EMPLOYMENT_TYPE_LABEL, salaryLabel, type JobData } from "@/components/jobs/JobCard";
import type { PersonCardData } from "@/components/profile/ProfileCard";
import "@/components/jobs/jobs.css";

const HIRE_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "RECRUITER"]);
function canHire(m: { role: string; permissions: string[] }): boolean {
  return HIRE_ROLES.has(m.role) || m.permissions.includes("org.hire");
}
function canManageJobs(m: { role: string; permissions: string[] }): boolean {
  return HIRE_ROLES.has(m.role) || m.permissions.includes("org.manage_jobs");
}

const STAGES = ["APPLIED", "REVIEWED", "INTERVIEW", "OFFER", "HIRED", "CLOSED"] as const;
const STAGE_LABEL: Record<string, string> = { APPLIED: "Applied", REVIEWED: "Reviewed", INTERVIEW: "Interview", OFFER: "Offer", HIRED: "Hired", CLOSED: "Closed" };

type ApplicationRow = {
  id: string;
  applicant: PersonCardData;
  profileSnapshot: Record<string, unknown>;
  resumeUrl: string | null;
  coverNote: string | null;
  stage: string;
  employerNotes: string | null;
  threadId: string | null;
  viewedAt: string | null;
  createdAt: string;
};

type Analytics = { views: number; applications: number; byStage: Record<string, number>; conversion: number };

function Inner() {
  const toast = useToast();
  const { me } = useAuth();
  const searchParams = useSearchParams();

  const hireOrgs = useMemo(() => (me?.memberships ?? []).filter(canHire), [me]);
  const [orgId, setOrgId] = useState(hireOrgs[0]?.organization.id ?? "");
  const canManageForOrg = useMemo(() => (me?.memberships ?? []).some((m) => m.organization.id === orgId && canManageJobs(m)), [me, orgId]);

  const [jobs, setJobs] = useState<JobData[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(searchParams.get("job"));

  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [stageFilter, setStageFilter] = useState<string>("");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [drawerApp, setDrawerApp] = useState<ApplicationRow | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messageBusy, setMessageBusy] = useState(false);

  const loadJobs = useCallback(async () => {
    if (!orgId) return;
    setJobsLoading(true);
    try {
      const r = await api<{ items: JobData[] }>(`/organizations/${orgId}/jobs`);
      setJobs(r.items);
      if (!selectedJobId && r.items.length) setSelectedJobId(r.items[0].id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't load jobs.", { kind: "err" });
    } finally {
      setJobsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, toast]);

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const loadPipeline = useCallback(
    async (jobId: string, stage: string) => {
      setAppsLoading(true);
      try {
        const [appsRes, analyticsRes] = await Promise.all([
          api<{ items: ApplicationRow[] }>(`/jobs/${jobId}/applications${stage ? `?stage=${stage}` : ""}`),
          api<Analytics>(`/jobs/${jobId}/analytics`),
        ]);
        setApplications(appsRes.items);
        setAnalytics(analyticsRes);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Couldn't load the pipeline.", { kind: "err" });
      } finally {
        setAppsLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (selectedJobId) void loadPipeline(selectedJobId, stageFilter);
  }, [selectedJobId, stageFilter, loadPipeline]);

  async function moveStage(app: ApplicationRow, stage: string) {
    if (!selectedJobId) return;
    setApplications((cur) => cur.map((a) => (a.id === app.id ? { ...a, stage } : a)));
    try {
      await api(`/jobs/${selectedJobId}/applications/${app.id}`, { method: "PATCH", body: { stage } });
      toast(`Moved to ${STAGE_LABEL[stage]}.`);
      void loadPipeline(selectedJobId, stageFilter);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't move that applicant.", { kind: "err" });
      void loadPipeline(selectedJobId, stageFilter);
    }
  }

  async function saveNotes() {
    if (!selectedJobId || !drawerApp) return;
    try {
      await api(`/jobs/${selectedJobId}/applications/${drawerApp.id}`, { method: "PATCH", body: { employerNotes: notesDraft.trim() || null } });
      toast("Notes saved.");
      setApplications((cur) => cur.map((a) => (a.id === drawerApp.id ? { ...a, employerNotes: notesDraft.trim() || null } : a)));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save that note.", { kind: "err" });
    }
  }

  async function sendMessage() {
    if (!selectedJobId || !drawerApp || !messageDraft.trim()) return;
    setMessageBusy(true);
    try {
      await api(`/jobs/${selectedJobId}/applications/${drawerApp.id}/message`, { method: "POST", body: { body: messageDraft.trim() } });
      toast("Message sent.");
      setMessageDraft("");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't send that message.", { kind: "err" });
    } finally {
      setMessageBusy(false);
    }
  }

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;

  if (!hireOrgs.length) {
    return (
      <div className="col" style={{ gridColumn: "1/-1" }}>
        <div className="card">
          <Empty title="No hiring access" text="Ask an owner or admin to grant you the Recruiter role or the 'Hire' permission for a company." />
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <Field label="Company" htmlFor="hiring-org">
            <select
              id="hiring-org"
              className="in"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setSelectedJobId(null);
                setJobs([]);
              }}
              data-testid="hiring-org-select"
            >
              {hireOrgs.map((m) => (
                <option key={m.organization.id} value={m.organization.id}>
                  {m.organization.displayName}
                </option>
              ))}
            </select>
          </Field>
          {canManageForOrg ? (
            <Button kind="p" icon="plus" href="/jobs/new" data-testid="hiring-new-job">
              Post a job
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12, alignItems: "flex-start" }}>
        <div className="card" data-testid="hiring-jobs-list">
          <div className="ct">Jobs</div>
          {jobsLoading ? (
            <Skeleton h={140} />
          ) : jobs.length ? (
            <div className="list">
              {jobs.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className="li"
                  style={{ all: "unset", display: "flex", cursor: "pointer", width: "100%", padding: "8px 0" }}
                  onClick={() => setSelectedJobId(j.id)}
                  data-testid={`hiring-job-${j.id}`}
                >
                  <div className="t" style={{ borderLeft: j.id === selectedJobId ? "3px solid var(--accent)" : "3px solid transparent", paddingLeft: 8 }}>
                    <b style={{ fontSize: 14 }}>{j.title}</b>
                    <small>
                      {EMPLOYMENT_TYPE_LABEL[j.employmentType]}
                      {salaryLabel(j) ? ` · ${salaryLabel(j)}` : ""} · {j.applicantCount} applicant{j.applicantCount === 1 ? "" : "s"} · {j.viewCount} views
                    </small>
                    <div className="pill-row" style={{ marginTop: 4 }}>
                      <Chip kind={j.status === "OPEN" ? "ok" : j.status === "DRAFT" ? "warn" : ""}>{j.status}</Chip>
                      {j.promoted ? <Chip kind="ac">Promoted</Chip> : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty title="No jobs yet" text="Post your first job to start building a pipeline." action={canManageForOrg ? <Button kind="p" href="/jobs/new">Post a job</Button> : undefined} />
          )}
        </div>

        <div className="card">
          {selectedJob ? (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="ct" style={{ margin: 0 }}>
                  Hiring pipeline · {selectedJob.title}
                </div>
                {canManageForOrg ? (
                  <Button small href={`/jobs/${selectedJob.id}/edit`} data-testid="hiring-edit-job">
                    Edit job
                  </Button>
                ) : null}
              </div>

              {analytics ? (
                <div className="jobs-stage-board" style={{ marginTop: 10 }} data-testid="hiring-stage-board">
                  {STAGES.map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="jobs-stage-tile"
                      style={{ all: "unset", cursor: "pointer", display: "block", background: stageFilter === s ? "var(--accent-10, var(--bg-soft))" : "var(--bg-soft)", borderRadius: 10, padding: 10 }}
                      onClick={() => setStageFilter((cur) => (cur === s ? "" : s))}
                      data-testid={`hiring-stage-${s}`}
                    >
                      <small className="lbl" style={{ margin: 0 }}>
                        {STAGE_LABEL[s]}
                      </small>
                      <b style={{ fontSize: 20 }} className="mono">
                        {analytics.byStage[s] ?? 0}
                      </b>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="row sm dim" style={{ marginTop: 10 }}>
                <span>{analytics?.views ?? 0} views</span>
                <span>· {analytics?.applications ?? 0} applications</span>
                <span>· {analytics ? Math.round(analytics.conversion * 1000) / 10 : 0}% conversion</span>
              </div>

              {appsLoading ? (
                <div className="list" style={{ marginTop: 10 }}>
                  <Skeleton h={60} />
                  <Skeleton h={60} />
                </div>
              ) : applications.length ? (
                <div className="list" style={{ marginTop: 10 }} data-testid="hiring-applicant-list">
                  {applications.map((a) => (
                    <div className="li" key={a.id} data-testid={`hiring-applicant-${a.id}`}>
                      <button type="button" style={{ all: "unset", display: "flex", gap: 10, cursor: "pointer", flex: 1 }} onClick={() => {
                        setDrawerApp(a);
                        setNotesDraft(a.employerNotes ?? "");
                      }} data-testid={`hiring-applicant-open-${a.id}`}>
                        <Avatar name={a.applicant.name} assetId={a.applicant.avatarAssetId} size={34} />
                        <div className="t">
                          <b>{a.applicant.name}</b>
                          <small>
                            {STAGE_LABEL[a.stage]} · applied {fmtDate(a.createdAt)}
                            {a.employerNotes ? ` · note: "${a.employerNotes}"` : ""}
                          </small>
                        </div>
                      </button>
                      <select
                        className="in"
                        style={{ width: 140 }}
                        value={a.stage}
                        onChange={(e) => void moveStage(a, e.target.value)}
                        data-testid={`hiring-applicant-stage-${a.id}`}
                        aria-label={`Move ${a.applicant.name}`}
                      >
                        {STAGES.map((s) => (
                          <option key={s} value={s}>
                            {STAGE_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <Empty title={stageFilter ? `No applicants at ${STAGE_LABEL[stageFilter]}` : "No applicants yet"} />
                </div>
              )}
            </>
          ) : (
            <Empty title="Select a job" text="Pick a job on the left to see its hiring pipeline." />
          )}
        </div>
      </div>

      <Dialog open={!!drawerApp} onClose={() => setDrawerApp(null)} title={drawerApp?.applicant.name ?? "Applicant"} wide>
        {drawerApp ? (
          <div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <Chip kind="" >{STAGE_LABEL[drawerApp.stage]}</Chip>
              {drawerApp.resumeUrl ? (
                <a className="btn s" href={drawerApp.resumeUrl} target="_blank" rel="noreferrer" data-testid="hiring-resume-link">
                  View résumé
                </a>
              ) : null}
            </div>
            {drawerApp.coverNote ? (
              <>
                <h3 className="jobs-section-title">Cover note</h3>
                <p className="sm">{drawerApp.coverNote}</p>
              </>
            ) : null}
            {"headline" in drawerApp.profileSnapshot ? (
              <p className="sm dim" style={{ marginTop: 8 }}>
                {String(drawerApp.profileSnapshot.headline ?? "")}
              </p>
            ) : null}
            {"about" in drawerApp.profileSnapshot ? (
              <>
                <h3 className="jobs-section-title">About</h3>
                <p className="sm">{String(drawerApp.profileSnapshot.about ?? "")}</p>
              </>
            ) : null}
            {Array.isArray((drawerApp.profileSnapshot as any).experience) && (drawerApp.profileSnapshot as any).experience.length ? (
              <>
                <h3 className="jobs-section-title">Experience</h3>
                <ul className="jobs-requirements">
                  {(drawerApp.profileSnapshot as any).experience.map((e: any, i: number) => (
                    <li key={i}>
                      {e.title} — {e.companyName}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {Array.isArray((drawerApp.profileSnapshot as any).skills) && (drawerApp.profileSnapshot as any).skills.length ? (
              <div className="pill-row" style={{ marginTop: 8 }}>
                {(drawerApp.profileSnapshot as any).skills.map((s: string) => (
                  <Chip key={s}>{s}</Chip>
                ))}
              </div>
            ) : null}

            <Field label="Employer notes" htmlFor="hiring-notes">
              <textarea id="hiring-notes" className="in" rows={3} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} data-testid="hiring-notes" />
            </Field>
            <Button small kind="p" onClick={() => void saveNotes()} data-testid="hiring-notes-save">
              Save notes
            </Button>

            <Field label="Message this candidate" htmlFor="hiring-message">
              <textarea id="hiring-message" className="in" rows={2} value={messageDraft} onChange={(e) => setMessageDraft(e.target.value)} data-testid="hiring-message" />
            </Field>
            <Button small kind="p" loading={messageBusy} onClick={() => void sendMessage()} data-testid="hiring-message-send">
              Send message
            </Button>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

export default function HiringPage() {
  return (
    <RequireAuth>
      <AppShell title="Hiring">
        <Inner />
      </AppShell>
    </RequireAuth>
  );
}
