/**
 * The remote support client, used by both sides.
 *
 * ⛔ THE SCREEN NEVER TOUCHES CONNECT'S SERVERS. The video and every input
 * event ride the peer connection directly between the two browsers. The API
 * carries only the question ("may I connect?"), the answer, and the handful of
 * messages needed to introduce the two peers. That is why there is no recording
 * to leak and nothing to secure at rest — and it is a property to preserve, not
 * an implementation detail.
 *
 * Signalling is short HTTP polling rather than a socket. It runs for a few
 * seconds at the start of a session and then stops, so a socket would be more
 * moving parts for no benefit. Once connected, polling continues only as a
 * cheap liveness heartbeat.
 */
import { apiGet, apiPost } from "./apiClient";
import type { InputCommand } from "../lib/remoteSupportInput";

export type RemoteSupportStatus =
  | "REQUESTED" | "CONSENTED" | "ACTIVE" | "ENDED" | "DECLINED" | "EXPIRED";

export type RemoteSupportSession = {
  id: string;
  tenantId: string;
  status: RemoteSupportStatus;
  controlRequested: boolean;
  controlGranted: boolean;
  requestReason: string;
  deviceLabel: string | null;
  targetUserId: string;
  targetUserName: string | null;
  requestedByUserId: string;
  requestedByName: string | null;
  expiresAt: string;
  consentAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  endedBy: string | null;
  inputEventCount: number;
  createdAt: string;
};

/** How often each side proves it is still there. Must beat the server's 35s window. */
export const HEARTBEAT_MS = 10_000;
/** Signalling poll interval while the connection is being established. */
export const SIGNAL_POLL_MS = 1_000;

export async function requestSession(input: {
  targetUserId: string;
  reason: string;
  requestControl: boolean;
}): Promise<{ ok: boolean; session: RemoteSupportSession }> {
  return apiPost("/remote-support/sessions", input as any);
}

export async function listSessions(limit = 50): Promise<{ sessions: RemoteSupportSession[] }> {
  return apiGet(`/remote-support/sessions?limit=${limit}`);
}

export async function pendingForMe(): Promise<{ sessions: RemoteSupportSession[] }> {
  return apiGet("/remote-support/pending");
}

export async function getSession(id: string): Promise<{ session: RemoteSupportSession }> {
  return apiGet(`/remote-support/sessions/${id}`);
}

export async function answerConsent(
  id: string,
  input: { allow: boolean; allowControl?: boolean; deviceLabel?: string },
): Promise<{ ok: boolean; allowed: boolean; session?: RemoteSupportSession }> {
  return apiPost(`/remote-support/sessions/${id}/consent`, input as any);
}

export async function heartbeat(id: string): Promise<{ ok: boolean; role: string; canControl: boolean }> {
  return apiPost(`/remote-support/sessions/${id}/heartbeat`, {});
}

export async function endSession(id: string): Promise<{ ok: boolean }> {
  return apiPost(`/remote-support/sessions/${id}/end`, {});
}

export async function reportInputCount(id: string, count: number): Promise<void> {
  await apiPost(`/remote-support/sessions/${id}/input`, { count } as any).catch(() => {});
}

async function postSignal(id: string, kind: string, payload: unknown): Promise<void> {
  await apiPost(`/remote-support/sessions/${id}/signal`, { kind, payload } as any);
}

async function drainSignals(
  id: string,
): Promise<{ signals: Array<{ id: string; kind: string; payload: any }>; status: RemoteSupportStatus; controlGranted: boolean }> {
  return apiGet(`/remote-support/sessions/${id}/signal`);
}

/**
 * ICE servers, reused from the softphone's existing endpoint.
 *
 * ⛔ Falls back to a public STUN server rather than to nothing. With no ICE
 * config at all, two machines on different networks simply never connect, and
 * the failure looks like "the session hangs on Connecting" — which is a much
 * harder thing to diagnose than a slow connection.
 */
