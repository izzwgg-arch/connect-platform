"use client";

import type { ReactNode } from "react";
import { AppProvider } from "../hooks/useAppContext";
import { TelephonyProvider } from "../contexts/TelephonyContext";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <TelephonyProvider>{children}</TelephonyProvider>
    </AppProvider>
  );
}
