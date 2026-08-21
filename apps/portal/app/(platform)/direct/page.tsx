"use client";

/**
 * Loopcom Direct — cross-company chat by phone number.
 *
 * The screens are the approved mockups
 * (https://claude.ai/code/artifact/d1d6e1f8-4be9-4aed-9c63-69c7781b0c2e)
 * rendered for a wide window: the same elements, the same wording, the same
 * order — chat list with the Requests tray on top, the person card with their
 * company and an "On Loopcom" pill, the accept/decline/block card, the privacy
 * toggles, and the verify-your-number step.
 *
 * ⛔ Every colour comes from the app's theme tokens via loopcomDirect.css, so
 * this screen follows the IN-APP light/dark switch. Do not introduce a literal
 * colour here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PermissionGate } from "../../../components/PermissionGate";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../../services/apiClient";
import {
  avatarClassFor,
  callEventLabel,
  formatPhoneForDisplay,
  formatPhoneWhileTyping,
  initialsFor,
  isSearchablePhone,
  meetingPathFor,
  shortTimestamp,
  type DirectLookup,
  type DirectMe,
  type DirectThreadDetail,
  type DirectThreadSummary,
} from "../../../lib/loopcomDirect";

import "./loopcomDirect.css";

const POLL_MS = 7000;

/** The server sends plain-English messages; show those, never a slug. */
function errText(e: unknown, fallback: string): string {
  const body = (e as { body?: { message?: string; error?: string } } | null)?.body;
  return body?.message || fallback;
}

function Avatar({ name, seed }: { name: string; seed: string }) {
  return <div className={`lcd-avatar ${avatarClassFor(seed)}`}>{initialsFor(name)}</div>;
}

export default function DirectPage() {
  return (
    <PermissionGate
      permission="can_view_workspace_chat"
      /* ⛔ An explicit fallback, never the default null: a blank page reads as a
         broken app, where a sentence reads as a permission. */
      fallback={
        <div className="lcd-shell">
          <div className="lcd-pane">
            <div className="lcd-empty">
              <h3>You don&rsquo;t have access to Direct</h3>
              <p>Ask whoever manages your Loopcom account to give you access to chat.</p>
            </div>
          </div>
        </div>
      }
    >
      <DirectScreen />
    </PermissionGate>
  );
}

