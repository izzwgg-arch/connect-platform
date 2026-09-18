"use client";

import { useCallback, useRef, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { Icon, useToast } from "@/components/ui";
import type { Message } from "./types";

type ReplyTarget = { id: string; senderName: string; body: string | null };

function kindForMime(mime: string): "IMAGE" | "VIDEO" | "AUDIO" | "FILE" {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

export function Composer({
  threadId,
  replyTo,
  onCancelReply,
  onSent,
}: {
  threadId: string;
  replyTo: ReplyTarget | null;
  onCancelReply: () => void;
  onSent: (m: Message) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastTypingRef = useRef(0);

  const pingTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingRef.current < 3000) return;
    lastTypingRef.current = now;
    void api(`/threads/${threadId}/typing`, { method: "POST" }).catch(() => {});
  }, [threadId]);

  async function sendText() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    try {
      const res = await api<{ message: Message }>(`/threads/${threadId}/messages`, {
        method: "POST",
        body: { kind: "TEXT", body, replyToId: replyTo?.id },
        idempotencyKey: newIdempotencyKey(),
      });
      onSent(res.message);
      onCancelReply();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
      setText(body); // give the draft back so nothing typed is lost
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const uploaded = await api<{ asset: { id: string } }>("/media", { method: "POST", form, idempotencyKey: newIdempotencyKey() });
      const res = await api<{ message: Message }>(`/threads/${threadId}/messages`, {
        method: "POST",
        body: { kind: kindForMime(file.type), assetId: uploaded.asset.id, replyToId: replyTo?.id },
        idempotencyKey: newIdempotencyKey(),
      });
      onSent(res.message);
      onCancelReply();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size > 300) void sendFile(new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" }));
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      toast("Couldn't access the microphone.", { kind: "err" });
    }
  }

  return (
    <div>
      {replyTo ? (
        <div className="msg-reply-preview" data-testid="messages-reply-preview">
          <Icon name="arrow" />
          <div className="t">
            Replying to <b>{replyTo.senderName}</b>: {replyTo.body ?? "(deleted)"}
          </div>
          <button type="button" className="ib" aria-label="Cancel reply" onClick={onCancelReply} data-testid="messages-reply-cancel">
            <Icon name="x" />
          </button>
        </div>
      ) : null}
      <div className="msg-composer">
        <input ref={fileRef} type="file" hidden data-testid="messages-attach-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void sendFile(f); }} />
        <input ref={photoRef} type="file" accept="image/*" hidden data-testid="messages-photo-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void sendFile(f); }} />
        <button type="button" className="ib" aria-label="Attach a file" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="messages-attach-btn">
          <Icon name="paper" />
        </button>
        <button type="button" className="ib" aria-label="Attach a photo" onClick={() => photoRef.current?.click()} disabled={busy} data-testid="messages-photo-btn">
          <Icon name="cam" />
        </button>
        <button type="button" className={`ib ${recording ? "on" : ""}`} aria-label={recording ? "Stop recording" : "Record a voice message"} onClick={() => void toggleRecording()} data-testid="messages-mic-btn">
          <Icon name="mic" />
        </button>
        {recording ? <span className="msg-recording">● Recording…</span> : null}
        <textarea
          className="in"
          rows={1}
          placeholder="Write a message…"
          value={text}
          disabled={busy || recording}
          data-testid="messages-input"
          onChange={(e) => {
            setText(e.target.value);
            pingTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendText();
            }
          }}
        />
        <button type="button" className="btn p" aria-label="Send" disabled={busy || recording || !text.trim()} onClick={() => void sendText()} data-testid="messages-send">
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
