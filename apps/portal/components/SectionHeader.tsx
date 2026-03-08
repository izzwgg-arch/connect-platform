export function SectionHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="section-header">
      <h3>{title}</h3>
      {right ? <span className="muted">{right}</span> : null}
    </div>
  );
}
