import type { ReactNode } from "react";
import { AppShell } from "../../layout/AppShell";

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
