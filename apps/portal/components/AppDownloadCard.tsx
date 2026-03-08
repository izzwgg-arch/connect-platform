export function AppDownloadCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      <div className="row-actions">
        <button className="btn">Download APK</button>
        <button className="btn ghost">Open App Store</button>
      </div>
    </div>
  );
}
