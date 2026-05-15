import type { ReactNode } from "react";

export function DetailCard({
  title,
  actions,
  children,
  dataTestId,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Optional stable hook for Playwright smoke tests. */
  dataTestId?: string;
}) {
  return (
    <section className="panel" data-testid={dataTestId}>
      <div className="panel-head">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
