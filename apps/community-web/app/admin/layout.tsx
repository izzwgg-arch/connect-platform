"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Icon } from "@/components/ui";
import "@/components/admin/admin.css";

type Overview = { counts: { openCases: number; pendingVerifications: number } };

const NAV: Array<{ group: string; items: Array<{ href: string; label: string; icon: string; badgeKey?: "openCases" | "pendingVerifications" }> }> = [
  { group: "Overview", items: [{ href: "/admin", label: "Overview", icon: "chart" }] },
  {
    group: "Moderation",
    items: [
      { href: "/admin/moderation", label: "Reports", icon: "flag", badgeKey: "openCases" },
      { href: "/admin/verifications", label: "Verification queue", icon: "check", badgeKey: "pendingVerifications" },
    ],
  },
  {
    group: "Directory",
    items: [
      { href: "/admin/users", label: "Users", icon: "people" },
      { href: "/admin/organizations", label: "Organizations", icon: "bldg" },
      { href: "/admin/content", label: "Content", icon: "tag" },
    ],
  },
  {
    group: "Platform",
    items: [
      { href: "/admin/audit", label: "Audit log", icon: "doc" },
      { href: "/admin/security", label: "Security", icon: "lock" },
      { href: "/admin/notifications", label: "Notifications health", icon: "bell" },
      { href: "/admin/flags", label: "Feature flags", icon: "gear" },
      { href: "/admin/experiments", label: "Experiments", icon: "chart" },
    ],
  },
];

function AdminShell({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    if (!me?.staffRole) return;
    api<Overview>("/admin/overview").then(setOverview).catch(() => undefined);
  }, [me?.staffRole]);

  useEffect(() => {
    if (me && !me.staffRole) router.replace("/");
  }, [me, router]);

  if (!me?.staffRole) return null;

  return (
    <div className="admin">
      <aside className="aside">
        <div className="brand">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
          <span>Admin</span>
        </div>
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="grp">{g.group}</div>
            <div className="list" style={{ gap: 2 }}>
              {g.items.map((it) => {
                const on = it.href === "/admin" ? pathname === "/admin" : pathname.startsWith(it.href);
                const badge = it.badgeKey ? overview?.counts[it.badgeKey] : undefined;
                return (
                  <Link key={it.href} href={it.href} className={`nav ${on ? "on" : ""}`} data-testid={`admin-nav-${it.href.replace(/^\//, "").replace(/\//g, "-") || "overview"}`}>
                    <Icon name={it.icon} />
                    {it.label}
                    {badge ? <span className="b">{badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
        <Link href="/" className="nav" style={{ marginTop: 14 }} data-testid="admin-nav-back">
          <Icon name="back" />
          Back to Loopcom
        </Link>
      </aside>
      <div className="content">{children}</div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AdminShell>{children}</AdminShell>
    </RequireAuth>
  );
}
