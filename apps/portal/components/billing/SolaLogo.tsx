export type SolaLogoTheme = "light" | "dark";

const SOLA_LOGO = "/assets/vendor/sola/sola-logo.svg";

export function SolaLogo({
  theme = "light",
  className,
  priority = false,
}: {
  theme?: SolaLogoTheme;
  className?: string;
  priority?: boolean;
}) {
  return (
    <img
      src={SOLA_LOGO}
      alt="Sola Payments"
      width={220}
      height={60}
      className={className}
      data-logo-theme={theme}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
    />
  );
}
