export function MetricCard({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <article className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {meta ? <div className="metric-meta">{meta}</div> : null}
    </article>
  );
}
