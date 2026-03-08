"use client";

import type { ReactNode } from "react";
import { AppProvider } from "../hooks/useAppContext";

export function Providers({ children }: { children: ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}
