"use client";

import { Avatar, Button, Chip, Icon, VChip, fmtDate } from "@/components/ui";
import type { PersonCardData } from "@/components/profile/ProfileCard";
import { EMPLOYMENT_TYPE_LABEL, WORK_MODE_LABEL, salaryLabel, type JobData } from "./JobCard";

export type JobDetail = {
  job: JobData;
  organization: { id: string; slug: string; displayName: string; logoAssetId: string | null; verified: string[]; loopcomLinked: boolean } | null;
  peopleYouKnowHere: { count: number; people: PersonCardData[] };
  viewer: { signedIn: boolean; saved: boolean; applied: boolean; applicationStage: string | null };
};

/** The one job detail panel both /jobs (split view) and /jobs/[id] (public page) render. */
export function JobDetailPanel({
  detail,
  onApply,
  onToggleSave,
  onShare,
  onReport,
  onAskReferral,
  signInHref,
}: {
  detail: JobDetail;
  onApply: () => void;
  onToggleSave: () => void;
  onShare: () => void;
  onReport: () => void;
  onAskReferral: () => void;
  signInHref: string;
}) {
  return (
    <div className="card" data-testid="jobs-detail">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Avatar name={detail.organization?.displayName ?? detail.job.title} assetId={detail.organization?.logoAssetId} size={52} square />
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 18 }}>{detail.job.title}</h2>
          <p className="dim sm">
            {detail.organization?.displayName} · {detail.job.location ?? WORK_MODE_LABEL[detail.job.workMode]} · {EMPLOYMENT_TYPE_LABEL[detail.job.employmentType]}
            {salaryLabel(detail.job) ? ` · ${salaryLabel(detail.job)}` : ""}
          </p>
          <div className="pill-row" style={{ marginTop: 6 }}>
            {detail.organization?.verified?.length ? <VChip>Verified employer</VChip> : null}
            {detail.organization?.loopcomLinked ? (
              <Chip kind="ac" icon="link">
                Loopcom customer
              </Chip>
            ) : null}
            {detail.job.status === "CLOSED" ? <Chip kind="warn">Closed</Chip> : null}
          </div>
        </div>
      </div>

      <div className="row" style={{ margin: "12px 0", flexWrap: "wrap" }}>
        {!detail.viewer.signedIn ? (
          <Button kind="p" href={signInHref} data-testid="jobs-signin-to-apply">
            Sign in to apply
          </Button>
        ) : detail.viewer.applied ? (
          <Chip kind="ok" icon="check">
            Applied
          </Chip>
        ) : detail.job.status === "OPEN" ? (
          <Button kind="p" icon="arrow" onClick={onApply} data-testid="jobs-apply">
            Apply with profile
          </Button>
        ) : (
          <Chip kind="warn">No longer accepting applications</Chip>
        )}
        {detail.viewer.signedIn ? (
          <Button icon="save" onClick={onToggleSave} data-testid="jobs-save">
            {detail.viewer.saved ? "Saved" : "Save"}
          </Button>
        ) : null}
        <Button kind="g" icon="share" onClick={onShare} data-testid="jobs-share">
          Share
        </Button>
        {detail.viewer.signedIn ? (
          <Button kind="g d" icon="flag" onClick={onReport} data-testid="jobs-report">
            Report
          </Button>
        ) : null}
      </div>

      {detail.peopleYouKnowHere.count > 0 ? (
        <div className="why" style={{ marginBottom: 12 }}>
          <Icon name="people" />
          <span>
            {detail.peopleYouKnowHere.people.map((p, i) => (
              <b key={p.id}>
                {i > 0 ? ", " : ""}
                {p.name}
              </b>
            ))}
            {detail.peopleYouKnowHere.count > detail.peopleYouKnowHere.people.length ? ` and ${detail.peopleYouKnowHere.count - detail.peopleYouKnowHere.people.length} other connection(s)` : ""} work here —{" "}
            {detail.viewer.signedIn ? (
              <button type="button" className="linklike" onClick={onAskReferral} data-testid="jobs-ask-referral">
                ask for a referral
              </button>
            ) : (
              "sign in to ask for a referral"
            )}
          </span>
        </div>
      ) : null}

      <h3 className="jobs-section-title">About the role</h3>
      <p className="sm" style={{ whiteSpace: "pre-wrap" }}>
        {detail.job.description}
      </p>

      {detail.job.requirements.length ? (
        <>
          <h3 className="jobs-section-title">Requirements</h3>
          <ul className="jobs-requirements">
            {detail.job.requirements.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      ) : null}

      {detail.viewer.signedIn ? (
        <div className="embed" style={{ marginTop: 12 }}>
          <span className="k">Your application</span>
          <div className="row sm">
            <span>{detail.viewer.applicationStage ? `Stage: ${detail.viewer.applicationStage}` : "Not applied yet"}</span>
            <span className="dim">· posted {fmtDate(detail.job.createdAt)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
