"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { applySession, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui";

declare global {
  interface Window {
    google?: any;
    AppleID?: any;
  }
}

/**
 * Google Identity Services + Sign in with Apple JS. Each hands us an id_token;
 * the api verifies it. Buttons only render when the client id is configured,
 * so nothing decorative ever ships.
 */
export function OAuthButtons({ mode, next, onError }: { mode: "login" | "join"; next: string; onError: (m: string) => void }) {
  const router = useRouter();
  const { reload } = useAuth();
  const googleId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
  const appleId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID || "";
  const googleDiv = useRef<HTMLDivElement>(null);
  const [appleReady, setAppleReady] = useState(false);

  async function finish(provider: "google" | "apple", idToken: string, extra: Record<string, unknown> = {}) {
    try {
      const body = await api(`/auth/oauth/${provider}`, { body: { idToken, ...extra }, auth: false });
      applySession(body);
      const m = await reload();
      router.replace(body.created || (m && !m.person.onboardingDone) ? "/welcome" : next);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  useEffect(() => {
    if (!googleId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      window.google?.accounts.id.initialize({ client_id: googleId, callback: (r: { credential: string }) => void finish("google", r.credential) });
      if (googleDiv.current) window.google?.accounts.id.renderButton(googleDiv.current, { theme: "outline", size: "large", width: 380, text: mode === "join" ? "signup_with" : "signin_with" });
    };
    document.head.appendChild(s);
    return () => { s.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleId]);

  useEffect(() => {
    if (!appleId) return;
    const s = document.createElement("script");
    s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
    s.async = true;
    s.onload = () => {
      window.AppleID?.auth.init({ clientId: appleId, scope: "name email", redirectURI: `${window.location.origin}/login`, usePopup: true });
      setAppleReady(true);
    };
    document.head.appendChild(s);
    return () => { s.remove(); };
  }, [appleId]);

  async function apple() {
    try {
      const res = await window.AppleID.auth.signIn();
      const name = res?.user?.name;
      await finish("apple", res.authorization.id_token, { firstName: name?.firstName, lastName: name?.lastName });
    } catch (err: any) {
      if (err?.error !== "popup_closed_by_user") onError("Apple sign-in didn't complete.");
    }
  }

  if (!googleId && !appleId) return <p className="xs dim" style={{ textAlign: "center" }}>Google and Apple sign-in appear here once their client ids are configured.</p>;
  return (
    <div className="row" style={{ justifyContent: "center", flexDirection: "column", alignItems: "stretch" }}>
      {googleId ? <div ref={googleDiv} style={{ display: "grid", justifyContent: "center" }} /> : null}
      {appleId ? (
        <Button wide onClick={apple} disabled={!appleReady}>
           Continue with Apple
        </Button>
      ) : null}
    </div>
  );
}
