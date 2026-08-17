/**
 * Loopcom brand lockup.
 *
 * The full-colour rendition is used on both themes — measured against white it holds
 * 10.3:1 on the wordmark and 4.9:1 on the tagline, so the gradient survives a light
 * ground without needing a flattened deep-ink variant. Deep ink is still used for
 * printed/emailed documents (invoice PDF, billing email header), where the brand pack
 * specifies ink on white paper.
 */
export function ConnectLogo({ className }: { className?: string }) {
  return (
    <img
      src="/loopcom-logo.png"
      alt="Loopcom"
      className={["brand-logo-img", className].filter(Boolean).join(" ")}
      width={181}
      height={40}
      decoding="async"
    />
  );
}
