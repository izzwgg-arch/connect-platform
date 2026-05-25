export default function OnboardingSuccessPage() {
  return (
    <div className="ob-success-wrap">

      {/* System-online icon */}
      <div className="ob-success-icon">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
          <circle cx="18" cy="18" r="10" stroke="#059669" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.4"/>
          <circle cx="18" cy="18" r="6" fill="rgba(5,150,105,0.12)" stroke="#059669" strokeWidth="1.5"/>
          <circle cx="18" cy="18" r="2.5" fill="#059669"/>
          <line x1="18" y1="4"  x2="18" y2="8"  stroke="#059669" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="18" y1="28" x2="18" y2="32" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="4"  y1="18" x2="8"  y2="18" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="28" y1="18" x2="32" y2="18" stroke="#059669" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          <line x1="8.1"  y1="8.1"  x2="10.9" y2="10.9" stroke="#059669" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
          <line x1="25.1" y1="8.1"  x2="27.9" y2="10.9" stroke="#059669" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
          <line x1="8.1"  y1="27.9" x2="10.9" y2="25.1" stroke="#059669" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
          <line x1="25.1" y1="27.9" x2="27.9" y2="25.1" stroke="#059669" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
        </svg>
      </div>

      <h1 className="ob-success-title">Setup request received</h1>
      <p className="ob-success-sub">
        Your information has been submitted. Our team is now preparing your phone system and will be in touch shortly.
      </p>

      {/* What happens next */}
      <div className="ob-success-steps">
        <div className="ob-success-step">
          <div className="ob-success-step-num">1</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">Account review</div>
            <div className="ob-success-step-desc">We verify your details and confirm your setup plan.</div>
          </div>
        </div>
        <div className="ob-success-step">
          <div className="ob-success-step-num">2</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">PBX provisioning</div>
            <div className="ob-success-step-desc">Your extensions and phone system are configured on our platform.</div>
          </div>
        </div>
        <div className="ob-success-step">
          <div className="ob-success-step-num">3</div>
          <div className="ob-success-step-text">
            <div className="ob-success-step-label">You&rsquo;re live</div>
            <div className="ob-success-step-desc">You&rsquo;ll receive login credentials and a welcome call from your account manager.</div>
          </div>
        </div>
      </div>

      <p className="ob-success-note">
        Questions? Reply to your onboarding email or reach us at{" "}
        <a href="mailto:support@connectcomunications.com" style={{ color: "#2563eb", textDecoration: "none" }}>
          support@connectcomunications.com
        </a>
      </p>
    </div>
  );
}
