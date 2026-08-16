import { CreditCard, ShieldCheck } from "lucide-react";
import { SolaLogo, type SolaLogoTheme } from "./SolaLogo";

type PaymentTrustBadgeProps = {
  theme?: SolaLogoTheme;
};

export function PaymentTrustBadge({ theme = "light" }: PaymentTrustBadgeProps) {
  return (
    <footer className="billing-pay-trust-badge" aria-label="Payment security and accepted payment methods">
      <div className="billing-pay-trust-panel billing-pay-trust-panel--brand">
        <span>Secured &amp; powered by</span>
        <SolaLogo theme={theme} className="billing-pay-sola-logo" />
      </div>

      <div className="billing-pay-trust-panel billing-pay-trust-panel--security">
        <span className="billing-pay-trust-icon" aria-hidden="true">
          <ShieldCheck size={22} />
        </span>
        <div>
          <strong>Secure payment</strong>
          <span>256-bit SSL encryption</span>
        </div>
      </div>

      <div className="billing-pay-trust-panel billing-pay-trust-panel--brands">
        <div className="billing-pay-trust-title">
          <CreditCard size={17} aria-hidden="true" />
          <span>We accept</span>
        </div>
        <div className="billing-pay-card-brands" aria-label="Visa, Mastercard, Amex and Discover accepted">
          <b className="brand-visa">Visa</b>
          <b className="brand-mastercard">Mastercard</b>
          <b className="brand-amex">Amex</b>
          <b className="brand-discover">Discover</b>
        </div>
      </div>
    </footer>
  );
}
