"use client";
/**
 * The desktop app's Coworker popover — what the floating bubble opens.
 *
 * 2026-09-15 (Izzy approved the IDE-style mockup): the bubble opens the Coworker
 * WORKSPACE in its compact form — a live chat that shows every step while it
 * works, asks questions back, takes voice, files, folders and code projects, and
 * opens the same task in the full page. It is the same session hook as the full
 * page (/coworker), not a second chatbot, and deliberately NOT `/assistant` (the
 * SUPER_ADMIN owner console).
 *
 * ⛔ It lives under /desktop/ on purpose. The portal treats a desktop window whose
 * kind is not "full" as PASSIVE: AuthGate waits for the main window's token instead
 * of bouncing to /login, sessionExpiry never redirects it, and useSipPhone runs it
 * as a proxy so this popover can never register a second SIP phone.
 */
import { AuthGate } from "../../../components/AuthGate";
import { UiLanguageProvider } from "../../../hooks/useUiLanguage";
import { CoworkerPopover } from "../../../components/coworker/CoworkerPopover";

export default function DesktopCoworkerPage() {
  return (
    <AuthGate>
      <UiLanguageProvider>
        <CoworkerPopover />
      </UiLanguageProvider>
    </AuthGate>
  );
}
