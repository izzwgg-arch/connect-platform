"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Field, useToast } from "@/components/ui";
import { EMPLOYMENT_TYPE_LABEL, WORK_MODE_LABEL } from "@/components/jobs/JobCard";
import "@/components/jobs/jobs.css";

/** Roles whose preset grants org.manage_jobs (mirrors ROLE_PRESETS in apps/community-api/src/organizations/permissions.ts). */
const MANAGE_JOBS_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "RECRUITER"]);

function canManageJobs(m: { role: string; permissions: string[] }): boolean {
  return MANAGE_JOBS_ROLES.has(m.role) || m.permissions.includes("org.manage_jobs");
}

function NewJobForm() {
  const router = useRouter();
  const toast = useToast();
  const { me } = useAuth();
  const eligibleOrgs = useMemo(() => (me?.memberships ?? []).filter(canManageJobs), [me]);

  const [organizationId, setOrganizationId] = useState(eligibleOrgs[0]?.organization.id ?? "");
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
  const [langInput, setLangInput] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [status, setStatus] = useState<"DRAFT" | "OPEN">("OPEN");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addRequirement() {
    const v = reqInput.trim();
    if (!v || requirements.includes(v)) return;
    setRequirements((r) => [...r, v]);
    setReqInput("");
  }
  function addLanguage() {
    const v = langInput.trim();
    if (!v || languages.includes(v)) return;
    setLanguages((l) => [...l, v]);
    setLangInput("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!organizationId) {
      setError("Choose which company this job is for.");
      return;
    }
    if (title.trim().length < 2) {
      setError("Give the job a title.");
      return;
    }
    if (!description.trim()) {
      setError("Describe the role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ job: { id: string } }>("/jobs", {
        method: "POST",
        body: {
          organizationId,
          title: title.trim(),
          description: description.trim(),
          location: location.trim() || undefined,
          employmentType,
          workMode,
          salaryMin: salaryMin ? Number(salaryMin) : undefined,
          salaryMax: salaryMax ? Number(salaryMax) : undefined,
          salaryPeriod,
          requirements,
          languages,
          status,
        },
      });
      toast(status === "OPEN" ? "Job posted." : "Draft saved.");
      router.push(`/company/hiring?job=${created.job.id}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't post that job.");
    } finally {
      setBusy(false);
    }
  }

  if (!eligibleOrgs.length) {
    return (
      <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
        <div className="card">
          <p className="sm dim">You need to manage jobs for a company before you can post one. Ask an owner or admin to grant you the Recruiter role or the "Manage job listings" permission.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">Post a job</div>

        <Field label="Company" htmlFor="job-org">
          <select id="job-org" className="in" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="jobs-new-org">
            {eligibleOrgs.map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.displayName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Title" htmlFor="job-title">
          <input id="job-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="jobs-new-title" />
        </Field>
        <Field label="Description" htmlFor="job-desc">
          <textarea id="job-desc" className="in" style={{ minHeight: 120 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} data-testid="jobs-new-description" />
        </Field>
        <Field label="Location" htmlFor="job-loc" help="Leave blank for a fully remote role">
          <input id="job-loc" className="in" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} data-testid="jobs-new-location" />
        </Field>

        <div className="grid2">
          <Field label="Employment type" htmlFor="job-emptype">
            <select id="job-emptype" className="in" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} data-testid="jobs-new-employmenttype">
              {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Work mode" htmlFor="job-workmode">
            <select id="job-workmode" className="in" value={workMode} onChange={(e) => setWorkMode(e.target.value)} data-testid="jobs-new-workmode">
              {Object.entries(WORK_MODE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid2">
          <Field label="Salary min" htmlFor="job-salmin">
            <input id="job-salmin" className="in" type="number" min={0} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} data-testid="jobs-new-salarymin" />
          </Field>
          <Field label="Salary max" htmlFor="job-salmax">
            <input id="job-salmax" className="in" type="number" min={0} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} data-testid="jobs-new-salarymax" />
          </Field>
        </div>
        <Field label="Salary period" htmlFor="job-salperiod">
          <select id="job-salperiod" className="in" value={salaryPeriod} onChange={(e) => setSalaryPeriod(e.target.value)} data-testid="jobs-new-salaryperiod">
            <option value="YEAR">Per year</option>
            <option value="HOUR">Per hour</option>
          </select>
        </Field>

        <Field label="Requirements" htmlFor="job-req">
          <div className="row">
            <input
              id="job-req"
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
              data-testid="jobs-new-requirement-input"
            />
            <Button type="button" small onClick={addRequirement} data-testid="jobs-new-requirement-add">
              Add
            </Button>
          </div>
          <div className="pill-row" style={{ marginTop: 6 }}>
            {requirements.map((r) => (
              <Chip key={r} onClick={() => setRequirements((cur) => cur.filter((x) => x !== r))} testId={`jobs-new-requirement-${r}`}>
                {r} ×
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Languages" htmlFor="job-lang">
          <div className="row">
            <input
              id="job-lang"
              className="in"
              style={{ flex: 1 }}
              value={langInput}
              onChange={(e) => setLangInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLanguage();
                }
              }}
              data-testid="jobs-new-language-input"
            />
            <Button type="button" small onClick={addLanguage} data-testid="jobs-new-language-add">
              Add
            </Button>
          </div>
          <div className="pill-row" style={{ marginTop: 6 }}>
            {languages.map((l) => (
              <Chip key={l} onClick={() => setLanguages((cur) => cur.filter((x) => x !== l))} testId={`jobs-new-language-${l}`}>
                {l} ×
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Status" htmlFor="job-status">
          <select id="job-status" className="in" value={status} onChange={(e) => setStatus(e.target.value as "DRAFT" | "OPEN")} data-testid="jobs-new-status">
            <option value="OPEN">Open — visible to candidates now</option>
            <option value="DRAFT">Draft — save without publishing</option>
          </select>
        </Field>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="jobs-new-submit">
            {status === "OPEN" ? "Post job" : "Save draft"}
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewJobPage() {
  return (
    <RequireAuth>
      <AppShell title="Post a job">
        <NewJobForm />
      </AppShell>
    </RequireAuth>
  );
}
