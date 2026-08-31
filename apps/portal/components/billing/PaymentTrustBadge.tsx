import { ShieldCheck } from "lucide-react";
import { SolaLogo, type SolaLogoTheme } from "./SolaLogo";
import { CardBrandRow } from "./CardBrandMarks";

type PaymentTrustBadgeProps = {
  theme?: SolaLogoTheme;
};

export function PaymentTrustBadge({ theme = "light" }: PaymentTrustBadgeProps) {
  return (
    <footer className="billing-pay-trust-badge" aria-label="Payment security and accepted payment methods">
      <div className="billing-pay-trust-panel billing-pay-trust-panel--brand">
        <span className="billing-pay-trust-label">Secured &amp; powered by</span>
        <SolaLogo theme={theme} className="billing-pay-sola-logo" />
      </div>

      <div className="billing-pay-trust-panel billing-pay-trust-panel--security">
        <span className="billing-pay-trust-label">Encrypted</span>
        <strong>256-bit TLS</strong>
        <span className="billing-pay-trust-sub">
          <ShieldCheck size={13} aria-hidden="true" /> PCI DSS Level 1
        </span>
      </div>

      <div className="billing-pay-trust-panel billing-pay-trust-panel--brands">
        <span className="billing-pay-trust-label">We accept</span>
        <CardBrandRow />
      </div>
    </footer>
  );
}
