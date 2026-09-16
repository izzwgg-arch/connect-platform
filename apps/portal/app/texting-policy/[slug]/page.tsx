import { LoginThemeToggle } from "../../../components/LoginThemeToggle";
import "../../texting-registration/[token]/texting-registration.css";

/**
 * A business's public texting privacy policy and terms (2026-09-16).
 *
 * Carriers review this page when they check a 10DLC registration, so it is
 * written in the BUSINESS's legal name (the registry wants the brand's own
 * policy) and ⛔ RENDERED ON THE SERVER: a reviewer's tool that reads raw HTML
 * must see the policy text, not a loading spinner. Public on purpose — the
 * slug is not a secret. `#terms` jumps to the terms.
 * ⛔ No carrier name on this page (source-guarded).
 */

export const revalidate = 300;

type Doc = { title: string; paragraphs: string[] };
type Policy = { displayName: string; legalName: string; privacy: Doc; terms: Doc };

function apiBase(): string {
  return String(process.env.PORTAL_API_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
}

async function loadPolicy(slug: string): Promise<Policy | null> {
  try {
    const r = await fetch(`${apiBase()}/texting-registration/policy/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const body = await r.json();
    return body?.privacy ? (body as Policy) : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const policy = await loadPolicy(String(params?.slug ?? ""));
  return { title: policy ? `${policy.legalName} — Texting Privacy Policy` : "Texting Privacy Policy" };
}

export default async function TextingPolicyPage({ params }: { params: { slug: string } }) {
  const policy = await loadPolicy(String(params?.slug ?? ""));
  return (
    <main className="lc-login tr-page">
      <LoginThemeToggle />
      <article className="tr-card tp-doc">
        {!policy ? (
          <div className="tr-center">
            <h1>Policy not found</h1>
            <p className="tr-lede">This page doesn&apos;t exist or is no longer published.</p>
          </div>
        ) : (
          <>
            <h1>{policy.legalName}</h1>
            <p className="tp-meta">Text messaging privacy policy and terms</p>
            <h2 id="privacy">Privacy policy</h2>
            {policy.privacy.paragraphs.map((p, i) => (
              <p key={`p${i}`}>{p}</p>
            ))}
            <h2 id="terms">Text messaging terms</h2>
            {policy.terms.paragraphs.map((p, i) => (
              <p key={`t${i}`}>{p}</p>
            ))}
          </>
        )}
      </article>
    </main>
  );
}
