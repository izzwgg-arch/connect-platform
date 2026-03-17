"use client";

import { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import { FloatingDialer } from "./FloatingDialer";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import { ProfileMenu } from "./ProfileMenu";
import { TenantSwitcher } from "./TenantSwitcher";
import { TopQuickActions } from "./TopQuickActions";
import { useAppContext } from "../hooks/useAppContext";
import { useTelephony } from "../contexts/TelephonyContext";

type TopbarProps = {
  title: string;
  onToggleNav: () => void;
};

function useCurrentTime() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const format = () => {
      const d = new Date();
      setTime(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    format();
    const id = setInterval(format, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

export function Topbar({ title, onToggleNav }: TopbarProps) {
  const { tenant, adminScope } = useAppContext();
  const telephony = useTelephony();
  const currentTime = useCurrentTime();
  const isConnected = telephony.status === "connected";
  const viewingLabel = adminScope === "TENANT" ? tenant.name : "All tenants (Global)";

  return (
    <header className="topbar topbar-2026">
      <div className="topbar-left">
        <button className="icon-btn nav-toggle" onClick={onToggleNav} aria-label="Toggle navigation">
          <Menu size={18} />
        </button>
        <div className="topbar-tenant-block">
          <TenantSwitcher />
          <span className="topbar-viewing" title="Current context">
            Viewing: <strong>{viewingLabel}</strong>
          </span>
        </div>
      </div>
      <div className="topbar-center">
        <div className="topbar-status-time">
          <span className={`topbar-live-badge ${isConnected ? "connected" : "disconnected"}`}>
            {isConnected ? "🟢 Connected" : "🔴 Disconnected"}
          </span>
          <span className="topbar-time" aria-label="Current time">
            {currentTime}
          </span>
        </div>
        <GlobalSearch />
      </div>
      <div className="topbar-right">
        <TopQuickActions />
        <FloatingDialer />
        <NotificationPanel />
        <ProfileMenu />
      </div>
    </header>
  );
}
