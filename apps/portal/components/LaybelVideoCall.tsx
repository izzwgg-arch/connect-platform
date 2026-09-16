"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AnamClient } from "@anam-ai/js-sdk";
import { apiGet, apiPost, ApiError } from "../services/apiClient";
import { LaybelTurns } from "../lib/laybelTurns";
import { LaybelSetup, type LaybelStatus } from "./LaybelSetup";
import { useAppContext } from "../hooks/useAppContext";

type Props = {
  onTurn: (text: string) => Promise<{ reply: string; humanTakeover?: boolean } | undefined>;
  onEnd: () => void;
  onVoiceOnly: () => void;
  onSpeaker: (speaker: ((text: string) => void) | null) => void;
};
type State = "ready" | "connecting" | "connected" | "listening" | "thinking" | "speaking" | "error" | "ended";

/** Anam owns media only. Every user turn goes back to FloatingAssistant.send,
 * with its existing authenticated conversation, permissions, tools and takeover.
 */
export function LaybelVideoCall({ onTurn, onEnd, onVoiceOnly, onSpeaker }: Props) {
  const { backendJwtRole } = useAppContext();
  const [status, setStatus] = useState<LaybelStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiGet<LaybelStatus>("/support/laybel/status").then(value => { if (!cancelled) setStatus(value); }).catch(() => { if (!cancelled) setError("Could not check the video connection. You can continue by voice or chat."); });
    return () => { cancelled = true; };
  }, []);
  const videoId = `laybel-${useId().replace(/:/g, "")}`;
  const video = useRef<HTMLVideoElement>(null);
  const callPanel = useRef<HTMLElement>(null);
  useEffect(() => { callPanel.current?.scrollIntoView({ block: "start" }); }, []);
  const client = useRef<AnamClient | null>(null);
  const turns = useRef<LaybelTurns | null>(null);
  const callbacks = useRef({ onTurn, onSpeaker });
  callbacks.current = { onTurn, onSpeaker };
  const [state, setState] = useState<State>("ready");
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [retry, setRetry] = useState(0);
  const [needsPlay, setNeedsPlay] = useState(false);

  useEffect(() => {
    if (!started) return;
    let disposed = false;
    let stopped = false;
    let mic: MediaStream | null = null;
    let current: AnamClient | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let duration: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timeout); clearTimeout(duration);
      turns.current?.close(); turns.current = null;
      callbacks.current.onSpeaker(null);
      mic?.getTracks().forEach(track => track.stop());
      void current?.stopStreaming().catch(() => {});
      if (client.current === current) client.current = null;
    };
    const fail = (message: string) => {
      if (disposed || stopped) return;
      stop(); setError(message); setState("error");
    };
    setState("connecting"); setError(""); setMuted(false); setNeedsPlay(false);
    timeout = setTimeout(() => fail("The video connection took too long. Retry or continue by voice."), 35_000);
    void (async () => {
      try {
        // Acquire mic before minting a billed session. Passing the stream to the
        // SDK gives us explicit track ownership, including late-permission cleanup.
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (disposed || stopped) { mic.getTracks().forEach(track => track.stop()); return; }
        const { sessionToken, maxSessionSeconds } = await apiPost<{ sessionToken: string; maxSessionSeconds: number }>("/support/laybel/session", {});
        if (disposed || stopped) return;
        const { createClient, AnamEvent } = await import("@anam-ai/js-sdk");
        if (disposed || stopped) return;
        current = createClient(sessionToken);
        client.current = current;
        const talk = async (text: string) => {
          if (disposed || stopped || !current) return;
          setState("speaking");
          await current.talk(text);
        };
        const turnQueue = new LaybelTurns(async text => {
          if (disposed || stopped) return;
          setState("thinking");
          return callbacks.current.onTurn(text);
        }, talk, () => { if (!disposed && !stopped) { setError("That turn could not be completed. Your chat is still here; please try again."); setState("connected"); } },
        () => { if (!disposed && !stopped) { stop(); setState("ended"); setError("A member of support has taken over this conversation. Continue in the chat below."); } });
        turns.current = turnQueue;
        current.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, messages => {
          if (disposed || stopped) return;
          const last = messages[messages.length - 1];
          if (last?.role === "user") void turnQueue.submit(last.id, last.content);
          else if (last?.role === "persona") setState("connected");
        });
        current.addListener(AnamEvent.USER_SPEECH_STARTED, () => {
          if (disposed || stopped) return;
          turnQueue.interrupt(); setState("listening");
          try { current?.interruptPersona(); } catch { /* stream not ready yet */ }
        });
        current.addListener(AnamEvent.CONNECTION_CLOSED, () => fail("The video call disconnected. Retry or continue in this chat."));
        current.addListener(AnamEvent.SESSION_READY, () => {
          if (disposed || stopped) return;
          callbacks.current.onSpeaker(text => { void talk(text).catch(() => fail("Laybel’s audio stopped. Please reconnect.")); });
        });
        await current.streamToVideoElement(videoId, mic);
        if (disposed || stopped) { void current.stopStreaming().catch(() => {}); return; }
        clearTimeout(timeout);
        setState("connected");
        duration = setTimeout(() => { if (!disposed && !stopped) { stop(); setState("ended"); setError("This call has reached its time limit. Your conversation is saved below."); } }, maxSessionSeconds * 1000);
        try { await video.current?.play(); } catch { if (!disposed && !stopped) setNeedsPlay(true); }
        await talk("Hello, I’m Laybel, your Loopcom AI assistant. How can I help you?");
      } catch (e) {
        const body = e instanceof ApiError ? e.body as { message?: string } | null : null;
        const denied = e instanceof DOMException && e.name === "NotAllowedError";
        fail(body?.message || (denied ? "Allow microphone access to start the call, or continue in chat." : "Laybel’s video call could not connect. Retry or continue by voice."));
      } finally {
        if (disposed || stopped) mic?.getTracks().forEach(track => track.stop());
      }
    })();
    const unload = () => stop();
    window.addEventListener("pagehide", unload);
    return () => { disposed = true; stop(); window.removeEventListener("pagehide", unload); };
  }, [retry, videoId, started]);

  const live = !["ready", "connecting", "error", "ended"].includes(state);
  return <section ref={callPanel} aria-label="Video call with Laybel" className="laybel-call">
    {state === "ready" && <div className="laybel-consent">
      <b>Meet Laybel</b>
      <p>Laybel is your AI Assistant, not a person. This call sends your microphone audio and the Assistant’s replies to Anam to animate and voice him. Your camera stays off.</p>
      <button disabled={!status?.available} onClick={() => setStarted(true)}>Start video call</button>
      {status && !status.available && <p>Live video has not been enabled. Voice-only and chat are still available.</p>}
    </div>}
    <div className="laybel-stage" hidden={state === "ready"}>
      <video ref={video} id={videoId} autoPlay playsInline muted={speakerMuted} aria-label="Laybel live avatar" />
      <span className="laybel-badge">Laybel · AI support</span>
      {state === "connecting" && <div className="laybel-overlay" role="status">Connecting to Laybel…</div>}
      {needsPlay && <button className="laybel-play" onClick={() => { void video.current?.play().then(() => setNeedsPlay(false)).catch(() => setError("Your browser is blocking playback. Check this site's audio permission.")); }}>Play call audio</button>}
    </div>
    <p role="status">{state === "ready" ? "Microphone off" : state === "listening" ? "Listening…" : state === "thinking" ? "Checking with your Assistant…" : state === "speaking" ? "Laybel is speaking…" : state === "connected" ? "Connected · speak naturally" : state === "ended" ? "Call ended" : state === "error" ? "Unable to connect" : "Starting your call"}</p>
    {error && <p role="alert">{error}</p>}
    <div className="laybel-controls">
      <button disabled={!live} aria-pressed={muted} onClick={() => {
        try { if (muted) client.current?.unmuteInputAudio(); else client.current?.muteInputAudio(); setMuted(!muted); }
        catch { setError("The microphone control failed. End the call to stop capture."); }
      }}>{muted ? "Unmute" : "Mute"}</button>
      <button disabled={!live} aria-pressed={speakerMuted} onClick={() => setSpeakerMuted(!speakerMuted)}>{speakerMuted ? "Sound on" : "Sound off"}</button>
      {(state === "error" || state === "ended") && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
      <button onClick={onVoiceOnly}>Voice only</button>
      <button onClick={onEnd}>End call</button>
    </div>
    <small>Your microphone audio and spoken replies are processed by Anam for this call. The conversation stays in your Loopcom chat.</small>
    {backendJwtRole === "SUPER_ADMIN" && status && state === "ready" && <LaybelSetup status={status} onSaved={setStatus} />}
    <style jsx>{`
      .laybel-call { flex:0 0 auto; border:1px solid var(--border); border-radius:12px; overflow:hidden; padding:10px; background:var(--panel); }
      .laybel-stage { position:relative; aspect-ratio:16/9; background:#101827; border-radius:8px; overflow:hidden; }
      .laybel-stage[hidden] { display:none; }
      video { display:block; width:100%; height:100%; object-fit:contain; }
      .laybel-badge { position:absolute; left:10px; top:10px; color:white; background:#152438cc; padding:5px 8px; border-radius:7px; font-size:11px; }
      .laybel-overlay { position:absolute; inset:0; display:grid; place-items:center; color:white; }
      .laybel-play { position:absolute; bottom:15px; left:20%; width:60%; }
      p { font-size:12px; margin:8px 0; } small { display:block; font-size:10px; color:var(--text-dim); margin-top:8px; }
      .laybel-controls { display:flex; flex-wrap:wrap; gap:6px; }
      button { border:1px solid var(--border); border-radius:7px; padding:7px 9px; background:var(--panel); color:var(--text); cursor:pointer; font:inherit; font-size:11px; }
      button:disabled { opacity:.45; cursor:default; }
    `}</style>
  </section>;
}
