import Link from "next/link";
import type { ReactNode } from "react";

/** Plain document layout for terms / privacy / help — readable signed out, both themes. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span className="dim" style={{ fontWeight: 600, letterSpacing: ".12em", textTransform: "uppercase", fontSize: 12, borderLeft: "1px solid var(--border)", paddingLeft: 12 }}>Community</span>
        <span style={{ flex: 1 }} />
        <Link href="/login" className="btn">Sign in</Link>
        <Link href="/join" className="btn p">Join free</Link>
      </nav>
      <article className="content" style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px 64px" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>{title}</h1>
        <p className="dim sm">Last updated {updated}</p>
        <div className="legal">{children}</div>
      </article>
      <footer>
        <span>© {new Date().getFullYear()} Loopcom LLC</span>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/help">Help</Link>
      </footer>
      <style>{`.legal h2{font-size:17px;margin-top:22px}.legal p,.legal li{font-size:14.5px;line-height:1.6;max-width:70ch}.legal ul{padding-left:20px}`}</style>
    </div>
  );
}
