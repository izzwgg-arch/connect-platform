"use client";

import type { CSSProperties, ReactNode } from "react";

const overlayBase: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.48)",
  zIndex: 1100,
  display: "flex",
  overflow: "auto",
};

const drawerPanelBase: CSSProperties = {
  background: "var(--surface, #fff)",
  minHeight: "100%",
  boxShadow: "-6px 0 32px rgba(15, 23, 42, 0.12)",
  padding: "28px 26px 32px",
  overflowY: "auto",
  borderLeft: "1px solid color-mix(in srgb, var(--border, #e2e8f0) 80%, transparent)",
};

const centerPanelBase: CSSProperties = {
  background: "var(--surface, #fff)",
  borderRadius: 14,
  padding: "26px 28px 28px",
  margin: "auto",
  boxShadow: "0 20px 50px rgba(15, 23, 42, 0.18)",
  border: "1px solid color-mix(in srgb, var(--border, #e2e8f0) 90%, transparent)",
};

export type BillingActionPanelProps = {
  onClose: () => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  notice?: ReactNode;
  warning?: ReactNode;
  variant?: "default" | "danger";
  layout?: "drawer" | "center";
  /** CSS width for drawer layout (default `min(440px, 100vw)`). */
  drawerWidth?: string;
  /** CSS width for center layout (default `min(480px, 94vw)`). */
  centerWidth?: string;
  children?: ReactNode;
  footer: ReactNode;
};

/**
 * Reusable guided-action chrome for billing operations (portal only).
 * Drawer opens from the right (operations console); center for compact confirms.
 */
export function BillingActionPanel({
  onClose,
  eyebrow,
  title,
  subtitle,
  summary,
  notice,
  warning,
  variant = "default",
  layout = "drawer",
  drawerWidth = "min(440px, 100vw)",
  centerWidth = "min(480px, 94vw)",
  children,
  footer,
}: BillingActionPanelProps) {
  const align =
    layout === "drawer"
      ? { alignItems: "stretch" as const, justifyContent: "flex-end" as const }
      : { alignItems: "center" as const, justifyContent: "center" as const };

  const panelStyle: CSSProperties =
    layout === "drawer"
      ? { ...drawerPanelBase, width: drawerWidth }
      : { ...centerPanelBase, width: centerWidth };

  return (
    <div
      className="billing-action-panel-overlay"
      style={{ ...overlayBase, ...align }}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`billing-action-panel ${variant === "danger" ? "billing-action-panel--danger" : ""} ${layout === "drawer" ? "billing-action-panel--drawer" : "billing-action-panel--center"}`}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {eyebrow ? (
              <p
                className="billing-action-panel__eyebrow"
                style={{
                  margin: "0 0 6px",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--muted, #64748b)",
                }}
              >
                {eyebrow}
              </p>
            ) : null}
            <h2
              className="billing-action-panel__title"
              style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.02em" }}
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="billing-action-panel__close"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              fontSize: 22,
              lineHeight: 1,
              cursor: "pointer",
              color: "var(--muted, #64748b)",
              padding: "4px 6px",
              marginTop: -4,
            }}
          >
            ×
          </button>
        </div>

        {subtitle ? (
          <p className="billing-action-panel__subtitle" style={{ margin: "0 0 16px", fontSize: 14, color: "var(--muted, #475569)", lineHeight: 1.5 }}>
            {subtitle}
          </p>
        ) : null}

        {summary ? (
          <div
            className="billing-action-panel__summary"
            style={{
              marginBottom: 16,
              padding: "14px 16px",
              borderRadius: 10,
              background: "var(--surface-alt, #f8fafc)",
              border: "1px solid color-mix(in srgb, var(--border, #e2e8f0) 85%, transparent)",
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            {summary}
          </div>
        ) : null}

        {notice ? <div style={{ marginBottom: 14, fontSize: 13, color: "var(--muted, #475569)", lineHeight: 1.5 }}>{notice}</div> : null}

        {warning ? (
          <div
            className="billing-action-panel__warning"
            style={{
              marginBottom: 16,
              padding: "12px 14px",
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.5,
              background: variant === "danger" ? "#fef2f2" : "#fffbeb",
              border: `1px solid ${variant === "danger" ? "#fecaca" : "#fde68a"}`,
              color: variant === "danger" ? "#991b1b" : "#92400e",
            }}
          >
            {warning}
          </div>
        ) : null}

        {children ? <div style={{ marginBottom: 18 }}>{children}</div> : null}

        <div
          className="billing-action-panel__footer"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            justifyContent: "flex-end",
            paddingTop: 4,
            borderTop: "1px solid color-mix(in srgb, var(--border, #e2e8f0) 70%, transparent)",
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}
