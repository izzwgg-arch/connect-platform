import type { ReactNode } from "react";
import { AuthGate } from "../../components/AuthGate";
import { AppShell } from "../../layout/AppShell";
import { UiLanguageProvider } from "../../hooks/useUiLanguage";

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      {/* Wraps every signed-in screen so any of them can offer Yiddish. The
          provider costs nothing until a screen asks for it: it makes one
          /me/language call, and never fetches a translation unless the person
          has actually switched to Yiddish. */}
      <UiLanguageProvider>
        <AppShell>{children}</AppShell>
      </UiLanguageProvider>
    </AuthGate>
  );
}
