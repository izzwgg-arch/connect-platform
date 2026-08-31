/**
 * Card-network acceptance marks, drawn as vectors.
 *
 * These replaced `<b>Visa</b>` styled with CSS, which read as unfinished right
 * where a customer decides whether to type a card number. Each mark sits on its
 * own white plate the way real acceptance marks do, so one set is legible on
 * both the light and the dark pay surface — no per-theme artwork to keep in sync.
 *
 * ⛔ Each mark is self-contained inline SVG on purpose: no shared <defs>, no
 * <use>, no clipPath ids. These render several times per page (the row above the
 * card field, the trust footer, and once more inside the field when the brand is
 * detected), and cross-referenced ids collide when a component is repeated.
 *
 * ⏳ These are faithful redraws. Each network publishes exact acceptance marks in
 * its brand centre; dropping those files in later is a swap of this one file.
 */

export type CardBrand = "visa" | "mastercard" | "amex" | "discover";

export const CARD_BRANDS: CardBrand[] = ["visa", "mastercard", "amex", "discover"];

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
};

/**
 * Which network a card number belongs to, from its leading digits.
 *
 * ⛔ This is only ever used to DECORATE — the brand mark shown beside the field
 * and whether the CVV label says three digits or four. The card number itself
 * lives in the processor's iframe and is never read here; this runs on the
 * `issuer` string Cardknox reports back through `onUpdate`, or on nothing at all.
 * Never let a payment decision depend on it.
 */
export function detectCardBrand(value: string | null | undefined): CardBrand | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "discover";
  return null;
}

/** Cardknox reports the issuer as a word ("visa", "amex", "mastercard"…). */
export function cardBrandFromIssuer(issuer: string | null | undefined): CardBrand | null {
  const raw = String(issuer ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("visa")) return "visa";
  if (raw.includes("master") || raw === "mc") return "mastercard";
  if (raw.includes("amex") || raw.includes("american")) return "amex";
  if (raw.includes("discover")) return "discover";
  return null;
}

/** Amex asks for a 4-digit code; everyone else asks for 3. */
export function cvvLengthForBrand(brand: CardBrand | null): 3 | 4 {
  return brand === "amex" ? 4 : 3;
}

export function CardBrandMark({
  brand,
  width = 34,
  className,
  title,
}: {
  brand: CardBrand;
  width?: number;
  className?: string;
  title?: string;
}) {
  const height = Math.round((width / 40) * 26);
  const common = {
    width,
    height,
    viewBox: "0 0 40 26",
    className,
    role: "img" as const,
    "aria-label": title ?? CARD_BRAND_LABELS[brand],
  };

  if (brand === "mastercard") {
    return (
      <svg {...common}>
        <rect x=".5" y=".5" width="39" height="25" rx="4" fill="#fff" stroke="#dfe4ec" />
        <circle cx="15.4" cy="13" r="6.6" fill="#EB001B" />
        <circle cx="24.6" cy="13" r="6.6" fill="#F79E1B" />
        {/* the overlap, as an explicit lens — a clipPath id would collide
            between the several copies of this mark on one page */}
        <path d="M20 8.267A6.6 6.6 0 0 1 20 17.733A6.6 6.6 0 0 1 20 8.267Z" fill="#FF5F00" />
      </svg>
    );
  }

  if (brand === "amex") {
    return (
      <svg {...common}>
        <rect x=".5" y=".5" width="39" height="25" rx="4" fill="#1F72CF" />
        <rect x="3.2" y="3.2" width="33.6" height="19.6" rx="2.4" fill="none" stroke="#fff" strokeOpacity=".55" />
        <text
          x="20"
          y="16.6"
          textAnchor="middle"
          fontFamily="Arial, Helvetica, sans-serif"
          fontSize="8.4"
          fontWeight="800"
          letterSpacing="1.1"
          fill="#fff"
        >
          AMEX
        </text>
      </svg>
    );
  }

  if (brand === "discover") {
    return (
      <svg {...common}>
        <rect x=".5" y=".5" width="39" height="25" rx="4" fill="#fff" stroke="#dfe4ec" />
        <circle cx="32.8" cy="13" r="5.9" fill="#F76B1C" />
        <text
          x="15.5"
          y="14.6"
          textAnchor="middle"
          fontFamily="Arial, Helvetica, sans-serif"
          fontSize="5.2"
          fontWeight="800"
          letterSpacing=".2"
          fill="#231F20"
        >
          DISCOVER
        </text>
        <rect x="5" y="17.2" width="21" height="1.3" rx=".65" fill="#F76B1C" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x=".5" y=".5" width="39" height="25" rx="4" fill="#fff" stroke="#dfe4ec" />
      <text
        x="20"
        y="17.6"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="12.4"
        fontWeight="800"
        fontStyle="italic"
        letterSpacing="-.2"
        fill="#1434CB"
      >
        VISA
      </text>
      <rect x="9" y="19.4" width="22" height="1.5" rx=".75" fill="#F7B600" />
    </svg>
  );
}

/** The "we accept" row. `active` dims the rest so the detected card stands out. */
export function CardBrandRow({
  active = null,
  width = 34,
  className,
}: {
  active?: CardBrand | null;
  width?: number;
  className?: string;
}) {
  return (
    <span
      className={["billing-pay-brand-row", active ? "is-detecting" : "", className].filter(Boolean).join(" ")}
      aria-label="Visa, Mastercard, American Express and Discover accepted"
    >
      {CARD_BRANDS.map((brand) => (
        <CardBrandMark
          key={brand}
          brand={brand}
          width={width}
          className={`billing-pay-brand-mark${active === brand ? " is-on" : ""}`}
        />
      ))}
    </span>
  );
}