async function iceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await apiGet<{ iceServers?: RTCIceServer[] }>("/voice/ice-servers");
    if (Array.isArray(res?.iceServers) && res.iceServers.length > 0) return res.iceServers;
  } catch {
    /* fall through */
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

export type PeerHandlers = {
  onStream?: (stream: MediaStream) => void;
  onInput?: (command: InputCommand) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onClosed?: (reason: string) => void;
};

/**
 * One side of a remote support connection.
 *
 * The customer is the "offerer": they have the screen, so they create the
 * connection and attach the video track. The support side answers. Doing it
 * this way round means the customer's machine decides what is shared and can
 * stop it locally without needing the network to agree.
 */
export class RemoteSupportPeer {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pollTimer: any = null;
  private beatTimer: any = null;
  private stopped = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(
    private sessionId: string,
    private role: "customer" | "support",
    private handlers: PeerHandlers = {},
  ) {}

  /** Customer side: start sharing `stream`. Support side: pass nothing. */
  async start(stream?: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    this.pc = pc;

    pc.onconnectionstatechange = () => {
      this.handlers.onStateChange?.(pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.handlers.onClosed?.(pc.connectionState);
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.stopped) return;
      void postSignal(this.sessionId, "ice", event.candidate.toJSON()).catch(() => {});
    };

    if (this.role === "customer") {
      if (!stream) throw new Error("the customer side must supply a screen stream");
      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      // The customer creates the input channel; the support side receives it.
      const channel = pc.createDataChannel("remote-input", { ordered: true });
      this.channel = channel;
      channel.onmessage = (event) => {
        try {
          this.handlers.onInput?.(JSON.parse(String(event.data)));
        } catch {
          /* a malformed frame is dropped, never thrown */
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await postSignal(this.sessionId, "offer", { sdp: offer.sdp, type: offer.type });
    } else {
      pc.ontrack = (event) => {
        if (event.streams?.[0]) this.handlers.onStream?.(event.streams[0]);
      };
      pc.ondatachannel = (event) => {
        this.channel = event.channel;
      };
    }

    this.pollTimer = setInterval(() => void this.poll(), SIGNAL_POLL_MS);
    this.beatTimer = setInterval(() => {
      void heartbeat(this.sessionId).catch(() => {});
    }, HEARTBEAT_MS);
    void heartbeat(this.sessionId).catch(() => {});
  }

  /** Support side: send one input command. No-op unless the channel is open. */
  sendInput(command: InputCommand): boolean {
    if (!this.channel || this.channel.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  get controlChannelOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.pc) return;
    let result;
    try {
      result = await drainSignals(this.sessionId);
    } catch (err: any) {
      // A 409 means the server has ended the session — stop rather than
      // hammering an endpoint that will keep refusing.
      const status = err?.status ?? err?.statusCode;
      if (status === 409 || status === 403 || status === 404) {
        this.handlers.onClosed?.(err?.body?.error || "session_over");
        this.stop();
      }
      return;
    }

    if (result.status === "ENDED" || result.status === "DECLINED" || result.status === "EXPIRED") {
      this.handlers.onClosed?.(result.status.toLowerCase());
      this.stop();
      return;
    }

    for (const signal of result.signals) {
      try {
        await this.applySignal(signal.kind, signal.payload);
      } catch {
        /* one bad signal must not kill the negotiation */
      }
    }
  }

  private async applySignal(kind: string, payload: any): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    if (kind === "offer" && this.role === "support") {
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await postSignal(this.sessionId, "answer", { sdp: answer.sdp, type: answer.type });
      return;
    }

    if (kind === "answer" && this.role === "customer") {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      return;
    }

    if (kind === "ice") {
      // ⛔ Candidates routinely arrive before the description they belong to.
      // Adding one early throws and, if that is allowed to escape, the
      // connection silently never completes.
      if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(payload);
        return;
      }
      await pc.addIceCandidate(payload).catch(() => {});
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) {
      await this.pc?.addIceCandidate(candidate).catch(() => {});
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.beatTimer);
    this.pollTimer = null;
    this.beatTimer = null;
    try { this.channel?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.channel = null;
    this.pc = null;
  }
}

/** True when running inside the Windows desktop shell. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).connectDesktop?.isDesktop);
}

/** The desktop bridge, or null in a plain browser. */
export function desktopBridge(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).connectDesktop ?? null;
}
