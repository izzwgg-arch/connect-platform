"use client";

/**
 * Loopcom Meetings — the in-meeting screen. Video grid, screen-share stage,
 * chat, raised hands, host controls.
 *
 * Architecture notes:
 *   • Media flows browser ↔ LiveKit only. The Connect API is consulted for the
 *     host's moderation verbs (mute / remove / lock / end) so they stay
 *     permission-checked server-side; a guest client has no path to them.
 *   • Chat and raised hands ride LiveKit's data channel (lib/meetings.ts
 *     protocol) — nothing is stored, meeting chat dies with the meeting.
 *   • Rendering: LiveKit mutates its Room object in place, so the component
 *     re-renders on a version counter bumped by room events, and everything is
 *     derived from the Room on each render. Keeping parallel React state in
 *     sync with the SDK is the bug factory this avoids.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Hand,
  Lock,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Unlock,
  Users,
  Video as VideoIcon,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import {
  DisconnectReason,
  Participant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { resolveSameOriginApiBase } from "../../../lib/publicApiBase";
import { readAuthToken } from "../../../services/session";
import {
  decodeMeetData,
  encodeMeetData,
  meetingWsUrl,
  orderRaisedHands,
  type MeetingJoinGrant,
} from "../../../lib/meetings";

const apiBase = resolveSameOriginApiBase(process.env.NEXT_PUBLIC_API_URL);

type ChatEntry = { name: string; text: string; ts: number; self: boolean };

type Props = {
  code: string;
  grant: MeetingJoinGrant;
  startMicOn: boolean;
  startCamOn: boolean;
  displayName: string;
  onLeft: (message: string) => void;
};

function leaveMessage(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return "You left the meeting.";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "The host removed you from this meeting.";
    case DisconnectReason.ROOM_DELETED:
      return "The host ended the meeting.";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "You joined this meeting from another window, so this one disconnected.";
    default:
      return "You were disconnected from the meeting.";
  }
}

const AVATAR_COLORS = ["#6fc2ff", "#8fd3a8", "#f0b655", "#d8a2e8", "#ffa98f", "#7fd6d0"];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function hostApi(code: string, action: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const token = readAuthToken();
    if (!token) return false;
    const res = await fetch(`${apiBase}/meetings/${encodeURIComponent(code)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One participant's camera (or screen) rendered into a <video>. */
function MediaTile(props: {
  participant: Participant;
  isLocal: boolean;
  speaking: boolean;
  handTs: number | null;
  isHost: boolean;
  viewerIsHost: boolean;
  code: string;
  onToast: (t: string) => void;
}) {
  const { participant, isLocal } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pub = participant.getTrackPublication(Track.Source.Camera);
  const track = pub && !pub.isMuted ? pub.track : undefined;
  const hasVideo = Boolean(track);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  const name = participant.name || participant.identity;
  const micOn = participant.isMicrophoneEnabled;

  const muteRemote = async () => {
    const micPub = participant.getTrackPublication(Track.Source.Microphone);
    if (!micPub?.trackSid) return;
    const ok = await hostApi(props.code, "host/mute", { identity: participant.identity, trackSid: micPub.trackSid });
    props.onToast(ok ? `Muted ${name}` : "Could not mute — try again");
  };
  const removeRemote = async () => {
    const ok = await hostApi(props.code, "host/remove", { identity: participant.identity });
    if (!ok) props.onToast("Could not remove — try again");
  };

  return (
    <div className={`meet-tile ${props.speaking ? "speaking" : ""}`}>
      <video ref={videoRef} autoPlay playsInline muted={isLocal} className={hasVideo ? (isLocal ? "mirror" : "") : "meet-hidden"} />
      {!hasVideo && (
        <div className="meet-avatar" style={{ background: avatarColor(participant.identity) }}>
          {(name[0] || "?").toUpperCase()}
        </div>
      )}
      {props.handTs !== null && <span className="meet-hand-chip">✋</span>}
      <span className="meet-nametag">
        {micOn ? <Mic size={12} className="mic-on" /> : <MicOff size={12} className="mic-off" />}
        {name}
        {isLocal ? " (you)" : ""}
        {props.isHost ? <b className="meet-hostmark">HOST</b> : null}
      </span>
      {props.viewerIsHost && !isLocal && (
        <span className="meet-tile-actions">
          {micOn && (
            <button onClick={() => void muteRemote()} title={`Mute ${name}`}>
              <MicOff size={13} />
            </button>
          )}
          <button onClick={() => void removeRemote()} title={`Remove ${name} from the meeting`}>
            <X size={13} />
          </button>
        </span>
      )}
    </div>
  );
}

