"use client";

import type { ReactNode } from "react";
import { DesktopNotificationsBridge } from "../components/DesktopNotificationsBridge";
import { AppProvider } from "../hooks/useAppContext";
import { TelephonyProvider } from "../contexts/TelephonyContext";
import { SipPhoneProvider } from "../hooks/useSipPhone";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <TelephonyProvider>
        <SipPhoneProvider>
          <DesktopNotificationsBridge />
          {children}
        </SipPhoneProvider>
      </TelephonyProvider>
    </AppProvider>
  );
}
