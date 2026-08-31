import Image from "next/image";
import { Lock } from "lucide-react";

/**
 * The band at the top of the payment card: the Loopcom wordmark and a
 * "secure payment" chip.
 *
 * ⛔ The wordmark belongs INSIDE the card, not floating above it (Izzy,
 * 2026-08-31). It lives in one component so the four payment surfaces cannot
 * drift — the two pay-token pages, the short pay-link page and add-card.
 *
 * ⛔ One transparent PNG serves both themes on purpose; it is the same file the
 * login page ships. Do not add a per-theme variant or a filter — see the
 * rebrand section of CLAUDE.md.
 */
export function PayCardTop({ label = "Secure payment" }: { label?: string }) {
  return (
    <div className="billing-pay-cardtop">
      <span className="billing-pay-wordmark" aria-label="Loopcom">
        <Image
          src="/brand/loopcom/loopcom-wordmark-560.png"
          alt="Loopcom"
          width={560}
          height={99}
          priority
        />
      </span>
      <span className="billing-pay-securechip">
        <Lock size={11} aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}
