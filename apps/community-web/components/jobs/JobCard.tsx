"use client";

import Link from "next/link";
import { Avatar, Chip, Icon, VChip, fmtMoney, timeAgo } from "@/components/ui";
import type { OrgCard } from "@/components/company/CompanyCard";

export type JobData = {
  id: string;
  title: string;
  description: string;
  location: string | null;
  employmentType: string;
  workMode: string;
  salaryMin: string | null;
  salaryMax: string | null;
  salaryPeriod: string;
  requirements: string[];
  languages: string[];
  status: string;
  promoted: boolean;
  applicantCount: number;
  viewCount: number;
  earlyApplicant: boolean;
  createdAt: string;
};

export type JobListItem = {
  job: JobData;
  organization: OrgCard | null;
  applicantCount: number;
  viewCount: number;
  saved: boolean;
  applied: boolean;
  peopleYouKnowHere: { count: number; people: Array<{ id: string; name: string }> };
  earlyApplicant: boolean;
};

export const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: "Full time",
  PART_TIME: "Part time",
  CONTRACT: "Contract",
  TEMP: "Temporary",
  INTERNSHIP: "Internship",
};

export const WORK_MODE_LABEL: Record<string, string> = { ONSITE: "On-site", HYBRID: "Hybrid", REMOTE: "Remote" };

export function salaryLabel(job: Pick<JobData, "salaryMin" | "salaryMax" | "salaryPeriod">): string | null {
  const unit = job.salaryPeriod === "HOUR" ? "/hr" : "/yr";
  if (job.salaryMin && job.salaryMax) return `${fmtMoney(job.salaryMin)}–${fmtMoney(job.salaryMax)}${unit}`;
  if (job.salaryMax) return `Up to ${fmtMoney(job.salaryMax)}${unit}`;
  if (job.salaryMin) return `From ${fmtMoney(job.salaryMin)}${unit}`;
  return null;
}

/** The one card every job list (search results, saved jobs, employer pipeline list) renders. */
export function JobCard({
  item,
  selected,
  onClick,
  onToggleSave,
  testId,
}: {
  item: JobListItem;
  selected?: boolean;
  onClick?: () => void;
  onToggleSave?: () => void;
  testId?: string;
}) {
  const { job, organization } = item;
  const salary = salaryLabel(job);
  const content = (
    <>
      <Avatar name={organization?.displayName ?? job.title} assetId={organization?.logoAssetId} size={44} square />
      <div className="t">
        <b style={{ fontSize: 14.5 }}>{job.title}</b>
        <small>
          {organization?.displayName ?? "Company"} · {job.location ?? WORK_MODE_LABEL[job.workMode]} · {EMPLOYMENT_TYPE_LABEL[job.employmentType]}
          {salary ? ` · ${salary}` : ""} · {timeAgo(job.createdAt)}
        </small>
        <div className="pill-row" style={{ marginTop: 4 }}>
          {organization?.verified?.length ? <VChip>Verified employer</VChip> : null}
          {job.promoted ? <Chip kind="ac">Promoted</Chip> : null}
          {item.earlyApplicant ? <Chip kind="ok">Early applicant</Chip> : null}
        </div>
        {item.peopleYouKnowHere.count > 0 ? (
          <small className="xs" style={{ color: "var(--accent)" }}>
            {item.peopleYouKnowHere.count} you know work here
          </small>
        ) : null}
      </div>
    </>
  );
  const saveButton = onToggleSave ? (
    <button
      type="button"
      className="ib"
      aria-label={item.saved ? "Unsave" : "Save"}
      style={item.saved ? { color: "var(--accent)" } : undefined}
      onClick={() => onToggleSave()}
      data-testid={`${testId}-save`}
    >
      <Icon name="save" />
    </button>
  ) : null;
  return (
    <div className={`card tight ${selected ? "hair" : ""}`} style={selected ? { borderColor: "var(--accent)" } : undefined} data-testid={testId}>
      {onClick ? (
        // The "Save" button is a SIBLING of the clickable area, not nested
        // inside it — a <button> (or role="button") containing another
        // focusable element is invalid (axe: no-focusable-content) regardless
        // of whether the outer element is a real <button> or an ARIA one.
        <div className="li">
          <button
            type="button"
            onClick={onClick}
            style={{ all: "unset", display: "flex", alignItems: "center", gap: "inherit", flex: 1, minWidth: 0, cursor: "pointer" }}
            data-testid={`${testId}-open`}
          >
            {content}
          </button>
          {saveButton}
        </div>
      ) : (
        <div className="li">
          <Link href={`/jobs/${job.id}`} style={{ color: "inherit", display: "flex", alignItems: "center", gap: "inherit", flex: 1, minWidth: 0 }}>
            {content}
          </Link>
          {saveButton}
        </div>
      )}
    </div>
  );
}
