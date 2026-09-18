"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Chip, Field, Icon, useToast } from "@/components/ui";

export default function AccountPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState(me?.person.email ?? "");
  const [phone, setPhone] = useState(me?.person.phone ?? "");
  const [pending, setPending] = useState<{ purpose: "email" | "phone"; target: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  async function send(purpose: "email" | "phone") {
    setBusy(true);
    try {
      const target = purpose === "email" ? email.trim() : phone.trim();
      const r = await api("/auth/verify/send", { body: { purpose, target } });
      setPending({ purpose, target: r.target });
      toast(`Code sent to ${r.target}.`);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      await api("/auth/verify/confirm", { body: { purpose: pending.purpose, target: pending.target, code } });
      toast(`${pending.purpose === "email" ? "Email" : "Phone"} verified.`);
      setPending(null);
      setCode("");
      await reload();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (!window.confirm("Unlink your Loopcom account? You keep your Loopcom ID; Call/SMS actions tied to your phone system stop showing.")) return;
    try {
      await api("/auth/link/loopcom", { method: "DELETE" });
      await reload();
      toast("Loopcom account unlinked.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }
  return (
    <>
      <div className="card">
        <div className="ct">Contact &amp; verification</div>
        <div className="grid2">
          <Field label="Email" htmlFor="ac-email" help={me.person.emailVerified ? "Verified" : "Not verified — verify to post, message and connect."}>
            <div className="row">
              <input id="ac-email" className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
              <Button small onClick={() => send("email")} loading={busy} data-testid="verify-email">{me.person.emailVerified && email === me.person.email ? "Re-send" : "Verify"}</Button>
            </div>
          </Field>
          <Field label="Mobile number" htmlFor="ac-phone" help={me.person.phoneVerified ? "Verified" : "Optional. Lets people who have your number find you."}>
            <div className="row">
              <input id="ac-phone" className="in" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ flex: 1 }} />
              <Button small onClick={() => send("phone")} loading={busy} data-testid="verify-phone">Verify</Button>
            </div>
          </Field>
        </div>
        {pending ? (
          <div className="row" style={{ marginTop: 12 }}>
            <input className="in" style={{ width: 160 }} inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Verification code" data-testid="verify-code" />
            <Button kind="p" onClick={confirm} loading={busy} data-testid="verify-confirm">Confirm</Button>
            <span className="xs dim">Sent to {pending.target}</span>
          </div>
        ) : null}
        <div className="pill-row" style={{ marginTop: 12 }}>
          <Chip kind={me.person.emailVerified ? "ok" : ""} icon={me.person.emailVerified ? "check" : undefined}>Email {me.person.emailVerified ? "verified" : "unverified"}</Chip>
          <Chip kind={me.person.phoneVerified ? "ok" : ""} icon={me.person.phoneVerified ? "check" : undefined}>Phone {me.person.phoneVerified ? "verified" : "unverified"}</Chip>
        </div>
      </div>
      <div className="card">
        <div className="ct">Linked accounts</div>
        <div className="list sm">
          <div className="li">
            <Icon name="link" />
            <div className="t">
              <b>Loopcom phone system</b>
              <small>{me.person.loopcomLinked ? "Linked — Call, Video, SMS and WhatsApp actions appear on your pages where entitled." : "Not linked. Sign in with Loopcom once to link, keeping this Loopcom ID."}</small>
            </div>
            {me.person.loopcomLinked ? <Button small kind="g" onClick={unlink}>Unlink</Button> : <Button small href="/sso/loopcom?next=/settings">Link</Button>}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="ct">Username</div>
        <p className="sm dim">Your public profile is <b>/people/{me.person.username}</b>. Change it from your profile page.</p>
      </div>
    </>
  );
}
