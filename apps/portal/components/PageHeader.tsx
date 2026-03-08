import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  badges,
  actions
}: {
  title: string;
  subtitle?: string;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {badges ? <div className="header-badges">{badges}</div> : null}
      </div>
      {actions}
    </div>
  );
}
