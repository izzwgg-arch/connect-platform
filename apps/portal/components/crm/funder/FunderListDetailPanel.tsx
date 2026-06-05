"use client";

import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Edit2,
  HandCoins,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { initials } from "../contact/contactFormatters";

export type FunderStatus = "ACTIVE" | "INACTIVE" | "PROSPECT" | "PENDING";

export type FunderListRow = {
  id: string;
  name: string;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  status: FunderStatus;
  active: boolean;
  archivedAt?: string | null;
};

const STATUS_LABELS: Record<FunderStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PROSPECT: "Prospect",
  PENDING: "Pending",
};

const STATUS_HEX: Record<FunderStatus, string> = {
  ACTIVE: "#047857",
  INACTIVE: "#64748b",
  PROSPECT: "#c2410c",
  PENDING: "#b45309",
};

const AVATAR_GRADIENT = "linear-gradient(135deg, #6d5dfc 0%, #377dff 100%)";

const CHANNEL_ACTIONS = [
  { key: "email" as const, label: "Email", icon: Mail },
  { key: "sms" as const, label: "SMS", icon: MessageSquare },
  { key: "call" as const, label: "Call", icon: Phone },
];

export function FunderListDetailPanel({
  funder,
  rank,
  total,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onOpen,
  onEdit,
  onDelete,
}: {
  funder: FunderListRow;
  rank: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpen: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const archived = !!(funder.archivedAt || funder.active === false);
  const location = [funder.city, funder.state, funder.zip].filter(Boolean).join(", ");
  const statusColor = STATUS_HEX[funder.status];

  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel custom-scrollbar" aria-label="Funder details">
      <div className="crm-queue-detail-glow" aria-hidden />

      <header className="crm-queue-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="crm-queue-detail-status-pill crm-queue-pill crm-queue-pill-stage"
            style={{
              background: statusColor + "18",
              color: statusColor,
            }}
          >
            {STATUS_LABELS[funder.status]}
          </span>
          {archived ? (
            <span className="crm-queue-pill crm-queue-pill-warning inline-flex items-center gap-1">
              <Archive className="h-3 w-3" />
              Archived
            </span>
          ) : null}
        </div>
        <span className="crm-queue-detail-position tabular-nums">
          {rank} <span className="text-crm-muted/60">/</span> {total}
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar" style={{ background: AVATAR_GRADIENT }}>
          {initials(funder.name)}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="crm-queue-detail-name truncate">{funder.name}</h2>
          <p className="crm-queue-detail-sub truncate">
            {funder.organization || "Funder"}
            {location ? (
              <>
                <span className="text-crm-muted/50 mx-1.5">·</span>
                {location}
              </>
            ) : null}
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-contact-strip">
        <div className="crm-queue-detail-channel-row">
          {CHANNEL_ACTIONS.map(({ key, label, icon: Icon }) => {
            const disabled =
              archived ||
              (key === "email" && !funder.email) ||
              ((key === "sms" || key === "call") && !funder.phone);
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (key === "email" && funder.email) window.location.href = `mailto:${funder.email}`;
                  if (key === "sms" && funder.phone) window.location.href = `sms:${funder.phone}`;
                  if (key === "call" && funder.phone) window.location.href = `tel:${funder.phone}`;
                }}
                className={cn(
                  "crm-queue-detail-channel",
                  `crm-queue-detail-channel-${key}`,
                  key === "call" && "crm-queue-detail-channel-call",
                )}
                title={
                  disabled
                    ? key === "email"
                      ? "No email on file"
                      : "No phone on file"
                    : `Open ${label.toLowerCase()} funder`
                }
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <div className="crm-queue-detail-lines">
          <div className="crm-queue-detail-line">
            <Phone className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="font-mono text-[13px]">{funder.phone || "No phone on file"}</span>
          </div>
          <div className="crm-queue-detail-line">
            <Mail className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="truncate text-[13px]">{funder.email || "No email on file"}</span>
          </div>
        </div>
      </section>

      {archived ? (
        <div className="crm-queue-detail-alert">
          <Archive className="h-4 w-4 shrink-0" />
          Archived funder — open record to review history.
        </div>
      ) : null}

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Funder actions</p>
        <button
          type="button"
          onClick={onOpen}
          disabled={archived}
          className={cn(crm.btnPrimary, "crm-queue-detail-primary-action w-full justify-center gap-2")}
        >
          <PhoneCall className="h-4 w-4" />
          Open funder
        </button>
        <div className="crm-queue-detail-action-grid">
          {onEdit && !archived ? (
            <button type="button" onClick={onEdit} className="crm-queue-detail-secondary-action">
              <Edit2 className="h-4 w-4" />
              Edit funder
            </button>
          ) : null}
          {onDelete && !archived ? (
            <button type="button" onClick={onDelete} className="crm-queue-detail-secondary-action crm-queue-detail-danger-action">
              <Archive className="h-4 w-4" />
              Delete
            </button>
          ) : null}
        </div>
      </section>

      <footer className="crm-queue-detail-footer">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  );
}

export function FunderListDetailPlaceholder() {
  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel crm-queue-detail-placeholder custom-scrollbar" aria-label="Funder details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <div className="crm-queue-detail-placeholder-icon">
        <HandCoins size={22} />
      </div>
      <h2>Select a funder</h2>
      <p>
        Choose a funder from the list to review details, open the record, or start email, SMS, or call actions.
      </p>
    </aside>
  );
}
