/** Default local portal login — kept in sync with `pnpm bootstrap:local`. */
export const LOCAL_DEV_EMAIL = "imwog@gmail.com";
export const LOCAL_DEV_PASSWORD = "LocalDev2026!";

export function resolveLocalDevEmail(envEmail?: string | null): string {
  return (envEmail || process.env.LOCAL_DEV_EMAIL || LOCAL_DEV_EMAIL).trim().toLowerCase();
}

export function resolveLocalDevPassword(envPassword?: string | null): string {
  return envPassword || process.env.LOCAL_DEV_PASSWORD || LOCAL_DEV_PASSWORD;
}

/** True when the browser host is a loopback dev origin (portal quick sign-in, CRM hints). */
export function isLocalhostDevHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host.trim());
}
