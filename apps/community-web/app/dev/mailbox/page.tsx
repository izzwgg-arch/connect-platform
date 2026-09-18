"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/components/ui";

/** Dev/test only: the mailbox the api writes to in COMMUNITY_MAIL_MODE=mailbox. The api refuses this route in production. */
export default function DevMailbox() {
  const [mail, setMail] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ mail: any[] }>("/dev/mailbox?limit=50", { auth: false })
      .then((r) => setMail(r.mail))
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="content narrow" style={{ margin: "0 auto" }}>
      <h1 style={{ fontSize: 20 }}>Dev mailbox</h1>
      <p className="dim sm">Every email and SMS the api would have sent. Only available when COMMUNITY_TEST_HOOKS=1.</p>
      {error ? <div className="chip bad">{error}</div> : null}
      {mail.map((m) => (
        <div key={m.id} className="card tight">
          <div className="row sm" style={{ justifyContent: "space-between" }}>
            <b>{m.channel === "sms" ? "SMS" : m.subject}</b>
            <span className="dim xs">{m.to} · {timeAgo(m.createdAt)} ago</span>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: "6px 0 0", fontSize: 13 }}>{m.text}</pre>
        </div>
      ))}
    </div>
  );
}