function DirectScreen() {
  const [me, setMe] = useState<DirectMe | null>(null);
  const [threads, setThreads] = useState<DirectThreadSummary[]>([]);
  const [requests, setRequests] = useState<DirectThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DirectThreadDetail | null>(null);
  const [view, setView] = useState<"threads" | "requests" | "privacy">("threads");
  const [showNew, setShowNew] = useState(false);
  const [showVerify, setShowVerify] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      setMe(await apiGet<DirectMe>("/direct/me"));
    } catch {
      /* a failed settings read must not blank the screen */
    }
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const res = await apiGet<{ threads: DirectThreadSummary[]; requests: DirectThreadSummary[] }>("/direct/threads");
      setThreads(res.threads ?? []);
      setRequests(res.requests ?? []);
    } catch {
      /* keep whatever is on screen rather than emptying the list */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (threadId: string) => {
    try {
      setDetail(await apiGet<DirectThreadDetail>(`/direct/threads/${threadId}`));
    } catch (e) {
      setBanner(errText(e, "That conversation isn't available."));
      setActiveId(null);
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    void loadThreads();
  }, [loadMe, loadThreads]);

  useEffect(() => {
    if (activeId) void loadDetail(activeId);
    else setDetail(null);
  }, [activeId, loadDetail]);

  // Poll on the same cadence as the rest of chat, and only while visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadThreads();
      if (activeId) void loadDetail(activeId);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [activeId, loadDetail, loadThreads]);

  // Mark read once, when the newest message advances. ⛔ The server refuses to
  // record a read on a pending request, so opening one leaks nothing.
  const lastReadRef = useRef<string>("");
  useEffect(() => {
    if (!detail || detail.myState !== "ACTIVE") return;
    const newest = detail.messages[detail.messages.length - 1];
    if (!newest || newest.mine) return;
    const key = `${detail.threadId}:${newest.id}`;
    if (lastReadRef.current === key) return;
    lastReadRef.current = key;
    void apiPost(`/direct/threads/${detail.threadId}/read`, {}).catch(() => undefined);
  }, [detail]);

  const verified = Boolean(me?.identity);
  const companyOff = me ? !me.companyEnabled : false;

  const openThread = (id: string) => {
    setActiveId(id);
    setView("threads");
  };

  const afterRequestAction = async () => {
    setActiveId(null);
    setDetail(null);
    await loadThreads();
    setView("threads");
  };

  if (loading && !me) {
    return (
      <div className="lcd-shell">
        <div className="lcd-pane">
          <div className="lcd-empty">
            <p>Loading&hellip;</p>
          </div>
        </div>
      </div>
    );
  }

  if (companyOff) {
    return (
      <div className="lcd-shell">
        <div className="lcd-pane">
          <div className="lcd-empty">
            <h3>Direct is switched off for your company</h3>
            <p>Loopcom Direct lets you chat with people at other companies. Your company has it turned off.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`lcd-shell${activeId ? " lcd-shell--thread-open" : ""}`}>
        <aside className="lcd-list">
          <div className="lcd-list-head">
            <h2>Direct</h2>
            <button
              type="button"
              className="lcd-icon-btn"
              title="Privacy settings"
              aria-label="Privacy settings"
              onClick={() => {
                setView("privacy");
                setActiveId(null);
              }}
            >
              &#9881;
            </button>
            <button
              type="button"
              className="lcd-icon-btn"
              title="New chat"
              aria-label="New chat"
              disabled={!verified}
              onClick={() => setShowNew(true)}
            >
              &#9998;
            </button>
          </div>

          <div className="lcd-list-scroll">
            {!verified && (
              <div className="lcd-card accent">
                <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>Verify your number to get started</div>
                <p className="lcd-note" style={{ margin: 0 }}>
                  People find you on Direct by your mobile number. Nobody can find you until you verify it.
                </p>
                <button type="button" className="lcd-btn" onClick={() => setShowVerify(true)}>
                  Verify my number
                </button>
              </div>
            )}

            {/* ⛔ The tray renders ONLY when something is waiting. */}
            {requests.length > 0 && (
              <button type="button" className="lcd-requests-card" onClick={() => setView("requests")}>
                <div className="lcd-avatar c1" aria-hidden>
                  &#9993;
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lcd-rq-title">Message requests</div>
                  <div className="lcd-rq-sub">
                    {requests.length === 1
                      ? "1 person wants to chat with you"
                      : `${requests.length} people want to chat with you`}
                  </div>
                </div>
                <span className="lcd-count">{requests.length}</span>
              </button>
            )}

            {threads.map((t) => (
              <button
                type="button"
                key={t.threadId}
                className={`lcd-row${t.threadId === activeId ? " is-active" : ""}${t.unread ? " is-unread" : ""}`}
                onClick={() => openThread(t.threadId)}
              >
                <Avatar name={t.other?.name ?? "?"} seed={t.other?.userId ?? t.threadId} />
                <div className="lcd-row-main">
                  <div className="lcd-row-name">{t.other?.name ?? "Loopcom user"}</div>
                  <div className="lcd-row-sub">
                    {t.lastMessage
                      ? `${t.lastMessage.mine ? "You: " : ""}${
                          t.lastMessage.kind === "CALL_EVENT" ? "Video call" : t.lastMessage.body
                        }`
                      : t.other?.company || ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>
                    {shortTimestamp(t.lastMessageAt)}
                  </span>
                  {t.unread && <span className="lcd-dot" aria-label="Unread" />}
                </div>
              </button>
            ))}

            {verified && threads.length === 0 && requests.length === 0 && (
              <p className="lcd-note" style={{ padding: "18px 8px", textAlign: "center" }}>
                No conversations yet. Tap the pencil to start one with a phone number.
              </p>
            )}
          </div>
        </aside>

        <section className="lcd-pane">
          {view === "privacy" ? (
            <PrivacyView
              me={me}
              onChanged={loadMe}
              onVerify={() => setShowVerify(true)}
              onClose={() => setView("threads")}
            />
          ) : view === "requests" ? (
            <RequestsView
              requests={requests}
              onOpen={(id) => {
                setActiveId(id);
                setView("threads");
              }}
              onClose={() => setView("threads")}
            />
          ) : detail ? (
            <ThreadView
              detail={detail}
              onReload={() => activeId && loadDetail(activeId)}
              onAfterRequestAction={afterRequestAction}
              onBanner={setBanner}
              onBack={() => setActiveId(null)}
            />
          ) : (
            <div className="lcd-empty">
              <h3>Chat with anyone on Loopcom</h3>
              <p>
                Find people at other companies by their phone number, message them, and start a video call — all
                inside Loopcom.
              </p>
              {verified ? (
                <button type="button" className="lcd-btn" onClick={() => setShowNew(true)}>
                  New chat
                </button>
              ) : (
                <button type="button" className="lcd-btn" onClick={() => setShowVerify(true)}>
                  Verify my number
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      {banner && (
        <div className="lcd-modal-backdrop" onClick={() => setBanner(null)}>
          <div className="lcd-modal" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0 }}>{banner}</p>
            <button type="button" className="lcd-btn" onClick={() => setBanner(null)}>
              OK
            </button>
          </div>
        </div>
      )}

      {showNew && (
        <NewChatDialog
          onClose={() => setShowNew(false)}
          onStarted={async (threadId) => {
            setShowNew(false);
            await loadThreads();
            openThread(threadId);
          }}
        />
      )}

      {showVerify && (
        <VerifyDialog
          onClose={() => setShowVerify(false)}
          onVerified={async () => {
            setShowVerify(false);
            await loadMe();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ thread */

function ThreadView({
  detail,
  onReload,
  onAfterRequestAction,
  onBanner,
  onBack,
}: {
  detail: DirectThreadDetail;
  onReload: () => void;
  onAfterRequestAction: () => Promise<void>;
  onBanner: (s: string) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [calling, setCalling] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail.messages.length, detail.threadId]);

  const isRequest = detail.myState === "REQUEST_PENDING";

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await apiPost(`/direct/threads/${detail.threadId}/messages`, { body });
      setDraft("");
      onReload();
    } catch (e) {
      onBanner(errText(e, "That message didn't send."));
    } finally {
      setSending(false);
    }
  };

  const startCall = async () => {
    if (calling) return;
    setCalling(true);
    try {
      const res = await apiPost<{ meetingCode: string; joinPath: string }>(
        `/direct/threads/${detail.threadId}/call`,
        {},
      );
      // Open the meeting for me; the other side gets it in the thread and a push.
      window.open(res.joinPath, "_blank", "noopener");
      onReload();
    } catch (e) {
      onBanner(errText(e, "We couldn't start the call."));
    } finally {
      setCalling(false);
    }
  };

  const act = async (action: "accept" | "decline" | "block") => {
    try {
      await apiPost(`/direct/threads/${detail.threadId}/${action}`, {});
      if (action === "accept") onReload();
      else await onAfterRequestAction();
    } catch (e) {
      onBanner(errText(e, "That didn't work."));
    }
  };

  return (
    <>
      <header className="lcd-thread-head">
        <button
          type="button"
          className="lcd-icon-btn"
          onClick={onBack}
          aria-label="Back to conversations"
          title="Back"
        >
          &#8249;
        </button>
        <Avatar name={detail.other?.name ?? "?"} seed={detail.other?.userId ?? detail.threadId} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="lcd-th-name">{detail.other?.name ?? "Loopcom user"}</div>
          <div className="lcd-th-sub">
            {[detail.other?.company, isRequest ? "found you by your number" : "on Loopcom"]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <button
          type="button"
          className="lcd-icon-btn"
          onClick={startCall}
          disabled={!detail.canCall || calling}
          title={detail.canCall ? "Start a video call" : detail.callBlockedReason ?? "Not available"}
          aria-label="Start a video call"
        >
          &#127909;
        </button>
      </header>

      <div className="lcd-messages" ref={scrollRef}>
        {isRequest && (
          <div className="lcd-sysline">
            Message request &middot; {detail.other?.name ?? "They"} can&rsquo;t see that you&rsquo;ve read this
          </div>
        )}
        {detail.messages.map((m) => {
          if (m.kind === "CALL_EVENT") {
            const path = meetingPathFor(m.meetingCode);
            return (
              <div className="lcd-sysline" key={m.id}>
                &#127909; {callEventLabel(m.callSeconds)} &middot; {shortTimestamp(m.createdAt)}
                {path && (
                  <>
                    {" · "}
                    <a href={path} target="_blank" rel="noopener noreferrer">
                      Join
                    </a>
                  </>
                )}
              </div>
            );
          }
          return (
            <div key={m.id} style={{ display: "contents" }}>
              <div className={`lcd-bubble ${m.mine ? "me" : "them"}`}>{m.body}</div>
              <div className={`lcd-stamp${m.mine ? "" : " l"}`}>
                {shortTimestamp(m.createdAt)}
                {m.mine && detail.other?.readAt && new Date(detail.other.readAt) >= new Date(m.createdAt)
                  ? " · Read"
                  : ""}
              </div>
            </div>
          );
        })}
      </div>

      {isRequest ? (
        <div style={{ padding: 14, borderTop: "1px solid var(--border)" }}>
          <div className="lcd-card">
            <p className="lcd-note" style={{ margin: 0 }}>
              Accept to start chatting. {detail.other?.name ?? "They"} won&rsquo;t know you saw this unless you
              accept.
            </p>
            <div className="lcd-btnrow">
              <button type="button" className="lcd-btn" onClick={() => act("accept")}>
                Accept
              </button>
              <button type="button" className="lcd-btn ghost" onClick={() => act("decline")}>
                Decline
              </button>
            </div>
            <button type="button" className="lcd-btn quiet" onClick={() => act("block")}>
              Block {detail.other?.name ?? "this person"}
            </button>
          </div>
        </div>
      ) : (
        <div className="lcd-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={detail.canSend ? "Message…" : detail.sendBlockedReason ?? "Not available"}
            disabled={!detail.canSend || sending}
            rows={1}
          />
          <button
            type="button"
            className="lcd-btn"
            onClick={send}
            disabled={!detail.canSend || sending || !draft.trim()}
          >
            Send
          </button>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- requests */

function RequestsView({
  requests,
  onOpen,
  onClose,
}: {
  requests: DirectThreadSummary[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <header className="lcd-thread-head">
        <button type="button" className="lcd-icon-btn" onClick={onClose} aria-label="Back" title="Back">
          &#8249;
        </button>
        <div style={{ flex: 1 }}>
          <div className="lcd-th-name">Message requests</div>
          <div className="lcd-th-sub">People who found you by your number</div>
        </div>
      </header>
      <div className="lcd-settings-stack">
        {requests.length === 0 && <p className="lcd-note">No requests waiting.</p>}
        {requests.map((r) => (
          <button type="button" key={r.threadId} className="lcd-row" onClick={() => onOpen(r.threadId)}>
            <Avatar name={r.other?.name ?? "?"} seed={r.other?.userId ?? r.threadId} />
            <div className="lcd-row-main">
              <div className="lcd-row-name">{r.other?.name ?? "Loopcom user"}</div>
              <div className="lcd-row-sub">{r.other?.company || r.lastMessage?.body || ""}</div>
            </div>
            <span className="lcd-pill off">Request</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- privacy */

function PrivacyView({
  me,
  onChanged,
  onVerify,
  onClose,
}: {
  me: DirectMe | null;
  onChanged: () => Promise<void>;
  onVerify: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (field: "findable" | "requireRequests", next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch("/direct/me", { [field]: next });
      await onChanged();
    } catch (e) {
      setError(errText(e, "That didn't save."));
    } finally {
      setBusy(false);
    }
  };

  const unblock = async (userId: string) => {
    setBusy(true);
    try {
      await apiDelete(`/direct/blocks/${userId}`);
      await onChanged();
    } catch (e) {
      setError(errText(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="lcd-thread-head">
        <button type="button" className="lcd-icon-btn" onClick={onClose} aria-label="Back" title="Back">
          &#8249;
        </button>
        <div style={{ flex: 1 }}>
          <div className="lcd-th-name">Chat privacy</div>
          <div className="lcd-th-sub">Who can find and message you on Direct</div>
        </div>
      </header>

      <div className="lcd-settings-stack">
        {error && <div className="lcd-error">{error}</div>}

        {!me?.identity ? (
          <div className="lcd-card accent">
            <div style={{ fontWeight: 700 }}>Your number isn&rsquo;t verified yet</div>
            <p className="lcd-note" style={{ margin: 0 }}>
              People find you on Direct by your mobile number. Until you verify it, nobody can find you and
              nobody can message you.
            </p>
            <button type="button" className="lcd-btn" onClick={onVerify}>
              Verify my number
            </button>
          </div>
        ) : (
          <>
            <div className="lcd-setrow">
              <span className="lcd-set-label">
                People can find me by my number
                <span className="lcd-set-sub">
                  Your verified number: {me.identity.phoneDisplay || formatPhoneForDisplay(me.identity.phoneE164)}
                </span>
              </span>
              <button
                type="button"
                className="lcd-toggle"
                role="switch"
                aria-checked={me.identity.findable}
                aria-label="People can find me by my number"
                disabled={busy}
                onClick={() => toggle("findable", !me.identity!.findable)}
              />
            </div>

            <div className="lcd-setrow">
              <span className="lcd-set-label">
                New people must send a request
                <span className="lcd-set-sub">People you&rsquo;ve chatted with always come straight through</span>
              </span>
              <button
                type="button"
                className="lcd-toggle"
                role="switch"
                aria-checked={me.identity.requireRequests}
                aria-label="New people must send a request"
                disabled={busy}
                onClick={() => toggle("requireRequests", !me.identity!.requireRequests)}
              />
            </div>

            <div className="lcd-card">
              <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                Blocked
                <span className="lcd-set-sub">
                  {me.blocked.length === 0
                    ? "Nobody is blocked"
                    : `${me.blocked.length} ${me.blocked.length === 1 ? "person" : "people"} · they can't message or call you`}
                </span>
              </div>
              {me.blocked.map((b) => (
                <div key={b.userId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar name={b.name} seed={b.userId} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="lcd-row-name">{b.name}</div>
                    <div className="lcd-row-sub">{b.company}</div>
                  </div>
                  <button type="button" className="lcd-btn ghost" disabled={busy} onClick={() => unblock(b.userId)}>
                    Unblock
                  </button>
                </div>
              ))}
            </div>

            <p className="lcd-note">
              Turning off &ldquo;find me&rdquo; hides you from number search. Existing chats keep working.
            </p>
          </>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- new chat */

function NewChatDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (threadId: string) => Promise<void>;
}) {
  const [phone, setPhone] = useState("");
  const [lookup, setLookup] = useState<DirectLookup | null>(null);
  const [searching, setSearching] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchable = useMemo(() => isSearchablePhone(phone), [phone]);

  useEffect(() => {
    if (!searchable) {
      setLookup(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiGet<DirectLookup>(`/direct/lookup?phone=${encodeURIComponent(phone)}`);
        if (!cancelled) setLookup(res);
      } catch {
        if (!cancelled) setLookup(null);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, searchable]);

  const start = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiPost<{ threadId: string }>("/direct/threads", { phone, body });
      await onStarted(res.threadId);
    } catch (e) {
      setError(errText(e, "We couldn't start that conversation."));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="lcd-modal-backdrop" onClick={onClose}>
      <div className="lcd-modal" onClick={(e) => e.stopPropagation()}>
        <h3>New chat</h3>

        <div className="lcd-field">
          <label htmlFor="lcd-phone">Phone number</label>
          <input
            id="lcd-phone"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            placeholder="(347) 555-0182"
            onChange={(e) => setPhone(formatPhoneWhileTyping(e.target.value))}
          />
          <span className="lcd-note">Type the mobile number of the person you want to reach.</span>
        </div>

        {searching && <p className="lcd-note">Looking&hellip;</p>}

        {lookup?.result === "found" && (
          <>
            <div className="lcd-row" style={{ cursor: "default", border: "1px solid var(--border)" }}>
              <Avatar name={lookup.name} seed={lookup.userId} />
              <div className="lcd-row-main">
                <div className="lcd-row-name">{lookup.name}</div>
                <div className="lcd-row-sub">{lookup.company}</div>
              </div>
              <span className="lcd-pill on">On Loopcom</span>
            </div>
            {lookup.existingThreadId ? (
              <button
                type="button"
                className="lcd-btn"
                onClick={() => onStarted(lookup.existingThreadId as string)}
              >
                Open your conversation
              </button>
            ) : (
              <>
                <div className="lcd-field">
                  <label htmlFor="lcd-first">Your message</label>
                  <textarea
                    id="lcd-first"
                    rows={3}
                    value={body}
                    placeholder={`Say hello to ${lookup.name.split(" ")[0]}…`}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>
                <button type="button" className="lcd-btn" disabled={!body.trim() || sending} onClick={start}>
                  Message {lookup.name.split(" ")[0]}
                </button>
                <p className="lcd-note" style={{ textAlign: "center" }}>
                  Free over the internet &middot; not a text message
                </p>
              </>
            )}
          </>
        )}

        {lookup?.result === "not_on_loopcom" && (
          <div className="lcd-row" style={{ cursor: "default", border: "1px solid var(--border)" }}>
            <div className="lcd-avatar unknown">?</div>
            <div className="lcd-row-main">
              <div className="lcd-row-name">{lookup.phoneDisplay}</div>
              <div className="lcd-row-sub">Not on Loopcom yet</div>
            </div>
            <span className="lcd-pill off">&mdash;</span>
          </div>
        )}

        {lookup?.result === "self" && <p className="lcd-note">That&rsquo;s your own number.</p>}
        {lookup?.result === "invalid" && <p className="lcd-note">{lookup.message}</p>}

        {error && <div className="lcd-error">{error}</div>}

        <button type="button" className="lcd-btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ verify */

function VerifyDialog({ onClose, onVerified }: { onClose: () => void; onVerified: () => Promise<void> }) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ sent: boolean; testMode: boolean; phoneDisplay: string }>(
        "/direct/verify/start",
        { phone },
      );
      setStep("code");
      // ⛔ Honest about test mode rather than claiming a text is on its way.
      setNotice(
        res.testMode
          ? "Texting is in test mode on this server, so no message was actually sent."
          : `We texted a code to ${res.phoneDisplay}.`,
      );
    } catch (e) {
      setError(errText(e, "We couldn't send the code."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/direct/verify/confirm", { phone, code });
      await onVerified();
    } catch (e) {
      setError(errText(e, "That code isn't right."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lcd-modal-backdrop" onClick={onClose}>
      <div className="lcd-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Verify your number</h3>

        {step === "phone" ? (
          <>
            <p className="lcd-note" style={{ margin: 0 }}>
              We&rsquo;ll text you a code. Once it&rsquo;s verified, people can find you on Direct by this number
              &mdash; and not before.
            </p>
            <div className="lcd-field">
              <label htmlFor="lcd-vphone">Your mobile number</label>
              <input
                id="lcd-vphone"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                placeholder="(917) 555-0114"
                onChange={(e) => setPhone(formatPhoneWhileTyping(e.target.value))}
              />
            </div>
            {error && <div className="lcd-error">{error}</div>}
            <button
              type="button"
              className="lcd-btn"
              disabled={!isSearchablePhone(phone) || busy}
              onClick={sendCode}
            >
              {busy ? "Sending…" : "Text me a code"}
            </button>
          </>
        ) : (
          <>
            {notice && <div className="lcd-ok">{notice}</div>}
            <div className="lcd-field">
              <label htmlFor="lcd-code">Enter the 6-digit code</label>
              <input
                id="lcd-code"
                className="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                placeholder="000000"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            {error && <div className="lcd-error">{error}</div>}
            <button type="button" className="lcd-btn" disabled={code.length !== 6 || busy} onClick={confirm}>
              {busy ? "Checking…" : "Verify"}
            </button>
            <button type="button" className="lcd-btn quiet" onClick={() => setStep("phone")}>
              Use a different number
            </button>
          </>
        )}

        <button type="button" className="lcd-btn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
