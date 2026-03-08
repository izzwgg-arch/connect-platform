import Link from "next/link";

export function TopQuickActions() {
  return (
    <div className="quick-actions" aria-label="Quick actions">
      <Link href="/calls" className="icon-btn" title="Calls">
        CL
      </Link>
      <Link href="/sms" className="icon-btn" title="Messages">
        MS
      </Link>
      <Link href="/apps" className="icon-btn" title="Pairing">
        AP
      </Link>
    </div>
  );
}
