"use client";

import { AuthGate } from "../../../components/AuthGate";
import { useSipPhone } from "../../../hooks/useSipPhone";

function PhoneEngineInner() {
  const phone = useSipPhone();
  return (
    <main style={{ minHeight: "100vh", background: "#07111f", color: "#dbeafe", padding: 24 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>Connect Phone Engine</h1>
      <p style={{ color: "#94a3b8", marginTop: 8 }}>
        Registration: {phone.regState} · Call: {phone.callState}
      </p>
    </main>
  );
}

export default function DesktopPhoneEnginePage() {
  return (
    <AuthGate>
      <PhoneEngineInner />
    </AuthGate>
  );
}
