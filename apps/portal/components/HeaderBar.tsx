"use client";

import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import { ProfileMenu } from "./ProfileMenu";
import { TenantSwitcher } from "./TenantSwitcher";

export function HeaderBar({ title }: { title: string }) {
  return (
    <header className="header">
      <div className="header-left">
        <h1>{title}</h1>
        <TenantSwitcher />
      </div>
      <GlobalSearch />
      <div className="header-right">
        <NotificationPanel />
        <ProfileMenu />
      </div>
    </header>
  );
}
