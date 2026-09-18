"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Dialog, Icon, useToast } from "@/components/ui";

type Match = { type: string; id: string; rank: number; why: string; item: any };
type Action = { token: string; kind: "post_rfq" | "message_org" | "follow_org"; label: string; needsConfirmation: true };
type Answer = { intent: { kind: string; service: string | null; customerType: string | null; location: string | null; summary: string; source: "ai" | "rules" }; explanation: string; matches: Match[]; actions: Action[]; disclaimer: string };
type Turn = { id: number; question: string; answer?: Answer; error?: string; done?: { done: string; href: string } };

const EXAMPLES = [
  "I need a packaging company within 50 miles that can manufacture 5,000 boxes next month",
  "Commercial security-camera installer serving nursing homes in Brooklyn",
  "Who hires bookkeepers in Monsey?",
  "Embroidery shop that can do 25 jackets by October 20, delivered to Monroe",
];

function hrefFor(m: Match): string {
  switch (m.type) {
    case "organizations": return `/companies/${m.item.slug}`;
    case "people": return `/people/${m.item.username}`;
    case "jobs": return `/jobs/${m.id}`;
    case "listings": return `/marketplace/${m.id}`;
    case "events": return `/events/${m.item.slug ?? m.id}`;
    case "groups": return `/groups/${m.item.slug ?? m.id}`;
    default: return "#";
  }
}
function titleFor(m: Match): string {
  return m.item.displayName ?? m.item.name ?? m.item.title ?? m.item.username ?? "Result";
}

export default function ConciergePage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ai: boolean; mode: string } | null>(null);
  const [confirm, setConfirm] = useState<{ turn: Turn; action: Action } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api<{ ai: boolean; mode: string }>("/concierge/status").then(setStatus).catch(() => {});
  }, []);
  useEffect(() => {
    // Implicit-return arrow (`() => x.scrollIntoView(...)`) hands whatever
    // scrollIntoView returns back to React as the effect's cleanup function;
    // if that's ever not undefined, React throws "destroy is not a function"
    // on the next run. Braces make this an ordinary side effect with no
    // cleanup, which is all this was ever meant to be.
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, busy]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const id = Date.now();
    setTurns((t) => [...t, { id, question: text }]);
    setQ("");
    setBusy(true);
    try {
      const answer = await api<Answer>("/concierge/ask", { body: { question: text } });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (err) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  }

  async function runAction() {
    if (!confirm) return;
    setBusy(true);
    try {
      const done = await api<{ done: string; href: string }>("/concierge/act", { body: { token: confirm.action.token } });
      setTurns((t) => t.map((x) => (x.id === confirm.turn.id ? { ...x, done } : x)));
      toast(confirm.action.kind === "post_rfq" ? "Request posted." : confirm.action.kind === "message_org" ? "Message sent." : "Done.");
      setConfirm(null);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell cols="narrow" title="Business concierge">
      <div className="card hair">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="ct" style={{ marginBottom: 0 }}><Icon name="spark" /> Business concierge</div>
          {status ? <Chip kind={status.ai ? "ac" : ""} icon={status.ai ? "spark" : "search"}>{status.ai ? "Understanding with Claude" : "Understanding with rules (no AI key configured)"}</Chip> : null}
        </div>
        <p className="dim sm" style={{ marginTop: 6 }}>Tell me what you need, where, and by when. I search the network, explain every match from members&apos; own pages, and propose next steps — nothing is sent until you confirm.</p>
        {turns.length === 0 ? (
          <div className="pill-row" style={{ marginTop: 10 }}>
            {EXAMPLES.map((e) => (
              <Chip key={e} onClick={() => ask(e)} testId="concierge-example">{e}</Chip>
            ))}
          </div>
        ) : null}
      </div>

      {turns.map((t) => (
        <div key={t.id} className="col">
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <div className="bubble me" data-testid="concierge-question">{t.question}</div>
          </div>
          {t.error ? <div className="chip bad" role="alert">{t.error}</div> : null}
          {!t.answer && !t.error ? <div className="skel" style={{ height: 40, width: "60%" }} /> : null}
          {t.answer ? (
            <div className="card" data-testid="concierge-answer">
              <div className="why" style={{ marginBottom: 10 }}>
                <Icon name="spark" />
                <span>
                  Understood as: <b>{t.answer.intent.kind.replace("_", " ")}</b>
                  {t.answer.intent.service ? ` · service = ${t.answer.intent.service}` : ""}
                  {t.answer.intent.customerType ? ` · customer type = ${t.answer.intent.customerType}` : ""}
                  {t.answer.intent.location ? ` · area = ${t.answer.intent.location}` : ""}
                  {` · ${t.answer.intent.source === "ai" ? "Claude" : "rules"}`}
                </span>
              </div>
              <p>{t.answer.explanation}</p>
              {t.answer.matches.length ? (
                <div className="list" style={{ marginTop: 12 }}>
                  {t.answer.matches.map((m) => (
                    <div className="li" key={`${m.type}:${m.id}`}>
                      <Avatar name={titleFor(m)} assetId={m.item.logoAssetId ?? m.item.avatarAssetId} size={40} square={m.type === "organizations"} />
                      <div className="t">
                        <b><Link href={hrefFor(m)} data-testid="concierge-match">{titleFor(m)}</Link> <span className="chip xs">{m.type}</span></b>
                        <small>{m.item.headline ?? m.item.industry ?? m.item.location ?? ""}</small>
                        <div className="why" style={{ marginTop: 4 }}><Icon name="check" /> {m.why}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {t.answer.actions.length && !t.done ? (
                <div className="row" style={{ marginTop: 12 }}>
                  {t.answer.actions.map((a) => (
                    <Button key={a.token.slice(-16)} kind={a.kind === "post_rfq" ? "p" : ""} icon={a.kind === "post_rfq" ? "quote" : a.kind === "message_org" ? "msg" : "plus"} onClick={() => setConfirm({ turn: t, action: a })} data-testid={`concierge-action-${a.kind}`}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {t.done ? (
                <div className="chip ok" style={{ marginTop: 12 }}>
                  <Icon name="check" /> Done — <Link href={t.done.href}>open it</Link>
                </div>
              ) : null}
              <p className="xs dim" style={{ marginTop: 10 }}>{t.answer.disclaimer}</p>
            </div>
          ) : null}
        </div>
      ))}
      <div ref={bottom} />

      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input className="in" style={{ flex: 1 }} placeholder="e.g. I need 25 embroidered jackets delivered to Monroe by October 20" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Ask the concierge" data-testid="concierge-input" />
        <Button kind="p" type="submit" icon="send" loading={busy} data-testid="concierge-ask">Ask</Button>
      </form>

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title="Confirm this action" footer={<><Button kind="g" onClick={() => setConfirm(null)}>Cancel</Button><Button kind="p" onClick={runAction} loading={busy} data-testid="concierge-confirm">Yes, do it</Button></>}>
        <p className="sm">{confirm?.action.label}.</p>
        <p className="xs dim">{confirm?.action.kind === "post_rfq" ? "Your request will be visible to the invited vendors, who can quote, ask questions or decline. You can edit or close it any time." : confirm?.action.kind === "message_org" ? "A message in your name goes to the business owner. They see your profile as your privacy settings allow." : ""}</p>
      </Dialog>
    </AppShell>
  );
}
