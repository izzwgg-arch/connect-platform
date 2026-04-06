"use client";

import { Menu } from "lucide-react";
import { FloatingDialer } from "./FloatingDialer";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import { ProfileMenu } from "./ProfileMenu";
import { TopQuickActions } from "./TopQuickActions";
import { QRPairingModal } from "./QRPairingModal";

type TopbarProps = {
  title?: string;
  onToggleNav: () => void;
};

export function Topbar({ onToggleNav }: TopbarProps) {
  return (
    <header className="topbar topbar-2026">
      <div className="topbar-brand">
        <button
          className="icon-btn nav-toggle"
          onClick={onToggleNav}
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <div className="brand-logo">
          <span className="brand-name">Connect</span>
        </div>
      </div>

      <div className="topbar-center">
        <GlobalSearch />
      </div>

      <div className="topbar-right">
        <TopQuickActions />
        <QRPairingModal />
        <FloatingDialer />
        <NotificationPanel />
        <ProfileMenu />
      </div>
    </header>
  );
}
