"use client";
/**
 * The desktop app's Coworker popover — what the floating bubble opens.
 *
 * ⛔ This is the SAME assistant every portal page carries in its corner
 * (FloatingAssistant), docked to fill this small frameless window. It is not a
 * second chatbot, and it is deliberately NOT `/assistant`: that page is the
 * SUPER_ADMIN owner console (provider self-tests, model picker, capability list)
 * inside the full sidebar shell, which is what the first bubble tried to open in a
 * 400px popover.
 *
 * ⛔ It lives under /desktop/ on purpose. The portal treats a desktop window whose
 * kind is not "full" as PASSIVE: AuthGate waits for the main window's token instead
 * of bouncing to /login, sessionExpiry never redirects it, and useSipPhone runs it
 * as a proxy so this popover can never register a second SIP phone.
 */
import { AuthGate } from "../../../components/AuthGate";
import { FloatingAssistant } from "../../../components/FloatingAssistant";

export default function DesktopCoworkerPage() {
  return (
    <AuthGate>
      <FloatingAssistant docked />
    </AuthGate>
  );
}
