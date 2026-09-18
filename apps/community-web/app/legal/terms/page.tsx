import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Terms of use" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="September 18, 2026">
      <h2>The service</h2>
      <p>Loopcom Community is a professional network run by Loopcom LLC. A Loopcom ID is free and does not require a Loopcom phone-system subscription. You must be at least 18 and represent yourself, your own business, or a business that has authorised you.</p>
      <h2>Your content</h2>
      <p>You own what you post. You give Loopcom the right to display it to the people your visibility settings allow. Don't post content you don't have the right to share, and don't impersonate people or businesses.</p>
      <h2>Requests for quotes, jobs, listings and opportunities</h2>
      <p>Quotes, applications and interest are messages between members; Loopcom is not a party to any resulting agreement and does not process payments between members. Accepting a quote closes the request to other vendors — it is a decision, not a contract, unless you and the vendor make one.</p>
      <h2>Conduct</h2>
      <ul>
        <li>No spam or mass solicitation. Outreach is rate-limited and explained; repeated abuse leads to restrictions, then suspension.</li>
        <li>No fake reviews, fake jobs, fake companies, phishing, scams or malware. Reports are reviewed by people, and every moderation action is logged and appealable.</li>
        <li>Respect group rules set by their owners.</li>
      </ul>
      <h2>Verification signals</h2>
      <p>Verification chips (phone, email, domain, business, employee, license, insurance, Loopcom customer, transaction) are independent signals about what was verified and when. They are not an endorsement and are never combined into a score.</p>
      <h2>Ending your account</h2>
      <p>You can deactivate or delete your account at any time from Settings. We may suspend or remove accounts that break these terms, with notice and a route to appeal.</p>
      <h2>Changes</h2>
      <p>When these terms change we'll say so here and, for material changes, tell you in the product before they apply.</p>
      <h2>Contact</h2>
      <p>Loopcom LLC · community@loopcom.net</p>
    </LegalPage>
  );
}
