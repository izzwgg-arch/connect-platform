/** Mirror of packages/integrations/src/vitalpbx/inboundDidDigits.ts — keep in sync. */

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

export function normalizeInboundDidDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = digitsOnly(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length < 3) return null;
  return d;
}
