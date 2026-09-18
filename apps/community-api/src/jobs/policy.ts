/**
 * Pure jobs policy — no db access here (CONVENTIONS §3). Routes fetch rows
 * and call these; nothing here talks to the database.
 */

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "TEMP", "INTERNSHIP"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODES = ["ONSITE", "HYBRID", "REMOTE"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const SALARY_PERIODS = ["YEAR", "HOUR"] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

/** The sections a candidate can choose to share when applying — never the live profile. */
export const PROFILE_SECTIONS = ["headline", "about", "experience", "education", "skills", "certifications", "services"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Fewer than this many applicants and the candidate is shown "Early applicant". */
export const EARLY_APPLICANT_THRESHOLD = 10;
export function isEarlyApplicant(applicantCount: number): boolean {
  return applicantCount < EARLY_APPLICANT_THRESHOLD;
}

/** A "verified member" for referral / people-you-know purposes: an admin- or domain-verified affiliation. */
export const VERIFIED_AFFILIATIONS = ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] as const;

export const PROMOTE_MIN_DAYS = 1;
export const PROMOTE_MAX_DAYS = 90;

export function promotedUntilFrom(days: number, now = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function isPromoted(promotedUntil: Date | null | undefined, now = new Date()): boolean {
  return !!promotedUntil && promotedUntil.getTime() > now.getTime();
}

/** Raw material for `buildProfileSnapshot` — the live profile + its child rows. */
export type LiveProfileForSnapshot = {
  headline: string | null;
  about: string | null;
  skills: string[];
  experiences: Array<{ companyName: string; title: string; startDate: Date; endDate: Date | null; isCurrent: boolean; location: string | null; description: string | null }>;
  educations: Array<{ school: string; degree: string | null; field: string | null; startYear: number | null; endYear: number | null }>;
  services: Array<{ name: string; description: string | null; priceFrom: string | null; priceNote: string | null }>;
  certifications: Array<{ name: string; issuer: string | null; issuedAt: Date | null; expiresAt: Date | null }>;
};

/**
 * Builds the JobApplication.profileSnapshot — only the sections the candidate
 * chose land in the stored object; anything unchosen is simply absent, never
 * stored and later hidden.
 */
export function buildProfileSnapshot(profile: LiveProfileForSnapshot, sections: ProfileSection[]): Record<string, unknown> {
  const chosen = new Set(sections);
  const out: Record<string, unknown> = {};
  if (chosen.has("headline")) out.headline = profile.headline;
  if (chosen.has("about")) out.about = profile.about;
  if (chosen.has("skills")) out.skills = profile.skills;
  if (chosen.has("experience")) out.experience = profile.experiences;
  if (chosen.has("education")) out.education = profile.educations;
  if (chosen.has("services")) out.services = profile.services;
  if (chosen.has("certifications")) out.certifications = profile.certifications;
  out.sections = sections;
  return out;
}

/** Human sentence + notification title/body per application stage (brief: job.stage class). */
export function stageNotification(stage: "REVIEWED" | "INTERVIEW" | "OFFER" | "HIRED" | "CLOSED", jobTitle: string): { title: string; body: string } {
  const sentences: Record<string, string> = {
    REVIEWED: "Your application was reviewed",
    INTERVIEW: "You've been moved to interview",
    OFFER: "You've received an offer",
    HIRED: "You were hired",
    CLOSED: "This position was filled",
  };
  const body = sentences[stage] ?? "Your application was updated";
  return { title: body, body: `${body} — ${jobTitle}` };
}

/** The message body sent to a recruiter's candidate — never exposed as a template the caller edits server-side. */
export function referralAskMessage(jobTitle: string, jobUrl: string): string {
  return `Could you refer me for ${jobTitle}? ${jobUrl}`;
}
