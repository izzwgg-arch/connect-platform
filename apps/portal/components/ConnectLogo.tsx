export function ConnectLogo({ className }: { className?: string }) {
  return (
    <img
      src="/connect-logo.svg"
      alt="Connect Communications"
      className={className}
      width={245}
      height={56}
      decoding="async"
    />
  );
}
