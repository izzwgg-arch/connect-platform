import Link from "next/link";

export function IntegrationCard({
  name,
  status,
  configureHref,
  auditHref
}: {
  name: string;
  status: string;
  configureHref?: string;
  auditHref?: string;
}) {
  return (
    <article className="panel">
      <h3>{name}</h3>
      <p className="muted">Status: {status}</p>
      <div className="row-actions">
        {configureHref ? (
          <Link className="btn" href={configureHref}>Configure</Link>
        ) : (
          <button className="btn" disabled title="Configuration route unavailable">Configure</button>
        )}
        {auditHref ? (
          <Link className="btn ghost" href={auditHref}>Audit</Link>
        ) : (
          <button className="btn ghost" disabled title="Audit route unavailable">Audit</button>
        )}
      </div>
    </article>
  );
}
