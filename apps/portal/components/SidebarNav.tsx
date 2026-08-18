"use client";

import Link from "next/link";
import { useUiLanguage } from "../hooks/useUiLanguage";
import type { MouseEvent as ReactMouseEvent } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useNavSectionExpansion } from "../hooks/useNavSectionExpansion";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserAvatarUpload } from "./UserAvatarUpload";
import { NAV_SECTION_ORDER, navSectionMeta, type NavItem } from "../navigation/navConfig";
import { CollapsibleNavSection } from "./CollapsibleNavSection";
import { getPreferredUserDisplayName } from "../lib/userDisplayName";
import { installDesktopUpdate, useDesktopUpdate } from "./DesktopUpdateNotice";

type SidebarNavProps = {
  items: NavItem[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
  isMobile: boolean;
  railMode: boolean;
  onToggleRail: () => void;
  /** False until the stored rail choice has been applied and painted. While
   *  false the sidebar does not animate, so restoring a saved collapsed
   *  sidebar is instant rather than a slide on every page load. */
  settled?: boolean;
  /** Unread count badges keyed by NavItem.badgeKey (e.g. "chat", "voicemail"). */
  badges?: Record<string, number>;
};

function navLinkActive(pathname: string, href: string) {
  if (href.startsWith("/downloads/")) return false;
  if (pathname === href) return true;
  if (href === "/dashboard") return false;
  return pathname.startsWith(`${href}/`);
}


/** Every sidebar label and section heading, generated from navConfig so the
 *  two can't drift apart. Registered once; the whole sidebar arrives in a
 *  single cached call. */
const NAV_PHRASES = [
  "AI Assistant",
  "AI Trainer",
  "Admin",
  "Admin Billing",
  "Admin Console",
  "Apps",
  "Audio Intelligence",
  "Audit Log",
  "Billing",
  "Billing Overview",
  "Billing Settings",
  "CDR Tenant Map",
  "CRM",
  "CRM Dashboard",
  "CRM Diagnostics",
  "CRM Settings",
  "Call Flight Recorder",
  "Call History",
  "Call Recordings",
  "Call Reports",
  "Call Timeline",
  "Campaigns",
  "Chat",
  "Checklists",
  "Contacts",
  "Custom Roles",
  "Customer Hub",
  "DID Routing",
  "Dashboard",
  "Deploy Center",
  "Drivers",
  "Email",
  "Email Settings",
  "Exceptions",
  "Extensions",
  "Forms",
  "Funders",
  "IVR Migration",
  "IVR Studio",
  "Incident Center",
  "Install",
  "Live Call Workspace",
  "Live Map",
  "Live Wallboard",
  "MOH Scheduling",
  "Messaging Settings",
  "My Queue",
  "Onboarding",
  "Ops Center",
  "Orders",
  "Overview",
  "PBX",
  "PBX Events",
  "PBX Instances",
  "Permissions",
  "Phone Numbers",
  "Reports",
  "Runs",
  "SBC Connectivity",
  "SMS Campaigns",
  "Scripts",
  "Server Health",
  "Settings",
  "Storage Health",
  "System Health",
  "Tasks",
  "Team Directory",
  "Tenant Settings",
  "Tenants",
  "Time Conditions",
  "Tracking",
  "Users",
  "VoIP.ms",
  "Voicemail",
  "Voicemail Drops",
  "WebRTC Softphone",
  "WhatsApp Inbox",
  "Workspace",
];

export function SidebarNav({
  items,
  mobileOpen,
  onCloseMobile,
  isMobile,
  railMode,
  onToggleRail,
  settled = true,
  badges = {},
}: SidebarNavProps) {
  const pathname = usePathname();
  const { user, setUserAvatarUrl } = useAppContext();
  // Every nav label + section heading is registered so the whole sidebar is
  // fetched in one cached call. It shows on every page, so this is the single
  // highest-value place to translate.
  const { t } = useUiLanguage(NAV_PHRASES);
  const { isExpanded, toggle } = useNavSectionExpansion();
  const displayName = getPreferredUserDisplayName(user);

  // Desktop auto-update: when the shell reports an update, the "Install" nav
  // item becomes the in-app update surface — "New Update" chip, download
  // progress, and a one-click install (quitAndInstall) instead of the browser
  // download link. In the web portal (no bridge) it stays a plain download.
  const desktopUpdate = useDesktopUpdate();
  const updateReady = desktopUpdate?.status === "downloaded";
  const updateDownloading = desktopUpdate?.status === "available" || desktopUpdate?.status === "downloading";
  const installChip = updateReady
    ? "New Update"
    : updateDownloading
      ? `Downloading ${desktopUpdate?.percent ?? 0}%`
      : null;
  const handleInstallItemClick = (item: NavItem, event: ReactMouseEvent) => {
    if (item.id !== "workspace.install") return;
    if (updateReady) {
      event.preventDefault();
      installDesktopUpdate();
    } else if (updateDownloading) {
      event.preventDefault(); // already on its way — don't also download the installer
    }
  };

  const effectiveRail = !isMobile && railMode;
  // ⛔ The rail/expanded switch is a CLASS on the <aside> and NOTHING ELSE.
  // It must never swap markup. Measured on the real stylesheet: any DOM
  // mutation inside .console-shell costs ~70ms of style recalculation (the
  // sheet carries 73 `:has()` rules, whose invalidation work is paid per
  // mutation regardless of how small the mutation is). The old code rendered
  // two different trees, so every toggle tore down and rebuilt all ~72 nav
  // links and stalled the main thread for 80-130ms — right at the start of
  // the 220ms width transition. That stall IS the jitter. A class-only
  // toggle measures 0.2ms. Keep one tree.
  const asideClass = [
    "console-nav",
    isMobile && mobileOpen ? "open" : "",
    !isMobile && effectiveRail ? "nav-rail" : "",
    !isMobile && !effectiveRail ? "nav-expanded" : "",
    settled ? "" : "nav-no-anim"
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside className={asideClass}>
      <div className="drawer-profile">
        <div className="drawer-user" title={effectiveRail ? displayName : undefined}>
          <UserAvatarUpload
            name={displayName}
            avatarUrl={user.avatarUrl}
            size={38}
            editable
            onUploaded={setUserAvatarUrl}
            className="drawer-user-avatar"
          />
          <div className="drawer-user-details">
            <span className="drawer-user-name">{displayName}</span>
          </div>
        </div>
        <div className="drawer-tenant-wrap">
          <TenantSwitcher railMode={effectiveRail} />
        </div>
      </div>

      <nav className="drawer-nav" aria-label="Main navigation">
        {NAV_SECTION_ORDER.map((section) => {
          const sectionItems = items.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;
          const label = t(navSectionMeta[section].label);
          // In the rail there is no room for a heading, so every section is
          // shown open (CSS forces the panel to 1fr). The stored expand/collapse
          // choice is kept untouched and comes back when the sidebar reopens.
          const expanded = isExpanded(section);
          return (
            <CollapsibleNavSection
              key={section}
              id={`nav-sec-${section}`}
              label={label}
              expanded={expanded}
              onToggle={() => toggle(section)}
            >
              {sectionItems.map((item) => {
                const active = navLinkActive(pathname, item.href);
                const Icon = item.lucide;
                const badgeCount = item.badgeKey ? (badges[item.badgeKey] ?? 0) : 0;
                const isInstall = item.id === "workspace.install";
                const itemLabel = t(item.label);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    download={item.download ? "" : undefined}
                    prefetch={item.download ? false : undefined}
                    className={`drawer-nav-link ${active ? "active" : ""}`}
                    // Only the collapsed rail needs a tooltip — the expanded
                    // sidebar already shows the label. This is an attribute
                    // update, not a DOM change: measured 2.2ms across all links.
                    title={
                      effectiveRail
                        ? isInstall && installChip
                          ? `${itemLabel} — ${installChip}`
                          : itemLabel
                        : undefined
                    }
                    onClick={(event) => { handleInstallItemClick(item, event); onCloseMobile(); }}
                  >
                    <span className="drawer-nav-icon drawer-nav-icon-lucide">
                      <Icon size={18} strokeWidth={1.85} />
                    </span>
                    <span className="drawer-nav-label">{itemLabel}</span>
                    {isInstall && installChip ? (
                      <span
                        className={`drawer-nav-chip ${updateReady ? "drawer-nav-chip-ready" : ""}`}
                        aria-label={installChip}
                      >
                        <span className="drawer-nav-chip-text">{installChip}</span>
                      </span>
                    ) : null}
                    {badgeCount > 0 ? (
                      <span className="drawer-nav-badge" aria-label={`${badgeCount} unread`}>
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </CollapsibleNavSection>
          );
        })}
      </nav>

      {!isMobile ? (
        <div className="drawer-footer">
          <button
            type="button"
            className="drawer-rail-toggle"
            onClick={onToggleRail}
            title={effectiveRail ? "Expand sidebar" : "Collapse to icons"}
            aria-label={effectiveRail ? "Expand sidebar" : "Collapse sidebar to icon rail"}
          >
            {effectiveRail ? <PanelLeftOpen size={18} strokeWidth={1.85} /> : <PanelLeftClose size={18} strokeWidth={1.85} />}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
