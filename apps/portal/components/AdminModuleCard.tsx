import Link from "next/link";

export function AdminModuleCard({ title, summary, href }: { title: string; summary: string; href?: string }) {
  return (
    <article className="panel">
      <h3>{title}</h3>
      <p className="muted">{summary}</p>
      {href ? (
        <Link className="btn ghost" href={href}>Open Module</Link>
      ) : (
        <span className="chip default" style={{ fontSize: 11 }}>Coming soon</span>
      )}
    </article>
  );
}
