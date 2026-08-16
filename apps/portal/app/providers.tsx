"use client";

import type { ReactNode } from "react";
import { DesktopNotificationsBridge } from "../components/DesktopNotificationsBridge";
import { PortalReloadNotice } from "../components/DesktopUpdateNotice";
import RemoteSupportConsent from "../components/RemoteSupportConsent";
import { AppProvider } from "../hooks/useAppContext";
import { TelephonyProvider } from "../contexts/TelephonyContext";
import { SipPhoneProvider } from "../hooks/useSipPhone";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <TelephonyProvider>
        <SipPhoneProvider>
          <DesktopNotificationsBridge />
          <PortalReloadNotice />
          {/* ⛔ Mounted globally on purpose. A request to view someone's screen
              must reach them wherever they are in the app — if this lived on
              one page, a customer sitting on any other screen would never see
              that they had been asked, and the request would silently expire. */}
          <RemoteSupportConsent />
          {children}
        </SipPhoneProvider>
      </TelephonyProvider>
    </AppProvider>
  );
}
