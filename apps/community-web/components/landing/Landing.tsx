"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Chip, Icon, VChip, fmtMoney } from "@/components/ui";

type PublicRfq = { id: string; title: string; category: string | null; location: string | null; budgetMin: string | null; budgetMax: string | null; quoteCount: number; closesAt: string | null };
type Stats = { people: number; organizations: number; openRfqs: number; jobs: number };

/** The public front door. Every control leads somewhere real. */
export function Landing() {
  const { theme, toggle } = useTheme();
  const [rfq, setRfq] = useState<PublicRfq | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    api<{ rfqs: PublicRfq[] }>("/public/rfqs?limit=1", { auth: false }).then((r) => setRfq(r.rfqs[0] ?? null)).catch(() => {});
    api<Stats>("/public/stats", { auth: false }).then(setStats).catch(() => {});
  }, []);
  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span className="dim" style={{ fontWeight: 600, letterSpacing: ".12em", textTransform: "uppercase", fontSize: 12, borderLeft: "1px solid var(--border)", paddingLeft: 12 }}>
          Community
        </span>
        <span style={{ flex: 1 }} />
        <Link className="lnk" href="/search?type=organizations">Find a business</Link>
        <Link className="lnk" href="/jobs">Jobs</Link>
        <Link className="lnk" href="/rfq">Get quotes</Link>
        <Link className="lnk" href="/events">Events</Link>
        <button type="button" className="ib" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
        <Link href="/login" className="btn" data-testid="landing-signin">Sign in</Link>
        <Link href="/join" className="btn p" data-testid="landing-join">Join free</Link>
      </nav>
      <section className="hero">
        <div>
          <h1>
            The professional network built for <em>how our businesses actually work.</em>
          </h1>
          <p>Find the vendor three people you trust already use. Post what you need and get real quotes. Hire from inside the community. Free to join — no Loopcom phone service required.</p>
          <div className="row" style={{ marginTop: 22 }}>
            <Link href="/join" className="btn p">
              Create your Loopcom ID <Icon name="arrow" />
            </Link>
            <Link href="/sso/loopcom" className="btn g">Already a Loopcom customer? Sign in with Loopcom</Link>
          </div>
          <div className="row xs dim" style={{ marginTop: 16 }}>
            <VChip>Verified businesses</VChip>
            <Chip kind="ac">No ads</Chip>
            <Chip>Your data, exportable any time</Chip>
            {stats ? <Chip>{stats.people.toLocaleString()} members · {stats.organizations.toLocaleString()} businesses</Chip> : null}
          </div>
        </div>
        <div className="card hair">
          {rfq ? (
            <div className="embed">
              <span className="k">Request for quote{rfq.closesAt ? ` · open until ${new Date(rfq.closesAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>
              <b>{rfq.title}</b>
              <div className="row xs dim">
                {rfq.category ? <span><Icon name="tag" /> {rfq.category}</span> : null}
                {rfq.location ? <span><Icon name="pin" /> {rfq.location}</span> : null}
                {rfq.budgetMin || rfq.budgetMax ? <span><Icon name="wallet" /> {rfq.budgetMin ? fmtMoney(rfq.budgetMin) : ""}{rfq.budgetMin && rfq.budgetMax ? "–" : ""}{rfq.budgetMax ? fmtMoney(rfq.budgetMax) : ""}</span> : null}
                <span><Icon name="quote" /> {rfq.quoteCount} quote{rfq.quoteCount === 1 ? "" : "s"} so far</span>
              </div>
              <div className="row">
                <Link href={`/rfq/${rfq.id}`} className="btn p s"><Icon name="quote" /> View &amp; quote</Link>
                <Link href="/rfq" className="btn s">More requests</Link>
              </div>
            </div>
          ) : (
            <div className="embed">
              <span className="k">Request for quote</span>
              <b>Describe what you need in plain English — matching vendors are notified and you compare real quotes in one place.</b>
              <div className="row"><Link href="/join" className="btn p s">Post your first request</Link></div>
            </div>
          )}
          <div className="sm dim" style={{ marginTop: 8 }}>A real request, as vendors see it.</div>
        </div>
      </section>
      <section className="pillars">
        <div className="card"><div className="pic"><Icon name="people" /></div><h3>Find who your network already trusts</h3><p>“3 people you know have bought from this company” beats a star rating. Relationships are the signal, and private ones stay private.</p></div>
        <div className="card"><div className="pic"><Icon name="quote" /></div><h3>Post an RFQ, compare real quotes</h3><p>Describe what you need in plain English. Matching vendors are notified; you compare, ask, shortlist and accept — in one place.</p></div>
        <div className="card"><div className="pic"><Icon name="brief" /></div><h3>Hire and get hired inside the community</h3><p>Jobs with a pipeline for employers and one-tap applications for candidates. Recruiters see verified affiliations, not guesses.</p></div>
      </section>
      <footer>
        <span>© {new Date().getFullYear()} Loopcom LLC</span>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/help">Help</Link>
        <a href="https://app.loopcom.net" target="_blank" rel="noreferrer">Loopcom phone systems ↗</a>
      </footer>
    </div>
  );
}
