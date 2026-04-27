"use client";

import { FilePlus2, LocateFixed, Mic, Send, Smile, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatThread, PendingAttachment } from "./types";
import { formatBytes } from "./formatting";

const ACCEPT = [
  "image/*",
  "audio/*",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
].join(",");

export function ChatComposer({
  thread,
  draft,
  onDraft,
  replyingTo,
  onCancelReply,
  pendingAttachments,
  onAttachFiles,
  onRemovePending,
  onSend,
  sending,
}: {
  thread: ChatThread;
  draft: string;
  onDraft: (value: string) => void;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  pendingAttachments: PendingAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemovePending: (index: number) => void;
  onSend: (options?: { type?: string; location?: { lat: number; lng: number; label?: string; address?: string } }) => void;
  sending: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      const file = new File([blob], `voice-note-${Date.now()}.webm`, { type: blob.type });
      onAttachFiles([file]);
      setRecording(false);
      setRecordSeconds(0);
    };
    recorderRef.current = rec;
    rec.start();
    setRecordSeconds(0);
    setRecording(true);
  }

  function stopRecording(send: boolean) {
    const rec = recorderRef.current;
    if (!rec) return;
    if (!send) {
      rec.onstop = () => {
        rec.stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setRecordSeconds(0);
      };
    }
    rec.stop();
  }

  function shareLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (thread.type === "SMS") {
        onDraft(`${draft ? `${draft}\n` : ""}Location: https://maps.google.com/?q=${encodeURIComponent(`${lat},${lng}`)}`);
      } else {
        onSend({ type: "LOCATION", location: { lat, lng, label: "Current location" } });
      }
    });
  }

  return (
    <footer className="cc-composer">
      {replyingTo ? (
        <div className="cc-composer-reply">
          <span>Replying to {replyingTo.senderName}: {replyingTo.body || replyingTo.type}</span>
          <button type="button" onClick={onCancelReply}><X size={14} /></button>
        </div>
      ) : null}

      {pendingAttachments.length ? (
        <div className="cc-pending">
          {pendingAttachments.map((file, index) => (
            <span key={`${file.storageKey}-${index}`} className="cc-pending-chip">
              {file.fileName} <small>{formatBytes(file.sizeBytes)}</small>
              <button type="button" onClick={() => onRemovePending(index)}><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}

      {recording ? (
        <div className="cc-recording">
          <span className="cc-record-dot" />
          Recording {recordSeconds}s
          <button type="button" onClick={() => stopRecording(false)}><Trash2 size={15} /> Cancel</button>
          <button type="button" onClick={() => stopRecording(true)}><Square size={15} /> Stop</button>
        </div>
      ) : null}

      <div className="cc-compose-row">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files || []).slice(0, 3);
            e.currentTarget.value = "";
            if (files.length) onAttachFiles(files);
          }}
        />
        <button type="button" className="cc-icon-btn" onClick={() => fileRef.current?.click()} title="Attach files"><FilePlus2 size={18} /></button>
        <button type="button" className="cc-icon-btn" title="Emoji" onClick={() => onDraft(`${draft}😊`)}><Smile size={18} /></button>
        <button type="button" className="cc-icon-btn" title="Voice note" onClick={startRecording}><Mic size={18} /></button>
        <button type="button" className="cc-icon-btn" title="Share location" onClick={shareLocation}><LocateFixed size={18} /></button>
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={`Message ${thread.participantName}...`}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button type="button" className="cc-send-btn" disabled={sending || (!draft.trim() && pendingAttachments.length === 0)} onClick={() => onSend()}>
          <Send size={17} />
        </button>
      </div>
    </footer>
  );
}
