"use client";

import type { MouseEvent } from "react";

export type InvoiceRowMenuProps = {
  disabled?: boolean;
  onOpen: () => void;
  onPdf: () => void;
  onActivity: () => void;
  activityOpen?: boolean;
  canAct: boolean;
  isBusy: (label: string) => boolean;
  onSend?: () => void;
  onEmailLink?: () => void;
  onRetry?: () => void;
  onMarkPaid?: () => void;
  onVoid?: () => void;
  onSms?: () => void;
};

function closeMenu(e: MouseEvent<HTMLButtonElement>) {
  (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
}

export function InvoiceRowMenu({
  disabled,
  onOpen,
  onPdf,
  onActivity,
  activityOpen,
  canAct,
  isBusy,
  onSend,
  onEmailLink,
  onRetry,
  onMarkPaid,
  onVoid,
  onSms,
}: InvoiceRowMenuProps) {
  return (
    <div className="billing-fin-row__actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="billing-fin-row__open"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        Open
      </button>
      <details className="billing-fin-menu">
        <summary className="billing-fin-menu__trigger" aria-label="Invoice actions">
          <span className="billing-fin-menu__icon" aria-hidden>
            ⋯
          </span>
        </summary>
        <div className="billing-fin-menu__panel" role="menu">
          <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); onOpen(); }}>
            Open invoice
          </button>
          {canAct && onSend ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={(e) => { closeMenu(e); onSend(); }}>
              {isBusy("Send") ? "Sending…" : "Send invoice"}
            </button>
          ) : null}
          {canAct && onEmailLink ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={(e) => { closeMenu(e); onEmailLink(); }}>
              {isBusy("Email link") ? "Sending…" : "Payment link"}
            </button>
          ) : null}
          {canAct && onRetry ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={(e) => { closeMenu(e); onRetry(); }}>
              Retry payment
            </button>
          ) : null}
          {canAct && onMarkPaid ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={(e) => { closeMenu(e); onMarkPaid(); }}>
              Mark paid
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); onPdf(); }}>
            Download PDF
          </button>
          {canAct && onSms ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={(e) => { closeMenu(e); onSms(); }}>
              SMS payment link
            </button>
          ) : null}
          {canAct && onVoid ? (
            <button type="button" role="menuitem" className="billing-fin-menu__danger" disabled={disabled} onClick={(e) => { closeMenu(e); onVoid(); }}>
              Void invoice
            </button>
          ) : null}
          <div className="billing-fin-menu__divider" role="separator" />
          <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); onActivity(); }}>
            {activityOpen ? "Hide activity" : "Activity"}
          </button>
        </div>
      </details>
    </div>
  );
}
