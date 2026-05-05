"use client";

import { AuthGate } from "../../../components/AuthGate";
import { DesktopMiniDialer } from "../../../components/DesktopMiniDialer";

export default function DesktopMiniDialerPage() {
  return (
    <AuthGate>
      <DesktopMiniDialer />
    </AuthGate>
  );
}
