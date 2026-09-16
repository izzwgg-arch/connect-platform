"use client";

import { useState } from "react";
import { apiPost, ApiError } from "../services/apiClient";

export type LaybelStatus = {
  configured: boolean; available: boolean; enabled?: boolean;
  avatarId?: string; voiceId?: string; apiKeySet?: boolean; maxSessionSeconds?: number;
};

/** Owner-only configuration; the server never returns the stored provider key. */
export function LaybelSetup({ status, onSaved }: { status: LaybelStatus; onSaved: (status: LaybelStatus) => void }) {
  const [key, setKey] = useState("");
  const [avatarId, setAvatarId] = useState(status.avatarId ?? "");
  const [voiceId, setVoiceId] = useState(status.voiceId ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  return <details>
    <summary>Owner video setup</summary>
    <p>Use the Anam avatar created from the approved Laybel portrait and its voice ID. Saving allows owner preview only; customer rollout remains unchanged.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (saving) return;
      setSaving(true); setMessage("");
      try {
        const saved = await apiPost<LaybelStatus>("/support/laybel/settings", {
          avatarId: avatarId.trim(), voiceId: voiceId.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}),
        });
        setKey(""); onSaved(saved); setMessage("Saved. Start an owner preview above to verify the picture, voice and conversation.");
      } catch (error) {
        setMessage(error instanceof ApiError ? (error.body as { message?: string } | null)?.message ?? "Unable to save the video configuration." : "Unable to save the video configuration.");
      } finally { setSaving(false); }
    }}>
      <label>Anam API key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={status.apiKeySet ? "Already stored · leave blank to keep" : "Enter API key"} required={!status.apiKeySet} /></label>
      <label>Approved Laybel avatar ID<input value={avatarId} onChange={e => setAvatarId(e.target.value)} required /></label>
      <label>Voice ID<input value={voiceId} onChange={e => setVoiceId(e.target.value)} required /></label>
      <button disabled={saving}>{saving ? "Saving…" : "Save video setup"}</button>
      {message && <p role="status">{message}</p>}
    </form>
    <style jsx>{`
      details { margin-top:10px; font-size:11px; } summary { cursor:pointer; }
      label { display:block; margin:8px 0; } input { display:block; width:100%; box-sizing:border-box; margin-top:3px; padding:6px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }
      button { border:1px solid var(--border); border-radius:6px; padding:6px; background:var(--panel); color:var(--text); cursor:pointer; }
    `}</style>
  </details>;
}