/** The shared screen on the stage. */
function ScreenTile(props: { participant: Participant; isLocal: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pub = props.participant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub?.track;
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  const name = props.participant.name || props.participant.identity;
  return (
    <div className="meet-stage">
      <video ref={videoRef} autoPlay playsInline muted={props.isLocal} />
      <span className="meet-stage-label">
        <b>{props.isLocal ? "You are" : `${name} is`}</b> sharing {props.isLocal ? "your" : "a"} screen
      </span>
    </div>
  );
}

export function MeetingRoom(props: Props) {
  const { grant, code, onLeft } = props;
  const roomRef = useRef<Room | null>(null);
  const audioSinkRef = useRef<HTMLDivElement | null>(null);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [panel, setPanel] = useState<"chat" | "people" | null>(null);
  const panelRef = useRef<typeof panel>(null);
  panelRef.current = panel;
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [chatDraft, setChatDraft] = useState("");
  const handsRef = useRef<Map<string, { name: string; ts: number }>>(new Map());
  const speakingRef = useRef<Set<string>>(new Set());
  const [handUp, setHandUp] = useState(false);
  const handUpRef = useRef(false);
  const [locked, setLocked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  // ── Room lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    let disposed = false;

    const publishHand = (up: boolean) => {
      room.localParticipant
        .publishData(encodeMeetData({ t: "hand", up, name: props.displayName, ts: Date.now() }), { reliable: true })
        .catch(() => {});
    };

    room
      .on(RoomEvent.ParticipantConnected, () => {
        // Late joiners can't see history — re-announce my raised hand to them.
        if (handUpRef.current) publishHand(true);
        bump();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        handsRef.current.delete(p.identity);
        speakingRef.current.delete(p.identity);
        bump();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          audioSinkRef.current?.appendChild(el);
        }
        bump();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        bump();
      })
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        speakingRef.current = new Set(speakers.map((s) => s.identity));
        bump();
      })
      .on(RoomEvent.DataReceived, (payload, participant) => {
        const msg = decodeMeetData(payload);
        if (!msg || !participant) return;
        if (msg.t === "chat") {
          setChat((c) => [...c.slice(-499), { name: msg.name, text: msg.text, ts: msg.ts, self: false }]);
          if (panelRef.current !== "chat") setUnread((u) => u + 1);
        } else if (msg.t === "hand") {
          if (msg.up) handsRef.current.set(participant.identity, { name: msg.name, ts: msg.ts });
          else handsRef.current.delete(participant.identity);
        }
        bump();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        setAudioBlocked(!room.canPlaybackAudio);
      })
      .on(RoomEvent.Reconnecting, () => setReconnecting(true))
      .on(RoomEvent.Reconnected, () => {
        setReconnecting(false);
        bump();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (!disposed) onLeft(leaveMessage(reason ?? undefined));
      });

    (async () => {
      try {
        await room.connect(meetingWsUrl(window.location), grant.token);
        // The join click is the user gesture — start audio right away so the
        // browser's autoplay policy doesn't silently mute the meeting.
        await room.startAudio().catch(() => setAudioBlocked(true));
        if (props.startCamOn) await room.localParticipant.setCameraEnabled(true).catch(() => {});
        if (props.startMicOn) await room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
        if (!disposed) {
          setConnected(true);
          bump();
        }
      } catch {
        if (!disposed) onLeft("Could not connect to the meeting. Check your connection and try again.");
      }
    })();

    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      room.disconnect().catch(() => {});
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chat, panel]);

  const room = roomRef.current;
  const local = room?.localParticipant ?? null;
  const remotes = room ? Array.from(room.remoteParticipants.values()) : [];
  const everyone: Participant[] = local ? [local, ...remotes] : [];
  const sharer =
    everyone.find((p) => {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      return Boolean(pub && (pub.track || (local && p === local)));
    }) ?? null;

  const micOn = Boolean(local?.isMicrophoneEnabled);
  const camOn = Boolean(local?.isCameraEnabled);
  const sharing = Boolean(local?.isScreenShareEnabled);
  const hands = orderRaisedHands(handsRef.current);

  const toggleMic = () => local?.setMicrophoneEnabled(!micOn).then(bump).catch(() => showToast("Microphone is blocked by the browser"));
  const toggleCam = () => local?.setCameraEnabled(!camOn).then(bump).catch(() => showToast("Camera is blocked by the browser"));
  const toggleShare = () =>
    local
      ?.setScreenShareEnabled(!sharing)
      .then(bump)
      .catch(() => {
        /* picker dismissed — not an error */
      });
  const toggleHand = () => {
    const next = !handUp;
    setHandUp(next);
    handUpRef.current = next;
    if (local) {
      if (next) handsRef.current.set(local.identity, { name: props.displayName, ts: Date.now() });
      else handsRef.current.delete(local.identity);
      local.publishData(encodeMeetData({ t: "hand", up: next, name: props.displayName, ts: Date.now() }), { reliable: true }).catch(() => {});
    }
    bump();
  };
  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text || !local) return;
    const entry = { name: props.displayName, text, ts: Date.now(), self: true };
    setChat((c) => [...c.slice(-499), entry]);
    setChatDraft("");
    local.publishData(encodeMeetData({ t: "chat", text, name: props.displayName, ts: entry.ts }), { reliable: true }).catch(() => showToast("Message did not send"));
  };
  const toggleLock = async () => {
    const next = !locked;
    const ok = await hostApi(code, "lock", { locked: next });
    if (ok) {
      setLocked(next);
      showToast(next ? "Meeting locked — nobody new can join" : "Meeting unlocked");
    } else {
      showToast("Could not change the lock — try again");
    }
  };
  const leave = () => roomRef.current?.disconnect();

  return (
    <div className="meet-shell meet-room">
      <div ref={audioSinkRef} className="meet-audio-sink" aria-hidden />

      <header className="meet-topbar">
        <span className="meet-topbar-title">{grant.title}</span>
        <span className="meet-topbar-meta">
          {grant.isHost && (
            <button className="meet-lock-btn" onClick={() => void toggleLock()} title={locked ? "Unlock the meeting" : "Lock the meeting to new participants"}>
              {locked ? <Lock size={13} /> : <Unlock size={13} />}
              {locked ? "Locked" : "Open"}
            </button>
          )}
          <span className="meet-timer">{fmtElapsed(elapsed)}</span>
        </span>
      </header>

      {reconnecting && <div className="meet-banner">Reconnecting to the meeting…</div>}
      {!connected && !reconnecting && <div className="meet-banner quiet">Connecting…</div>}
      {audioBlocked && (
        <button className="meet-banner action" onClick={() => roomRef.current?.startAudio().then(() => setAudioBlocked(false)).catch(() => {})}>
          <Volume2 size={15} /> Click to enable sound
        </button>
      )}

      <main className={`meet-main ${panel ? "with-panel" : ""}`}>
        <section className="meet-media">
          {sharer ? (
            <>
              <ScreenTile participant={sharer} isLocal={Boolean(local && sharer === local)} />
              <div className="meet-strip">
                {everyone.map((p) => (
                  <MediaTile
                    key={p.identity}
                    participant={p}
                    isLocal={Boolean(local && p === local)}
                    speaking={speakingRef.current.has(p.identity)}
                    handTs={handsRef.current.get(p.identity)?.ts ?? null}
                    isHost={Boolean(local && p === local ? grant.isHost : p.metadata && safeHostMeta(p.metadata))}
                    viewerIsHost={grant.isHost}
                    code={code}
                    onToast={showToast}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className={`meet-grid count-${Math.min(everyone.length, 9)}`}>
              {everyone.map((p) => (
                <MediaTile
                  key={p.identity}
                  participant={p}
                  isLocal={Boolean(local && p === local)}
                  speaking={speakingRef.current.has(p.identity)}
                  handTs={handsRef.current.get(p.identity)?.ts ?? null}
                  isHost={Boolean(local && p === local ? grant.isHost : p.metadata && safeHostMeta(p.metadata))}
                  viewerIsHost={grant.isHost}
                  code={code}
                  onToast={showToast}
                />
              ))}
            </div>
          )}
        </section>

        {panel === "chat" && (
          <aside className="meet-panel">
            <div className="meet-panel-head">
              Chat
              <button onClick={() => setPanel(null)} aria-label="Close chat">
                <X size={15} />
              </button>
            </div>
            <div className="meet-chat-list">
              {chat.length === 0 && <div className="meet-note">Messages here go to everyone in the meeting and disappear when it ends.</div>}
              {chat.map((m, i) => (
                <div key={i} className={`meet-msg ${m.self ? "self" : ""}`}>
                  <div className="meet-msg-who">
                    {m.self ? "You" : m.name}
                    <time>{new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  </div>
                  <div className="meet-msg-body">{m.text}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="meet-chat-inputrow">
              <input
                className="meet-input"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChat();
                }}
                placeholder="Type a message…"
                maxLength={2000}
              />
              <button className="meet-send-btn" onClick={sendChat} disabled={!chatDraft.trim()}>
                Send
              </button>
            </div>
          </aside>
        )}

        {panel === "people" && (
          <aside className="meet-panel">
            <div className="meet-panel-head">
              People ({everyone.length})
              <button onClick={() => setPanel(null)} aria-label="Close people list">
                <X size={15} />
              </button>
            </div>
            <div className="meet-people-list">
              {hands.length > 0 && (
                <div className="meet-hands-block">
                  <div className="meet-people-heading">Hands up — first come, first served</div>
                  {hands.map((h) => (
                    <div key={h.identity} className="meet-person">
                      ✋ {h.name}
                    </div>
                  ))}
                </div>
              )}
              {everyone.map((p) => (
                <div key={p.identity} className="meet-person">
                  <span className="meet-person-dot" style={{ background: avatarColor(p.identity) }} />
                  {p.name || p.identity}
                  {local && p === local ? " (you)" : ""}
                  {p.isMicrophoneEnabled ? <Mic size={12} className="mic-on" /> : <MicOff size={12} className="mic-off" />}
                </div>
              ))}
            </div>
          </aside>
        )}
      </main>

      <footer className="meet-controls">
        <button className={`meet-ctrl ${micOn ? "" : "warn"}`} onClick={() => void toggleMic()}>
          {micOn ? <Mic size={19} /> : <MicOff size={19} />}
          <span>{micOn ? "Mute" : "Unmute"}</span>
        </button>
        <button className={`meet-ctrl ${camOn ? "" : "warn"}`} onClick={() => void toggleCam()}>
          {camOn ? <VideoIcon size={19} /> : <VideoOff size={19} />}
          <span>Camera</span>
        </button>
        <button className={`meet-ctrl ${sharing ? "active" : ""}`} onClick={() => void toggleShare()}>
          <MonitorUp size={19} />
          <span>{sharing ? "Stop sharing" : "Share screen"}</span>
        </button>
        <button className={`meet-ctrl ${handUp ? "active" : ""}`} onClick={toggleHand}>
          <Hand size={19} />
          <span>{handUp ? "Lower hand" : "Raise hand"}</span>
        </button>
        <button
          className={`meet-ctrl ${panel === "chat" ? "active" : ""}`}
          onClick={() => {
            setPanel(panel === "chat" ? null : "chat");
            setUnread(0);
          }}
        >
          <MessageSquare size={19} />
          <span>Chat</span>
          {unread > 0 && <i className="meet-badge">{unread}</i>}
        </button>
        <button className={`meet-ctrl ${panel === "people" ? "active" : ""}`} onClick={() => setPanel(panel === "people" ? null : "people")}>
          <Users size={19} />
          <span>People</span>
          <i className="meet-badge calm">{everyone.length}</i>
        </button>
        <button className="meet-ctrl danger" onClick={leave}>
          <LogOut size={19} />
          <span>Leave</span>
        </button>
      </footer>

      {toast && <div className="meet-toast">{toast}</div>}
    </div>
  );
}

function safeHostMeta(metadata: string): boolean {
  try {
    return Boolean(JSON.parse(metadata)?.host);
  } catch {
    return false;
  }
}
