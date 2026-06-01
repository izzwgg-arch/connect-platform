"use client";

import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CrmConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div className={crm.campaignModalBackdrop} role="dialog" aria-modal="true" aria-labelledby="crm-confirm-title">
      <div className={cn(crm.card, "w-full max-w-md p-6 shadow-xl")}>
        <h2 id="crm-confirm-title" className="text-lg font-semibold text-crm-text">
          {title}
        </h2>
        {description ? <p className="mt-2 text-sm text-crm-muted leading-relaxed">{description}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={loading} className={crm.btnSecondary}>
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={destructive ? crm.btnDanger : crm.btnPrimary}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
