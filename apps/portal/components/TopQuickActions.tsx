"use client";

import { Phone, MessageSquare } from "lucide-react";
import Link from "next/link";

export function TopQuickActions() {
  return (
    <div className="quick-actions" aria-label="Quick actions">
      <Link href="/calls" className="icon-btn" title="Calls">
        <Phone size={16} />
      </Link>
      <Link href="/sms" className="icon-btn" title="Messages">
        <MessageSquare size={16} />
      </Link>
    </div>
  );
}
