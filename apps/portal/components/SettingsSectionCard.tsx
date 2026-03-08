import type { ReactNode } from "react";

export function SettingsSectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      <div className="stack">{children}</div>
    </section>
  );
}
