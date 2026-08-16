"use client";

import { Menu } from "lucide-react";
import { LanguageToggle } from "../hooks/useUiLanguage";
import { LoopComLogo } from "./LoopComLogo";
import { FloatingDialer } from "./FloatingDialer";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationPanel } from "./NotificationPanel";
import { ProfileMenu } from "./ProfileMenu";
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
        {/* No text beside it: the wordmark says LoopCom itself, and the old
            "Connect" span existed only as a light-mode fallback for a logo that
            could not render on a light background. */}
        <LoopComLogo className="brand-logo-svg" />
      </div>

      <div className="topbar-center">
        <GlobalSearch />
      </div>

      <div className="topbar-right">
        {/* Renders nothing unless this customer was set up for Yiddish AND
            this person may use it — so it costs nothing on every other
            account, but is present on every screen for those who need it. */}
        <LanguageToggle />
        <QRPairingModal />
        <FloatingDialer />
        <NotificationPanel />
        <ProfileMenu />
      </div>
    </header>
  );
}
