export default function OnboardingSuccessPage() {
  return (
    <div className="ob-success-wrap">
      {/* System-building icon */}
      <div className="ob-success-icon">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor">
          <circle cx="18" cy="18" r="10" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.4"/>
          <circle cx="18" cy="18" r="6" fill="currentColor" fillOpacity="0.12" strokeWidth="1.5"/>
          <circle cx="18" cy="18" r="2.5" fill="currentColor" stroke="none"/>
          <line x1="18" y1="4"  x2="18" y2="8"  strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="18" y1="28" x2="18" y2="32" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="4"  y1="18" x2="8"  y2="18" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="28" y1="18" x2="32" y2="18" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
        </svg>
      </div>

      <h1 className="ob-success-title">Your phone system is being built</h1>
      <p className="ob-success-sub">
        Please give us a few minutes while we set everything up. You can safely close this window —
        we&rsquo;ll email everyone on your team their login details the moment it&rsquo;s all ready.
      </p>

      {/* What's happening now */}
      <div className="ob-success-steps">
        <div className="ob-success-step">
          <div className="ob-success-step-num">1</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">Your number</div>
            <div className="ob-success-step-desc">We activate your new number, or begin your transfer if you&rsquo;re porting one in.</div>
          </div>
        </div>
        <div className="ob-success-step">
          <div className="ob-success-step-num">2</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">Your phone system</div>
            <div className="ob-success-step-desc">Your account and every extension are created and wired up automatically.</div>
          </div>
        </div>
        <div className="ob-success-step">
          <div className="ob-success-step-num">3</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">You&rsquo;re live</div>
            <div className="ob-success-step-desc">Login details land in your inbox and you can start making calls right away.</div>
          </div>
        </div>
      </div>

      <p className="ob-success-note">
        Questions? Reply to your onboarding email or reach us at{" "}
        <a href="mailto:support@connectcomunications.com">support@connectcomunications.com</a>
      </p>
    </div>
  );
}
