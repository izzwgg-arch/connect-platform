import type { ReactNode } from "react";
import { AuthGate } from "../../components/AuthGate";
import { AppShell } from "../../layout/AppShell";

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
