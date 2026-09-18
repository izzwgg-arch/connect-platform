"use client";

import { useAuth } from "@/lib/auth";
import { Landing } from "@/components/landing/Landing";
import { AppShell } from "@/components/shell/AppShell";
import { FeedHome } from "@/components/feed/FeedHome";

/** Signed out → the public landing. Signed in → the home feed. */
export default function HomePage() {
  const { me, loading } = useAuth();
  if (loading) return <div className="auth"><div className="skel" style={{ width: 320, height: 24 }} /></div>;
  if (!me) return <Landing />;
  return (
    <AppShell cols="two" title="Home">
      <FeedHome />
    </AppShell>
  );
}
