import Link from "next/link";

export function TopQuickActions() {
  return (
    <div className="quick-actions">
      <Link href="/calls" className="btn ghost">Live Calls</Link>
      <Link href="/apps" className="btn ghost">Mobile Pairing</Link>
      <Link href="/settings" className="btn ghost">Status</Link>
    </div>
  );
}
