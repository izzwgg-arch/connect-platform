"use client";

/**
 * Loopcom Meetings — the public join page. Open the link, see your camera,
 * type your name, you're in. No account, no download.
 *
 * ⛔ PUBLIC PAGE RULES (the pay-page family):
 *   • Same-origin API base only (`resolveSameOriginApiBase`) — this page serves
 *     on more than one hostname and a hardcoded domain is a CORS failure on
 *     the other one.
 *   • Listed in sessionExpiry's PUBLIC_PATH_PREFIXES ("/meet/") so a guest is
 *     never bounced to /login.
 *   • Errors render the server's plain-English `message` (read via `.body`
 *     semantics — this page uses bare fetch, so it reads the JSON directly);
 *     unknown failures fall back to joinErrorText, never a raw slug.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Mic, MicOff, Video as VideoIcon, VideoOff } from "lucide-react";
import { resolveSameOriginApiBase } from "../../../lib/publicApiBase";
import { readAuthToken } from "../../../services/session";
import {
  MEET_NAME_STORAGE_KEY,
  joinErrorText,
  type MeetingInfo,
  type MeetingJoinGrant,
} from "../../../lib/meetings";
import { MeetingRoom } from "./MeetingRoom";
import "./meet.css";

const apiBase = resolveSameOriginApiBase(process.env.NEXT_PUBLIC_API_URL);

type Phase =
  | { kind: "loading" }
  | { kind: "lobby"; info: MeetingInfo }
  | { kind: "blocked"; message: string }
  | { kind: "joining"; info: MeetingInfo }
  | { kind: "in"; grant: MeetingJoinGrant; micOn: boolean; camOn: boolean }
  | { kind: "left"; message: string };

function storedName(): string {
  try {
    return window.localStorage.getItem(MEET_NAME_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export default function MeetJoinPage() {
  const params = useParams<{ code: string }>();
  const code = String(params?.code || "").toLowerCase();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [name, setName] = useState("");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setName(storedName());
  }, []);

  // Meeting info — what the page says before anyone types a name.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/meetings/public/${encodeURIComponent(code)}/info`);
        const info = (await res.json()) as MeetingInfo;
        if (cancelled) return;
        if (!info.exists) {
          setPhase({ kind: "blocked", message: joinErrorText("meeting_not_found") });
        } else if (info.ended) {
          setPhase({ kind: "blocked", message: joinErrorText("meeting_ended") });
        } else {
          setPhase({ kind: "lobby", info });
          if (info.title) document.title = `${info.title} — Loopcom Meetings`;
        }
      } catch {
        if (!cancelled) setPhase({ kind: "blocked", message: joinErrorText(null) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Camera/mic preview while in the lobby. A refusal is a message, not a wall —
  // people join listen-only from locked-down machines all the time.
  const inLobby = phase.kind === "lobby";
  useEffect(() => {
    if (!inLobby) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch {
        if (!cancelled) {
          setMediaError("Camera and microphone are blocked. You can still join and just watch and listen.");
        }
      }
    })();
    return () => {
      cancelled = true;
      stopPreview();
    };
  }, [inLobby, stopPreview]);

  // Reflect the lobby toggles onto the preview.
  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }, [camOn]);
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }, [micOn]);

  const join = useCallback(async () => {
    if (phase.kind !== "lobby") return;
    const displayName = name.trim();
    if (!displayName) {
      setJoinError("Type your name so people know who joined.");
      return;
    }
    try {
      window.localStorage.setItem(MEET_NAME_STORAGE_KEY, displayName);
    } catch {
      /* storage full/blocked — join anyway */
    }
    setJoinError(null);
    setPhase({ kind: "joining", info: phase.info });

    const publicJoin = () =>
      fetch(`${apiBase}/meetings/public/${encodeURIComponent(code)}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });

    try {
      // A signed-in Connect user joins with their session so the host gets
      // host powers; a stale token falls back to guest join rather than
      // stranding them (⛔ a locked/ended refusal is NOT retried as guest —
      // locked means locked).
      let res: Response;
      const token = readAuthToken();
      if (token) {
        res = await fetch(`${apiBase}/meetings/${encodeURIComponent(code)}/join`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ displayName }),
        });
        if (res.status === 401) res = await publicJoin();
      } else {
        res = await publicJoin();
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase({ kind: "lobby", info: phase.info });
        setJoinError(String(body?.message || joinErrorText(body?.error)));
        return;
      }
      stopPreview();
      setPhase({ kind: "in", grant: body as MeetingJoinGrant, micOn, camOn });
    } catch {
      setPhase({ kind: "lobby", info: phase.info });
      setJoinError(joinErrorText(null));
    }
  }, [phase, name, code, micOn, camOn, stopPreview]);

  if (phase.kind === "in") {
    return (
      <MeetingRoom
        code={code}
        grant={phase.grant}
        startMicOn={phase.micOn}
        startCamOn={phase.camOn}
        displayName={name.trim()}
        onLeft={(message) => setPhase({ kind: "left", message })}
      />
    );
  }

  return (
    <div className="meet-shell">
      <div className="meet-lobby">
        {phase.kind === "loading" && <div className="meet-note">Loading the meeting…</div>}

        {phase.kind === "blocked" && (
          <div className="meet-card meet-card-center">
            <div className="meet-wordmark">
              <span>Loopcom</span> Meetings
            </div>
            <p className="meet-blocked">{phase.message}</p>
          </div>
        )}

        {phase.kind === "left" && (
          <div className="meet-card meet-card-center">
            <div className="meet-wordmark">
              <span>Loopcom</span> Meetings
            </div>
            <p className="meet-blocked">{phase.message}</p>
            <button className="meet-join-btn" onClick={() => window.location.reload()}>
              Rejoin
            </button>
          </div>
        )}

        {(phase.kind === "lobby" || phase.kind === "joining") && (
          <div className="meet-lobby-grid">
            <div className="meet-preview-wrap">
              <div className="meet-preview">
                <video ref={videoRef} autoPlay playsInline muted className={camOn ? "" : "meet-hidden"} />
                {!camOn && <div className="meet-preview-off">Camera is off</div>}
                <span className="meet-you-chip">You</span>
                <div className="meet-preview-controls">
                  <button
                    className={`meet-round-btn ${micOn ? "" : "off"}`}
                    onClick={() => setMicOn((v) => !v)}
                    aria-label={micOn ? "Turn microphone off" : "Turn microphone on"}
                  >
                    {micOn ? <Mic size={19} /> : <MicOff size={19} />}
                  </button>
                  <button
                    className={`meet-round-btn ${camOn ? "" : "off"}`}
                    onClick={() => setCamOn((v) => !v)}
                    aria-label={camOn ? "Turn camera off" : "Turn camera on"}
                  >
                    {camOn ? <VideoIcon size={19} /> : <VideoOff size={19} />}
                  </button>
                </div>
              </div>
              {mediaError && <div className="meet-media-warn">{mediaError}</div>}
            </div>

            <div className="meet-card">
              <div className="meet-wordmark">
                <span>Loopcom</span> Meetings
              </div>
              <h1 className="meet-title">{phase.info.title || "Video meeting"}</h1>
              <label className="meet-label" htmlFor="meet-name">
                Your name
              </label>
              <input
                id="meet-name"
                className="meet-input"
                value={name}
                maxLength={60}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void join();
                }}
                placeholder="Type your name"
              />
              {joinError && <div className="meet-error">{joinError}</div>}
              <button className="meet-join-btn" disabled={phase.kind === "joining"} onClick={() => void join()}>
                {phase.kind === "joining" ? "Joining…" : "Join meeting"}
              </button>
              <p className="meet-fine">No account or download needed — the meeting runs right in your browser.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
