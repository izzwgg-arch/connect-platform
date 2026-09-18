"use client";

import { useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Dialog, Empty, Field, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";
import "./intros.css";

export type IntroPath = { middle: PersonCard; how: string; strength: number };

/**
 * "Ask for an introduction" — reusable from a profile or company page. Loads
 * the discoverable paths (GET /intros/paths) for the given target, lets the
 * requester pick who should make the introduction, and files the request
 * (POST /intros). The target learns nothing until the middle approves.
 */
export function AskIntroDialog({
  targetPersonId,
  targetOrgId,
  targetName,
  triggerLabel = "Ask for an introduction",
}: {
  targetPersonId?: string;
  targetOrgId?: string;
  targetName: string;
  triggerLabel?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paths, setPaths] = useState<IntroPath[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function openDialog() {
    setOpen(true);
    setSent(false);
    setSelected(null);
    setMessage("");
    setPaths(null);
    setLoading(true);
    try {
      const qs = targetPersonId ? `targetPersonId=${encodeURIComponent(targetPersonId)}` : `targetOrgId=${encodeURIComponent(targetOrgId ?? "")}`;
      const r = await api<{ paths: IntroPath[] }>(`/intros/paths?${qs}`);
      setPaths(r.paths);
      if (r.paths.length) setSelected(r.paths[0].middle.id);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't look for a path.", { kind: "err" });
      setPaths([]);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!selected) return;
    setSending(true);
    try {
      await api("/intros", {
        method: "POST",
        body: { middleId: selected, ...(targetPersonId ? { targetPersonId } : { targetOrgId }), message: message.trim() || undefined },
        idempotencyKey: newIdempotencyKey(),
      });
      setSent(true);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't send that request.", { kind: "err" });
    } finally {
      setSending(false);
    }
  }

  const selectedCard = paths?.find((p) => p.middle.id === selected)?.middle ?? null;

  return (
    <>
      <Button icon="send" onClick={openDialog} data-testid={`intro-ask-open-${targetPersonId ?? targetOrgId ?? ""}`}>
        {triggerLabel}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Ask for an introduction to ${targetName}`}>
        {loading ? (
          <p className="sm dim">Looking for someone who can introduce you…</p>
        ) : sent ? (
          <div>
            <p>Sent{selectedCard ? ` to ${selectedCard.name}` : ""}. You'll hear back once they decide.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <Button kind="p" onClick={() => setOpen(false)} data-testid="intro-ask-close">
                Close
              </Button>
            </div>
          </div>
        ) : !paths || paths.length === 0 ? (
          <Empty title="No introduction path found" text={`Nobody in your network has a discoverable connection to ${targetName} yet.`} />
        ) : (
          <div>
            <div className="list" data-testid="intro-ask-paths">
              {paths.map((p) => (
                <label className="intro-path" key={p.middle.id}>
                  <input type="radio" name="intro-middle" checked={selected === p.middle.id} onChange={() => setSelected(p.middle.id)} data-testid={`intro-ask-pick-${p.middle.id}`} />
                  <Avatar name={p.middle.name} assetId={p.middle.avatarAssetId} size={36} />
                  <div className="t">
                    <b>{p.middle.name}</b>
                    <small>
                      {p.how} {targetName}
                    </small>
                  </div>
                  <span className="intro-strength" aria-hidden>
                    {[1, 2, 3].map((n) => (
                      <i key={n} className={n <= p.strength ? "on" : ""} />
                    ))}
                  </span>
                </label>
              ))}
            </div>
            <Field label="Why do you want the introduction? (optional)" htmlFor="intro-ask-message">
              <textarea id="intro-ask-message" className="intro-draft" value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} data-testid="intro-ask-message" />
            </Field>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button kind="p" loading={sending} disabled={!selected} onClick={send} data-testid="intro-ask-send">
                Request introduction
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
