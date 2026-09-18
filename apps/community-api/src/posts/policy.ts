/**
 * Pure decisions for the posts domain. Routes fetch rows and call these —
 * never re-derive a comments/visibility/kind rule inline (CONVENTIONS §3).
 */

export type CommentsPolicy = "ANYONE" | "CONNECTIONS" | "NOBODY";
export type Degree = 0 | 1 | 2 | 3;

/** Author can always comment on their own post regardless of policy. */
export function canComment(policy: CommentsPolicy | string, ctx: { isAuthor: boolean; degree: Degree }): boolean {
  if (ctx.isAuthor) return true;
  if (policy === "NOBODY") return false;
  if (policy === "CONNECTIONS") return ctx.degree === 1;
  return true; // ANYONE (and any unknown value defaults open)
}

export type DerivedMediaKind = "IMAGE" | "GALLERY" | "VIDEO" | "DOCUMENT" | null;

/** 1 image → IMAGE, >1 → GALLERY, any video → VIDEO, any document (pdf) → DOCUMENT. */
export function deriveKindFromMedia(assets: Array<{ kind: string }>): DerivedMediaKind {
  if (!assets.length) return null;
  if (assets.some((a) => a.kind === "video")) return "VIDEO";
  if (assets.some((a) => a.kind === "document")) return "DOCUMENT";
  const images = assets.filter((a) => a.kind === "image");
  if (images.length > 1) return "GALLERY";
  if (images.length === 1) return "IMAGE";
  return null;
}

/** IPv4-literal + loopback/link-local/RFC1918 + localhost hostnames. Defense against SSRF via link previews. */
const PRIVATE_HOST_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^0$/,
  /^::1$/,
  /^\[::1\]$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(h));
}

/** Plain-English reaction kinds this domain accepts. */
export const REACTION_KINDS = ["LIKE", "INSIGHTFUL", "CELEBRATE", "SUPPORT"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** refType strings this domain knows how to resolve into an embed. Other domains create Post rows with these. */
export const REF_MODELS = ["Job", "Event", "Opportunity", "Rfq", "Listing", "Post"] as const;
