"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Dialog, Field, Skeleton, useToast } from "@/components/ui";
import { EMPLOYMENT_TYPE_LABEL, WORK_MODE_LABEL, type JobData } from "@/components/jobs/JobCard";
import "@/components/jobs/jobs.css";

function EditJobForm({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteDays, setPromoteDays] = useState("7");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [employmentType, setEmploymentType] = useState("FULL_TIME");
  const [workMode, setWorkMode] = useState("ONSITE");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");
  const [salaryPeriod, setSalaryPeriod] = useState("YEAR");
  const [reqInput, setReqInput] = useState("");
  const [requirements, setRequirements] = useState<string[]>([]);

  useEffect(() => {
    api<{ job: JobData; organization: unknown }>(`/public/jobs/${id}`)
      .then((r) => {
        setJob(r.job);
        setTitle(r.job.title);
        setDescription(r.job.description);
        setLocation(r.job.location ?? "");
        setEmploymentType(r.job.employmentType);
        setWorkMode(r.job.workMode);
        setSalaryMin(r.job.salaryMin ?? "");
        setSalaryMax(r.job.salaryMax ?? "");
        setSalaryPeriod(r.job.salaryPeriod);
        setRequirements(r.job.requirements);
      })
      .catch(() => toast("Couldn't load that job.", { kind: "err" }))
      .finally(() => setLoading(false));
  }, [id, toast]);

  function addRequirement() {
    const v = reqInput.trim();
    if (!v || requirements.includes(v)) return;
    setRequirements((r) => [...r, v]);
    setReqInput("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          description: description.trim(),
          location: location.trim() || null,
          employmentType,
          workMode,
          salaryMin: salaryMin ? Number(salaryMin) : null,
          salaryMax: salaryMax ? Number(salaryMax) : null,
          salaryPeriod,
          requirements,
        },
      });
      toast("Job updated.");
      router.push(`/company/hiring?job=${id}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't save those changes.");
    } finally {
      setBusy(false);
    }
  }

  async function closeJob() {
    try {
      await api(`/jobs/${id}/close`, { method: "POST" });
      toast("Job closed.");
      router.push(`/company/hiring?job=${id}`);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't close that job.", { kind: "err" });
    }
  }

  async function promoteJob() {
    try {
      await api(`/jobs/${id}/promote`, { method: "POST", body: { days: Number(promoteDays) } });
      toast("Job promoted.");
      setPromoteOpen(false);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't promote that job.", { kind: "err" });
    }
  }

  if (loading) {
    return (
      <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
        <Skeleton h={300} />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
        <div className="card">
          <p className="sm dim">That job couldn't be loaded, or you don't have permission to edit it.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
      <form className="card" onSubmit={submit}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="ct">Edit job</div>
          <div className="row">
            {job.status === "OPEN" ? (
              <>
                <Button small kind="g" type="button" onClick={() => setPromoteOpen(true)} data-testid="jobs-edit-promote">
                  Promote
                </Button>
                <Button small kind="g d" type="button" onClick={() => void closeJob()} data-testid="jobs-edit-close">
                  Close job
                </Button>
              </>
            ) : (
              <Chip>{job.status}</Chip>
            )}
          </div>
        </div>

        <Field label="Title" htmlFor="jobedit-title">
          <input id="jobedit-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="jobs-edit-title" />
        </Field>
        <Field label="Description" htmlFor="jobedit-desc">
          <textarea id="jobedit-desc" className="in" style={{ minHeight: 120 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} data-testid="jobs-edit-description" />
        </Field>
        <Field label="Location" htmlFor="jobedit-loc">
          <input id="jobedit-loc" className="in" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} data-testid="jobs-edit-location" />
        </Field>

        <div className="grid2">
          <Field label="Employment type" htmlFor="jobedit-emptype">
            <select id="jobedit-emptype" className="in" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} data-testid="jobs-edit-employmenttype">
              {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Work mode" htmlFor="jobedit-workmode">
            <select id="jobedit-workmode" className="in" value={workMode} onChange={(e) => setWorkMode(e.target.value)} data-testid="jobs-edit-workmode">
              {Object.entries(WORK_MODE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid2">
          <Field label="Salary min" htmlFor="jobedit-salmin">
            <input id="jobedit-salmin" className="in" type="number" min={0} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} data-testid="jobs-edit-salarymin" />
          </Field>
          <Field label="Salary max" htmlFor="jobedit-salmax">
            <input id="jobedit-salmax" className="in" type="number" min={0} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} data-testid="jobs-edit-salarymax" />
          </Field>
        </div>
        <Field label="Salary period" htmlFor="jobedit-salperiod">
          <select id="jobedit-salperiod" className="in" value={salaryPeriod} onChange={(e) => setSalaryPeriod(e.target.value)} data-testid="jobs-edit-salaryperiod">
            <option value="YEAR">Per year</option>
            <option value="HOUR">Per hour</option>
          </select>
        </Field>

        <Field label="Requirements" htmlFor="jobedit-req">
          <div className="row">
            <input
              id="jobedit-req"
              className="in"
              style={{ flex: 1 }}
              value={reqInput}
              onChange={(e) => setReqInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRequirement();
                }
              }}
              data-testid="jobs-edit-requirement-input"
            />
            <Button type="button" small onClick={addRequirement} data-testid="jobs-edit-requirement-add">
              Add
            </Button>
          </div>
          <div className="pill-row" style={{ marginTop: 6 }}>
            {requirements.map((r) => (
              <Chip key={r} onClick={() => setRequirements((cur) => cur.filter((x) => x !== r))} testId={`jobs-edit-requirement-${r}`}>
                {r} ×
              </Chip>
            ))}
          </div>
        </Field>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="jobs-edit-submit">
            Save changes
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>

      <Dialog
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        title="Promote this job"
        footer={
          <>
            <Button kind="g" onClick={() => setPromoteOpen(false)}>
              Cancel
            </Button>
            <Button kind="p" onClick={() => void promoteJob()} data-testid="jobs-promote-submit">
              Promote
            </Button>
          </>
        }
      >
        <Field label="Days" htmlFor="jobedit-promotedays">
          <input id="jobedit-promotedays" className="in" type="number" min={1} max={90} value={promoteDays} onChange={(e) => setPromoteDays(e.target.value)} data-testid="jobs-promote-days" />
        </Field>
      </Dialog>
    </div>
  );
}

export default function EditJobPage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireAuth>
      <AppShell title="Edit job">
        <EditJobForm id={params.id} />
      </AppShell>
    </RequireAuth>
  );
}
