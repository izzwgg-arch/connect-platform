import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Help" };

export default function HelpPage() {
  return (
    <LegalPage title="Help" updated="September 18, 2026">
      <h2>Getting in</h2>
      <ul>
        <li><b>Loopcom phone-system customer?</b> Use <Link href="/sso/loopcom">Sign in with Loopcom</Link> — same login, no second password. Your company page can be claimed from Company admin.</li>
        <li><b>Everyone else:</b> <Link href="/join">create a free Loopcom ID</Link>, verify your email or mobile number, and you're in.</li>
        <li>Forgot your password? <Link href="/forgot-password">Reset it</Link>. Turn on two-step verification or add a passkey in Settings → Security.</li>
      </ul>
      <h2>Finding vendors and customers</h2>
      <ul>
        <li><b>Search</b> understands plain English (“security-camera installer serving nursing homes in Brooklyn”) and tells you why each result matched.</li>
        <li><b>Request quotes</b> from the RFQs page: describe what you need, confirm the fields we pulled out, and matching vendors are notified. Compare, ask questions, shortlist, accept.</li>
        <li><b>Concierge</b> does the search for you and proposes next steps — nothing is sent until you confirm.</li>
      </ul>
      <h2>Privacy</h2>
      <p>Every profile section has its own visibility in Settings → Privacy. Blocking someone hides you from them completely and they are not told. Your private notes are only ever yours.</p>
      <h2>Reporting a problem</h2>
      <p>Every post, message, profile, company, job, listing, request and event has a Report option in its menu. Reports go to a moderation queue reviewed by people; you'll see the outcome under Settings → Notices if it concerns you.</p>
      <h2>Contact</h2>
      <p>community@loopcom.net</p>
    </LegalPage>
  );
}
