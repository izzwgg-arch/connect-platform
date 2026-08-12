"use client";

import type { ReactNode } from "react";
import { DesktopNotificationsBridge } from "../components/DesktopNotificationsBridge";
import { PortalReloadNotice } from "../components/DesktopUpdateNotice";
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
          {children}
        </SipPhoneProvider>
      </TelephonyProvider>
    </AppProvider>
  );
}
