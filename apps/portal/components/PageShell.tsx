"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSidebarRail } from "../hooks/useSidebarRail";
import { useSidebarGlide } from "../hooks/useSidebarGlide";
import { useNavBadges } from "../hooks/useNavBadges";
import { isNavItemVisibleForUser, navItems } from "../navigation/navConfig";
import { SidebarNav } from "./SidebarNav";
import { Topbar } from "./Topbar";
import { DesktopShellBeacon, DesktopUpdateToast } from "./DesktopUpdateNotice";
import { isLocalhostDev } from "../lib/localDev";

function titleFromPath(pathname: string): string {
  const match = [...navItems]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  if (match) return match.label;
  const fallback = pathname.split("/").filter(Boolean).pop() || "Dashboard";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1).replace(/-/g, " ");
}
export function PageShell({ children, banners }: { children: ReactNode; banners?: ReactNode }) {
  const pathname = usePathname();
  const { can, backendJwtRole, permissionsHydrated } = useAppContext();
  const isMobile = useMediaQuery("(max-width: 1080px)");
  const { railMode, toggleRail, settled: sidebarSettled } = useSidebarRail();
  // The sidebar's motion is driven here, not by a width transition — see
  // useSidebarGlide for why that distinction is the whole fix.
  const { navRef, workspaceRef } = useSidebarGlide(railMode, sidebarSettled && !isMobile);
  const rawBadges = useNavBadges();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const visibleItems = useMemo(
    () => navItems.filter((item) => isNavItemVisibleForUser(item, can, backendJwtRole)),
    [can, backendJwtRole],
  );
  const activeNavItem = useMemo(
    () => [...navItems]
      .sort((a, b) => b.href.length - a.href.length)
      .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)),
    [pathname],
  );
  const routeAllowed =
    !activeNavItem || isNavItemVisibleForUser(activeNavItem, can, backendJwtRole);
  const isCrmDashboardRoute = pathname === "/crm/dashboard";
  const isCrmReportsRoute = pathname === "/crm/reports" || pathname.startsWith("/crm/reports/");
  const isCrmQueueRoute =
    pathname === "/crm/queue" || pathname === "/crm/contacts" || pathname.startsWith("/crm/contacts/");
  const isCrmEmailRoute = pathname === "/crm/email" || pathname.startsWith("/crm/email/");
  const isCrmLiveCallRoute = pathname === "/crm/live-call";

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  const handleToggleNav = () => {
    if (isMobile) setMobileNavOpen((v) => !v);
    else toggleRail();
  };

  return (
    <div
      className={
        isCrmDashboardRoute
          ? "console-shell crm-dashboard-shell"
          : isCrmReportsRoute
            ? "console-shell crm-reports-shell"
            : isCrmQueueRoute
            ? "console-shell crm-queue-shell"
            : isCrmEmailRoute
              ? "console-shell crm-queue-shell"
              : isCrmLiveCallRoute
                ? "console-shell crm-live-shell"
                : "console-shell"
      }
    >
      {/* Fixed header — always on top, never moves */}
      <Topbar title={titleFromPath(pathname)} onToggleNav={handleToggleNav} />

      {/* Body below header: drawer + content side by side */}
      <div className="console-body">
        <SidebarNav
          items={visibleItems}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          isMobile={isMobile}
          railMode={railMode}
          onToggleRail={toggleRail}
          settled={sidebarSettled}
          navRef={navRef}
          badges={{
            chat: pathname.startsWith("/chat") ? 0 : rawBadges.chat,
            voicemail: pathname.startsWith("/voicemail") ? 0 : rawBadges.voicemail,
          }}
        />
        <div className="console-workspace" ref={workspaceRef}>
          {banners ? <div className="workspace-banners">{banners}</div> : null}
          <main className="console-content custom-scrollbar">
            {permissionsHydrated && !routeAllowed ? (
              <div className="state-box" style={{ padding: 32 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Access denied</div>
                <div className="muted">You do not have permission to access {activeNavItem?.label || "this page"}.</div>
                {isLocalhostDev() && activeNavItem?.section === "crm" ? (
                  <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                    Local dev: click <strong>Local dev sign-in</strong> on the login page, or run{" "}
                    <code>pnpm bootstrap:local</code> then sign in again.
                  </p>
                ) : null}
                {isLocalhostDev() && activeNavItem?.section === "admin" ? (
                  <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                    Local dev: Admin pages require JWT role <strong>SUPER_ADMIN</strong>. Sign out, run{" "}
                    <code>pnpm exec tsx scripts/promote-local-super-admin.ts</code>, then sign in again with{" "}
                    <strong>Local dev sign-in</strong>.
                  </p>
                ) : null}
              </div>
            ) : (
              children
            )}
          </main>
        </div>
      </div>

      {/* ⛔ These two live here, NOT inside <SidebarNav>. The toast is
          position: fixed, and at mobile widths the sidebar carries a transform
          (it slides on the compositor now) — a transformed ancestor makes a
          fixed descendant position against it instead of the viewport, which
          would drag the toast off-screen with the closed drawer. */}
      <DesktopUpdateToast />
      {/* Desktop-only, invisible: reports shell version + user for the install census. */}
      <DesktopShellBeacon />

      {/* Mobile backdrop only — hidden on desktop via CSS */}
      {isMobile && mobileNavOpen ? (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
    </div>
  );
}
