export function IntegrationCard({ name, status }: { name: string; status: string }) {
  return (
    <article className="panel">
      <h3>{name}</h3>
      <p className="muted">Status: {status}</p>
      <div className="row-actions">
        <button className="btn">Configure</button>
        <button className="btn ghost">Audit</button>
      </div>
    </article>
  );
}
