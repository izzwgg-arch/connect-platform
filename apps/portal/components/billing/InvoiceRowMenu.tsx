"use client";

import { useState, useRef, useEffect, useCallback, type MouseEvent } from "react";
import { createPortal } from "react-dom";

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
  onDelete?: () => void;
  onSms?: () => void;
};

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
  onDelete,
  onSms,
}: InvoiceRowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    setPanelStyle({
      position: "fixed",
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
      left: "auto",
      zIndex: 9999,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: PointerEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !panelRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleDown);
    return () => document.removeEventListener("pointerdown", handleDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  function act(cb: () => void) {
    return (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setOpen(false);
      cb();
    };
  }

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          className="billing-fin-menu__panel"
          role="menu"
          style={panelStyle}
        >
          <button type="button" role="menuitem" onClick={act(onOpen)}>
            Open invoice
          </button>
          {canAct && onSend ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={act(onSend)}>
              {isBusy("Send") ? "Sending…" : "Send invoice"}
            </button>
          ) : null}
          {canAct && onEmailLink ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={act(onEmailLink)}>
              {isBusy("Email link") ? "Sending…" : "Payment link"}
            </button>
          ) : null}
          {canAct && onRetry ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={act(onRetry)}>
              Retry payment
            </button>
          ) : null}
          {canAct && onMarkPaid ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={act(onMarkPaid)}>
              Mark paid
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={act(onPdf)}>
            Download PDF
          </button>
          {canAct && onSms ? (
            <button type="button" role="menuitem" disabled={disabled} onClick={act(onSms)}>
              SMS invoice link
            </button>
          ) : null}
          {canAct && onVoid ? (
            <button
              type="button"
              role="menuitem"
              className="billing-fin-menu__danger"
              disabled={disabled}
              onClick={act(onVoid)}
            >
              Void invoice
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              role="menuitem"
              className="billing-fin-menu__danger"
              disabled={disabled}
              onClick={act(onDelete)}
            >
              Delete permanently
            </button>
          ) : null}
          <div className="billing-fin-menu__divider" role="separator" />
          <button type="button" role="menuitem" onClick={act(onActivity)}>
            {activityOpen ? "Hide activity" : "Activity"}
          </button>
        </div>,
        document.body,
      )
    : null;

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
      <div className={`billing-fin-menu${open ? " billing-fin-menu--open" : ""}`}>
        <button
          ref={triggerRef}
          type="button"
          className="billing-fin-menu__trigger"
          aria-label="Invoice actions"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <span className="billing-fin-menu__icon" aria-hidden>
            ⋯
          </span>
        </button>
        {panel}
      </div>
    </div>
  );
}
