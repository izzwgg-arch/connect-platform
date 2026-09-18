"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Avatar, Icon, Menu } from "@/components/ui";

/**
 * The signed-in shell: sidebar (the catalog of pages), top bar with universal
 * search, live badges, avatar menu. Mobile: hamburger + bottom tabs.
 */
export const NAV: Array<{ section: string; items: Array<{ icon: string; label: string; href: string; badge?: "notifications" | "messages" | "invitations" }> }> = [
  {
    section: "Workspace",
    items: [
      { icon: "home", label: "Home", href: "/" },
      { icon: "people", label: "My network", href: "/network", badge: "invitations" },
      { icon: "chat", label: "Messages", href: "/messages", badge: "messages" },
      { icon: "bell", label: "Notifications", href: "/notifications", badge: "notifications" },
      { icon: "search", label: "Search", href: "/search" },
    ],
  },
  {
    section: "Find & sell",
    items: [
      { icon: "brief", label: "Jobs", href: "/jobs" },
      { icon: "tag", label: "Marketplace", href: "/marketplace" },
      { icon: "quote", label: "RFQs", href: "/rfq" },
      { icon: "spark", label: "Opportunities", href: "/opportunities" },
      { icon: "star", label: "Concierge", href: "/concierge" },
    ],
  },
  {
    section: "Community",
    items: [
      { icon: "group", label: "Groups", href: "/groups" },
      { icon: "cal", label: "Events", href: "/events" },
    ],
  },
  {
    section: "My business",
    items: [
      { icon: "bldg", label: "Company page", href: "/company" },
      { icon: "gear", label: "Company admin", href: "/company/admin" },
      { icon: "brief", label: "Hiring", href: "/company/hiring" },
      { icon: "chart", label: "Analytics", href: "/company/analytics" },
    ],
  },
  {
    section: "Relationships",
    items: [
      { icon: "star", label: "My CRM", href: "/crm" },
      { icon: "spark", label: "For you", href: "/recommendations" },
    ],
  },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/company") return pathname === "/company" || (pathname.startsWith("/company/") && !pathname.startsWith("/company/admin") && !pathname.startsWith("/company/analytics") && !pathname.startsWith("/company/hiring"));
  return pathname === href || pathname.startsWith(href + "/");
}

export function AppShell({ children, cols = "", title }: { children: ReactNode; cols?: "" | "two" | "three" | "narrow"; title?: string }) {
  const { me, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        (document.getElementById("global-search") as HTMLInputElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!me) return null;
  const fullName = me.profile ? `${me.profile.firstName} ${me.profile.lastName}` : me.person.username;
  const primaryOrg = me.memberships.find((m) => m.isPrimary) ?? me.memberships[0];
  const badge = (b?: "notifications" | "messages" | "invitations") => (b && me.counts[b] > 0 ? <span className="b">{me.counts[b] > 99 ? "99+" : me.counts[b]}</span> : null);

  return (
    <div className="app">
      {open ? <div className="scrim" onClick={() => setOpen(false)} /> : null}
      <aside className={`side ${open ? "open" : ""}`} aria-label="Main navigation">
        <Link href="/" className="logo">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
          <span className="cm">Community</span>
        </Link>
        {NAV.map((sec) => (
          <div key={sec.section}>
            <div className="sec">{sec.section}</div>
            {sec.items.map((it) => (
              <Link key={it.href} href={it.href} className={`nav ${isActive(pathname, it.href) ? "on" : ""}`} aria-current={isActive(pathname, it.href) ? "page" : undefined} data-testid={`nav-${it.href.replace(/\//g, "-") || "home"}`}>
                <Icon name={it.icon} />
                {it.label}
                {badge(it.badge)}
              </Link>
            ))}
          </div>
        ))}
        {me.staffRole ? (
          <Link href="/admin" className={`nav ${pathname.startsWith("/admin") ? "on" : ""}`} style={{ marginTop: 8 }}>
            <Icon name="shield" />
            Admin console
          </Link>
        ) : null}
        <Link href="/settings" className={`nav ${pathname.startsWith("/settings") ? "on" : ""}`} style={{ marginTop: me.staffRole ? 0 : 8 }}>
          <Icon name="gear" />
          Settings
        </Link>
        <Link href={`/people/${me.person.username}`} className="me">
          <Avatar name={fullName} assetId={me.profile?.avatarAssetId} size={34} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fullName}</b>
            <small>{primaryOrg?.organization.displayName ?? me.profile?.headline ?? "View profile"}</small>
          </div>
        </Link>
      </aside>
      <div className="main">
        <header className="top">
          <button type="button" className="ib" aria-label="Menu" onClick={() => setOpen(true)} id="hamburger">
            <Icon name="menu" />
          </button>
          <form
            className="q"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <Icon name="search" />
            <input id="global-search" placeholder="Search people, businesses, jobs, RFQs…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <kbd>/</kbd>
          </form>
          <div className="acts">
            <Link href="/post/new" className="btn p s" data-testid="top-post">
              <Icon name="plus" />
              Post
            </Link>
            <Link href="/messages" className="ib" aria-label="Messages">
              <Icon name="chat" />
              {me.counts.messages > 0 ? <span className="cnt">{me.counts.messages > 99 ? "99+" : me.counts.messages}</span> : null}
            </Link>
            <Link href="/notifications" className="ib" aria-label="Notifications">
              <Icon name="bell" />
              {me.counts.notifications > 0 ? <span className="cnt">{me.counts.notifications > 99 ? "99+" : me.counts.notifications}</span> : null}
            </Link>
            <Link href="/me/qr" className="ib" aria-label="My QR code">
              <Icon name="qr" />
            </Link>
            <button type="button" className="ib" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle} data-testid="theme-toggle">
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <Menu trigger={<Avatar name={fullName} assetId={me.profile?.avatarAssetId} size={30} />} label="Account menu">
              <Link href={`/people/${me.person.username}`}>
                <Icon name="people" />
                View profile
              </Link>
              <Link href="/settings">
                <Icon name="gear" />
                Settings
              </Link>
              <Link href="/settings/security">
                <Icon name="lock" />
                Security &amp; devices
              </Link>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    // A client-side router.push("/") after clearing `me` races
                    // RequireAuth's own effect on whatever auth-required page we're
                    // currently on (Settings, CRM, Company admin, ...): that effect
                    // reacts to `me` becoming null and calls router.replace(`/login
                    // ?next=<current page>`), which reliably wins the race and
                    // strands the viewer on a login prompt for the page they just
                    // left instead of the public home page. A hard navigation sidesteps
                    // the race entirely by discarding that page's React tree first.
                    await signOut();
                    window.location.href = "/";
                  })();
                }}
              >
                <Icon name="logout" />
                Sign out
              </button>
            </Menu>
          </div>
        </header>
        {title ? <h1 className="sr-only">{title}</h1> : null}
        <div className={`content ${cols}`}>{children}</div>
        <nav className="mobile-tabs" aria-label="Primary">
          {[
            ["home", "Home", "/"],
            ["people", "Network", "/network"],
            ["plus", "Post", "/post/new"],
            ["chat", "Messages", "/messages"],
            ["menu", "More", "#menu"],
          ].map(([icon, label, href]) =>
            href === "#menu" ? (
              <a key={label} href="#" onClick={(e) => { e.preventDefault(); setOpen(true); }}>
                <Icon name={icon} />
                {label}
              </a>
            ) : (
              <Link key={label} href={href} className={isActive(pathname, href) ? "on" : ""}>
                <Icon name={icon} />
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </div>
  );
}
