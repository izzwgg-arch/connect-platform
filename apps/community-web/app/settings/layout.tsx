"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Icon } from "@/components/ui";

const ITEMS = [
  ["/settings", "Account", "key"],
  ["/settings/security", "Security & devices", "lock"],
  ["/settings/privacy", "Privacy", "eye"],
  ["/settings/notifications", "Notifications", "bell"],
  ["/settings/blocked", "Blocked", "x"],
  ["/settings/data", "Your data", "dl"],
] as const;

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <RequireAuth>
      <AppShell title="Settings">
        <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 16 }} className="settings-grid">
          <div className="card tight" style={{ alignSelf: "start" }}>
            <div className="list" style={{ gap: 2 }}>
              {ITEMS.map(([href, label, icon]) => (
                <Link key={href} href={href} className={`nav ${pathname === href ? "on" : ""}`}>
                  <Icon name={icon} />
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div className="col">{children}</div>
        </div>
        <style>{`@media (max-width: 900px){.settings-grid{grid-template-columns:minmax(0,1fr)!important}}`}</style>
      </AppShell>
    </RequireAuth>
  );
}
