import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Privacy policy" };

/**
 * Written to match what the product actually does (see docs/community/THREAT_MODEL.md
 * and the privacy controls in Settings). Change the code → change this page.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="September 18, 2026">
      <h2>What we collect</h2>
      <p>What you type into your profile, posts, messages, requests for quotes and company pages; your email and, if you add it, your mobile number; the device and browser you sign in from; and usage events (which pages and posts you open, what you search for) so the product can show you relevant things and so we can fix what breaks.</p>
      <h2>What we never do</h2>
      <ul>
        <li>We never infer religion, health, political views, sexuality or any other sensitive characteristic from your behaviour. Community affiliation and similar information appear only where you chose to write them.</li>
        <li>We never sell your data, and we never show ads based on it.</li>
        <li>We never read your private notes, and we never show one person's private relationship labels to another. Only labels both sides have set appear as “verified customer” signals.</li>
      </ul>
      <h2>Who can see what</h2>
      <p>Every section of your profile has a visibility setting (public, connections, my company, only me) in Settings → Privacy. Blocked people cannot see your profile at all and are not told they are blocked. Read receipts and online status are shared only when both people allow it.</p>
      <h2>Loopcom phone-system customers</h2>
      <p>If you sign in with Loopcom or link your Loopcom account, we store only your Loopcom user id and company id so you don't need a second login and so calling/texting buttons can appear where both sides are Loopcom customers. Your phone-system data stays in your phone system.</p>
      <h2>Your data</h2>
      <p>Settings → Your data lets you export everything as one file, deactivate your profile, or delete your account. Deletion takes effect after 14 days (so an accidental request can be cancelled by signing in), after which your identity is removed and anything you sent to other people is attributed to “Deleted member”.</p>
      <h2>Security</h2>
      <p>Passwords are hashed with argon2id. Sign-ins from a new device are announced to you. Two-step verification and passkeys are available in Settings → Security. Every administrative action on your account is written to an audit log you can ask us about.</p>
      <h2>Contact</h2>
      <p>Loopcom LLC · community@loopcom.net</p>
    </LegalPage>
  );
}
