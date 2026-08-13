"use client";
/**
 * "Confirm with your password" — the dialog the assistant chat pops after
 * someone asks it to give a colleague a permission.
 *
 * ⛔ THE ONE RULE THIS FILE EXISTS TO ENFORCE: the password goes to the API
 * (`/api/admin/agent-grants/...`) and NOWHERE ELSE. It must never touch
 * `/agent-api/*` — anything the agent receives passes through a language model
 * and lands in a conversation transcript and an audit log. The whole point of
 * the password step is that it is the one thing the assistant cannot be talked
 * out of, which only holds while the assistant never sees it.
 *
 * The summary shown is the one STORED on the server, fetched here — not text
 * the model produced. What the owner reads is therefore exactly what the API
 * will act on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, ApiError } from "../services/apiClient";

export type PendingGrant = {
  id: string;
  summary: string;
  /**
   * ⛔ "$30.00 a month, added to your next bill." — null when nothing is
   * charged (a permission grant costs nothing). This MUST be rendered: some of
   * these confirmations start a recurring charge, and a password box with no
   * price on it is not informed consent, however clearly the assistant said the
   * figure earlier in the conversation.
   */
  priceLine?: string | null;
  capabilityId?: string;
  permission?: string;
  permissionPlain?: string;
  targetEmail?: string;
  createdAt: string;
};

/** Plain English for the codes the API can return. A bare slug on screen is a
 *  dead end for the person reading it — see the portal `.payload` handoff. */
const ERROR_TEXT: Record<string, string> = {
  grant_not_found: "That confirmation is no longer available. Ask again in the chat and confirm the new one.",
  already_used: "That confirmation was already used — nothing was changed twice.",
  already_decided: "That request has already been dealt with.",
  expired: "That confirmation has expired. Ask again in the chat and confirm the new one.",
  params_tampered: "This request doesn't match what was approved, so nothing was changed. Please ask again in the chat.",
  not_grantable_by_chat: "That permission has to be changed under Roles, not by chat.",
  not_yours_to_grant: "You can't hand out a permission you don't have yourself.",
  invalid_password: "That password didn't match. Nothing was changed.",
  rate_limited: "Too many tries. Wait a few minutes and try again.",
  target_unavailable: "That person is no longer on this account, so nothing was changed.",
  forbidden: "You need to be an account admin to change someone's permissions.",
  password_required: "Enter your account password to confirm.",
  apply_failed: "Something went wrong applying that change. Nothing was changed — please try again.",
};

/** The server's own sentence wins when it sent one; the map is the fallback. */
export function grantErrorText(err: unknown): string {
  // ⛔ ApiError exposes the server body as `.body`. `.payload` has never existed
  // on it — reading that is the dead-code trap that downgrades a full
  // explanation to a bare slug.
  const body = err instanceof ApiError ? (err.body as { error?: string; message?: string } | null) : null;
  if (body?.message) return body.message;
  const code = body?.error;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  return "Something went wrong and nothing was changed. Please try again.";
}

/**
 * Fetches what the person asked the assistant for but hasn't confirmed yet.
 * Scoped server-side to the requester, so nobody is handed someone else's
 * half-finished request to rubber-stamp.
 */
export function usePendingGrant() {
  const [grant, setGrant] = useState<PendingGrant | null>(null);
  // Dismissals are remembered for the session too, so a slow server round-trip
  // can never re-pop a dialog the person just closed.
  const dismissed = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await apiGet<{ grants: PendingGrant[] }>("/admin/agent-grants/pending");
      const next = (r.grants || []).find((g) => !dismissed.current.has(g.id)) || null;
      setGrant(next);
      return next;
    } catch {
      // Not an admin, or the API is unreachable. Either way: no dialog, and no
      // error in the person's face — they didn't ask for this check.
      return null;
    }
  }, []);

  const clear = useCallback((id?: string) => {
    if (id) dismissed.current.add(id);
    setGrant(null);
  }, []);

  return { grant, refresh, clear };
}

export function AgentGrantConfirmDialog({
  grant,
  onClose,
  onResult,
}: {
  grant: PendingGrant;
  /** Called after the dialog is finished with — always, applied or not. */
  onClose: (id: string) => void;
  /** A plain-English sentence to drop back into the chat. */
  onResult: (message: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [grant.id]);

  const confirm = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ message?: string }>(`/admin/agent-grants/${encodeURIComponent(grant.id)}/apply`, {
        password,
      });
      setPassword("");
      onResult(r.message || "Done — the permission has been given.");
      onClose(grant.id);
    } catch (e) {
      const text = grantErrorText(e);
      const code = e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined;
      // A wrong password is worth another try in place. Anything else means the
      // request is dead — close, and say so in the chat where the person is
      // already looking, instead of leaving a stuck dialog on screen.
      if (code === "invalid_password" || code === "rate_limited") {
        setError(text);
        setPassword("");
        inputRef.current?.focus();
      } else {
        onResult(text);
        onClose(grant.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setPassword("");
    // Retire it server-side so it stops being offered on the next page load.
    // Best-effort: the local dismissal already closed the dialog either way.
    try {
      await apiPost(`/admin/agent-grants/${encodeURIComponent(grant.id)}/dismiss`, {});
    } catch {
      /* the session-level dismissal stands */
    }
    onResult("No problem — I didn't change anything.");
    onClose(grant.id);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm a permission change"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,.5)",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void cancel();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          borderRadius: 14,
          padding: 20,
          background: "var(--panel, #14181f)",
          color: "var(--text, inherit)",
          border: "1px solid var(--border, rgba(128,128,128,.3))",
          boxShadow: "0 20px 60px rgba(0,0,0,.45)",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Confirm this change</h2>
        {/* Verbatim from the server — not model output. */}
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: "12px 0 4px" }}>{grant.summary}</p>
        {grant.priceLine && (
          <p
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.5,
              margin: "10px 0 4px",
              padding: "8px 12px",
              borderRadius: 9,
              background: "rgba(37,99,235,.12)",
              border: "1px solid rgba(37,99,235,.35)",
            }}
          >
            {grant.priceLine}
          </p>
        )}
        <p style={{ fontSize: 12.5, opacity: 0.7, margin: "0 0 14px" }}>
          {grant.priceLine
            ? "Enter your own account password to confirm this and the charge."
            : "Enter your own account password to confirm. You can undo this any time under Roles."}
        </p>

        <input
          ref={inputRef}
          type="password"
          value={password}
          autoComplete="current-password"
          placeholder="Your account password"
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void confirm();
            if (e.key === "Escape") void cancel();
          }}
          style={{
            width: "100%",
            padding: "9px 12px",
            borderRadius: 9,
            border: "1px solid var(--border, rgba(128,128,128,.4))",
            background: "transparent",
            color: "inherit",
            fontSize: 14,
          }}
        />
        {error && <div style={{ color: "#ef4444", fontSize: 12.5, marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 9,
              border: "1px solid var(--border, rgba(128,128,128,.4))",
              background: "transparent",
              color: "inherit",
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || !password}
            style={{
              padding: "8px 16px",
              borderRadius: 9,
              border: "none",
              background: busy || !password ? "rgba(37,99,235,.5)" : "#2563eb",
              color: "#fff",
              cursor: busy || !password ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {busy ? "Confirming…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
