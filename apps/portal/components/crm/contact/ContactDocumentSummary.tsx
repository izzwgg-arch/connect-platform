"use client";

import { useCallback, useEffect, useState } from "react";
import { FileSearch, Phone, Shield } from "lucide-react";
import { apiGet } from "../../../services/apiClient";
import { cn } from "../cn";
import { ContactCollapsibleSection } from "./ContactCollapsibleSection";

export type SummaryField = {
  displayValue: string | null;
  source: "contact" | "document" | "ai" | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  documentName: string | null;
};

export type SummaryPhone = {
  number: string;
  normalized: string | null;
  source: "contact" | "discovered" | "document";
  label: string | null;
  isPrimary: boolean;
};

export type LeadDocumentSummary = {
  verified: Record<string, SummaryField | null>;
  extracted: Record<string, SummaryField | null>;
  phones: SummaryPhone[];
  meta: {
    documentCount: number;
    documentsWithText: number;
    intelligenceStatus: string | null;
    intelligenceGeneratedAt: string | null;
    hasConflicts: boolean;
  };
};

const VERIFIED_LABELS: Record<string, string> = {
  industry: "Industry (company)",
  timezone: "Time zone",
  businessAddress: "Business address",
  homeAddress: "Home address",
};

const EXTRACTED_LABELS: Record<string, string> = {
  ein: "EIN",
  ssn: "SSN",
  revenue: "Revenue",
  industry: "Industry",
  creditScore: "Credit score",
  businessStartDate: "Business start date",
  businessAddress: "Business address",
  homeAddress: "Home address",
};

function SourceBadge({ field }: { field: SummaryField }) {
  if (!field.source) return null;
  const label =
    field.source === "contact"
      ? "CRM record"
      : field.source === "document"
        ? "Document"
        : "AI advisory";
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        field.source === "contact" && "bg-emerald-500/15 text-emerald-400",
        field.source === "document" && "bg-violet-500/15 text-violet-300",
        field.source === "ai" && "bg-crm-accent/15 text-crm-accent",
      )}
    >
      {label}
      {field.confidence ? ` · ${field.confidence.toLowerCase()}` : ""}
    </span>
  );
}

function SummaryFieldRow({ label, field }: { label: string; field: SummaryField | null | undefined }) {
  return (
    <div className="grid grid-cols-[minmax(0,38%)_1fr] gap-x-3 gap-y-0.5 border-b border-crm-border/40 py-2 last:border-b-0">
      <dt className="text-xs font-semibold text-crm-muted">{label}</dt>
      <dd className="text-sm text-crm-text">
        {field?.displayValue ? (
          <span>
            {field.displayValue}
            <SourceBadge field={field} />
            {field.documentName ? (
              <span className="mt-0.5 block text-[10px] text-crm-muted">From: {field.documentName}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-crm-muted">Not found</span>
        )}
      </dd>
    </div>
  );
}

type Props = {
  contactId: string;
  refreshToken?: number;
};

export function ContactDocumentSummary({ contactId, refreshToken = 0 }: Props) {
  const [summary, setSummary] = useState<LeadDocumentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ summary: LeadDocumentSummary }>(
        `/crm/contacts/${contactId}/document-summary`,
      );
      setSummary(res.summary);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Failed to load document summary.");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  if (loading) {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4 text-sm text-crm-muted">
        Loading document summary…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[1.35rem] border border-red-500/25 bg-red-500/5 p-4 text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (!summary) return null;

  const verifiedKeys = Object.keys(VERIFIED_LABELS);
  const extractedKeys = Object.keys(EXTRACTED_LABELS);
  const hasVerified = verifiedKeys.some((k) => summary.verified[k]?.displayValue);
  const hasExtracted = extractedKeys.some((k) => summary.extracted[k]?.displayValue);
  const verifiedCount = verifiedKeys.filter((k) => summary.verified[k]?.displayValue).length;
  const extractedCount = extractedKeys.filter((k) => summary.extracted[k]?.displayValue).length;
  const primaryPhoneSummary =
    summary.phones.find((p) => p.isPrimary)?.number ?? summary.phones[0]?.number ?? null;

  return (
    <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FileSearch className="h-4 w-4 text-crm-accent" />
            <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">
              Business profile
            </h3>
          </div>
          <p className="mt-1 text-xs text-crm-muted">
            {summary.meta.documentsWithText} of {summary.meta.documentCount} document
            {summary.meta.documentCount !== 1 ? "s" : ""} scanned
            {summary.meta.intelligenceStatus === "COMPLETE" ? " · AI report ready" : ""}
          </p>
        </div>
        {summary.meta.hasConflicts ? (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
            Conflicts
          </span>
        ) : null}
      </div>

      <ContactCollapsibleSection
        id="contact-summary-verified"
        title="Verified CRM fields"
        summary={
          hasVerified
            ? `${verifiedCount} field${verifiedCount === 1 ? "" : "s"} on record`
            : "No verified fields yet"
        }
      >
        <dl className="rounded-xl border border-crm-border/50 bg-crm-surface/40 px-3">
          {verifiedKeys.map((key) => (
            <SummaryFieldRow
              key={key}
              label={VERIFIED_LABELS[key] ?? key}
              field={summary.verified[key]}
            />
          ))}
          {!hasVerified ? (
            <p className="py-2 text-xs text-crm-muted">No verified profile fields on the CRM record yet.</p>
          ) : null}
        </dl>
      </ContactCollapsibleSection>

      <ContactCollapsibleSection
        id="contact-summary-extracted"
        title="From imported documents"
        summary={
          hasExtracted
            ? `${extractedCount} extracted field${extractedCount === 1 ? "" : "s"}`
            : "Import documents to extract fields"
        }
      >
        <dl className="rounded-xl border border-crm-border/50 bg-crm-surface/40 px-3">
          {extractedKeys.map((key) => (
            <SummaryFieldRow
              key={key}
              label={EXTRACTED_LABELS[key] ?? key}
              field={summary.extracted[key]}
            />
          ))}
          {!hasExtracted ? (
            <p className="py-2 text-xs text-crm-muted">
              Import and scan documents to populate extracted fields.
            </p>
          ) : null}
        </dl>
        {summary.extracted.ssn?.displayValue ? (
          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-crm-muted">
            <Shield className="h-3 w-3" />
            SSN is masked for privacy. Full numbers are never stored or displayed.
          </p>
        ) : null}
      </ContactCollapsibleSection>

      <ContactCollapsibleSection
        id="contact-summary-phones"
        title={`All phones (${summary.phones.length})`}
        summary={
          primaryPhoneSummary
            ? primaryPhoneSummary
            : summary.phones.length > 0
              ? `${summary.phones.length} numbers on file`
              : "No phones on file"
        }
      >
        {summary.phones.length === 0 ? (
          <p className="text-xs text-crm-muted">No phone numbers on file.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {summary.phones.map((p, idx) => (
              <li
                key={`${p.normalized ?? p.number}-${idx}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-crm-border/40 bg-crm-surface/50 px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-crm-text">{p.number}</div>
                  <div className="text-[10px] text-crm-muted capitalize">
                    {p.source === "contact"
                      ? `${(p.label ?? "phone").toLowerCase()}${p.isPrimary ? " · primary" : ""}`
                      : p.label ?? "Discovered"}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                    p.source === "contact" && "bg-emerald-500/15 text-emerald-400",
                    p.source === "discovered" && "bg-violet-500/15 text-violet-300",
                    p.source === "document" && "bg-amber-500/15 text-amber-400",
                  )}
                >
                  {p.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ContactCollapsibleSection>
    </div>
  );
}
