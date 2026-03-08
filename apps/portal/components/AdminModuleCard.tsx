export function AdminModuleCard({ title, summary }: { title: string; summary: string }) {
  return (
    <article className="panel">
      <h3>{title}</h3>
      <p className="muted">{summary}</p>
      <button className="btn ghost">Open Module</button>
    </article>
  );
}
