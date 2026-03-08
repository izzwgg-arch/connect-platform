"use client";

import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import { ProfileMenu } from "./ProfileMenu";
import { TenantSwitcher } from "./TenantSwitcher";
import { TopQuickActions } from "./TopQuickActions";

type TopbarProps = {
  title: string;
  onToggleNav: () => void;
};

export function Topbar({ title, onToggleNav }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn nav-toggle" onClick={onToggleNav} aria-label="Toggle navigation">
          NV
        </button>
        <div className="topbar-title-wrap">
          <div className="topbar-title">{title}</div>
          <TenantSwitcher />
        </div>
      </div>
      <div className="topbar-center">
        <GlobalSearch />
      </div>
      <div className="topbar-right">
        <TopQuickActions />
        <NotificationPanel />
        <ProfileMenu />
      </div>
    </header>
  );
}
