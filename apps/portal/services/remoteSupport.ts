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
  /**
   * ⛔ Two separate lists, and they are not interchangeable. `Requested` is what
   * the technician asked for and drives which rows the consent dialog SHOWS;
   * `Granted` is what the customer agreed to and is the only one that authorises
   * anything. A screen that reads Requested as permission is the bug this
   * separation exists to make impossible.
   */
  capabilitiesRequested?: string[];
  capabilitiesGranted?: string[];
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

/**
 * The extras a session can carry beyond looking and typing.
 *
 * ⛔ Mirrors REMOTE_CAPABILITIES on the server. `admin` is deliberately absent
 * and must stay absent — elevated control needs a Windows service running as
 * SYSTEM, which this version does not ship, and offering a control that silently
 * would not work is worse than not offering it.
 */
export type RemoteCapability = "view" | "control" | "clipboard" | "files" | "admin";

/** What the screen tells the encoder. Advisory — never a permission. */
export type MediaBudget = {
  maxBitrateKbps: number;
  maxFramerate: number;
  maxHeight: number;
  note: string | null;
};

export type SessionEvent = {
  id: string;
  at: string;
  kind: "system" | "chat";
  code: string;
  actorRole: "ADMIN" | "CLIENT" | "SYSTEM";
  body: string | null;
};

export async function requestSession(input: {
  targetUserId: string;
  reason: string;
  requestControl: boolean;
  capabilities?: RemoteCapability[];
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
  input: {
    allow: boolean;
    allowControl?: boolean;
    allowCapabilities?: RemoteCapability[];
    deviceLabel?: string;
    deviceId?: string;
  },
): Promise<{ ok: boolean; allowed: boolean; session?: RemoteSupportSession }> {
  return apiPost(`/remote-support/sessions/${id}/consent`, input as any);
}

/**
 * ⛔ The customer's heartbeat carries whether a phone call is up, and ONLY the
 * customer's does. The server ignores the claim from the support side, so a
 * technician cannot buy bitrate back on somebody else's machine.
 */
export async function heartbeat(
  id: string,
  input: { callInProgress?: boolean; packetLoss?: number; roundTripMs?: number } = {},
): Promise<{
  ok: boolean;
  role: string;
  canControl: boolean;
  capabilities?: RemoteCapability[];
  mediaBudget?: MediaBudget;
  callInProgress?: boolean;
}> {
  return apiPost(`/remote-support/sessions/${id}/heartbeat`, input as any);
}

/* ─────────────── the transcript, chat, and asking for more ─────────── */

export async function listEvents(id: string, since?: string): Promise<{ events: SessionEvent[] }> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiGet(`/remote-support/sessions/${id}/events${q}`);
}

export async function sendChat(id: string, body: string): Promise<{ ok: boolean }> {
  return apiPost(`/remote-support/sessions/${id}/chat`, { body } as any);
}

/**
 * ⛔ ASKS. DOES NOT GRANT. The server records the request and puts the question
 * back on the customer's screen; `granted` comes back unchanged, deliberately,
 * so a screen cannot render this as success.
 */
export async function requestCapability(
  id: string,
  capability: RemoteCapability,
): Promise<{ ok: boolean; pending: RemoteCapability; granted: RemoteCapability[] }> {
  return apiPost(`/remote-support/sessions/${id}/request-capability`, { capability } as any);
}

/** The customer answering a mid-session request. Only they can call this. */
export async function answerCapability(
  id: string,
  capability: RemoteCapability,
  allow: boolean,
): Promise<{ ok: boolean; granted: RemoteCapability[] }> {
  return apiPost(`/remote-support/sessions/${id}/answer-capability`, { capability, allow } as any);
}

/** Records that a capability was used, as a COUNT. Never the content. */
export async function reportCapabilityUse(
  id: string,
  capability: RemoteCapability,
  count: number,
): Promise<void> {
  await apiPost(`/remote-support/sessions/${id}/use-capability`, { capability, count } as any).catch(() => {});
}

/* ─────────────────── the emergency controls (Phase 30) ────────────── */

export type RemoteSupportControls = {
  controls: { enabled: boolean; disabledReason: string | null };
  revocations: Array<{
    id: string;
    scope: "TECHNICIAN" | "DEVICE" | "TENANT";
    subjectId: string;
    reason: string | null;
    createdAt: string;
    createdByUserId: string;
  }>;
  liveSessions: Array<{
    id: string;
    tenantId: string;
    status: RemoteSupportStatus;
    controlGranted: boolean;
    capabilitiesGranted: string[];
    startedAt: string | null;
    requestedByUserId: string;
    requestedByName: string | null;
    targetUserId: string;
    targetUserName: string | null;
    deviceLabel: string | null;
  }>;
};

export async function getControls(): Promise<RemoteSupportControls> {
  return apiGet("/admin/remote-support/controls");
}

export async function setControls(input: {
  enabled: boolean;
  reason?: string;
}): Promise<{ ok: boolean; controls: RemoteSupportControls["controls"]; sessionsEnded: number }> {
  return apiPost("/admin/remote-support/controls", input as any);
}

export async function addRevocation(input: {
  scope: "TECHNICIAN" | "DEVICE" | "TENANT";
  subjectId: string;
  reason?: string;
}): Promise<{ ok: boolean; sessionsEnded: number }> {
  return apiPost("/admin/remote-support/revocations", input as any);
}

export async function terminateSessions(input: {
  sessionId?: string;
  all?: boolean;
}): Promise<{ ok: boolean; sessionsEnded: number }> {
  return apiPost("/admin/remote-support/terminate", input as any);
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
  /**
   * What the last heartbeat learned. The support side draws it; the customer
   * side APPLIES the budget to its encoder — see `applyBudget`.
   */
  onHeartbeat?: (info: { mediaBudget?: MediaBudget; callInProgress?: boolean; quality: LinkQuality | null }) => void;
};

/** What the receiving end can measure about the link. All optional, all advisory. */
export type LinkQuality = {
  /** 0..1. */
  packetLoss: number | null;
  roundTripMs: number | null;
  kbps: number | null;
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
  private lastPacketsLost = 0;
  private lastPacketsReceived = 0;
  private lastBytes = 0;
  private lastBytesAt = 0;
  private appliedBudget: string | null = null;

  /**
   * ⛔ Answers "is this person on a phone call right now?" — supplied by the
   * CUSTOMER side only, because only their machine knows.
   *
   * Non-negotiable rule 15 (remote support yields to an active call) is enforced
   * on the server by `decideMediaBudget`, which returns the small on-call budget
   * the instant this reads true. Until 2026-08-31 nothing ever set it, so the
   * rule was enforced against an input that never arrived — the whole protection
   * was dead. It is a supplier rather than a constructor value because the
   * answer changes DURING a session, which is exactly when it matters.
   */
  onCall: (() => boolean) | null = null;

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
    this.beatTimer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    void this.beat();
  }

  /**
   * One heartbeat: prove we are still here, and carry what we measured.
   *
   * ⛔ Never allowed to throw. A heartbeat is the liveness signal, and a fault
   * in the OPTIONAL telemetry beside it must not stop the beat — that would
   * make the session look disconnected because a stats read failed.
   */
  private async beat(): Promise<void> {
    let quality: LinkQuality | null = null;
    let onCall: boolean | undefined;
    try {
      quality = await this.readQuality();
    } catch {
      /* stats are advisory; a failed read is not a failed heartbeat */
    }
    try {
      onCall = this.onCall ? this.onCall() : undefined;
    } catch {
      onCall = undefined;
    }

    try {
      const res = await heartbeat(this.sessionId, {
        ...(onCall === undefined ? {} : { callInProgress: onCall }),
        ...(quality?.packetLoss == null ? {} : { packetLoss: quality.packetLoss }),
        ...(quality?.roundTripMs == null ? {} : { roundTripMs: quality.roundTripMs }),
      });
      this.handlers.onHeartbeat?.({
        mediaBudget: res.mediaBudget,
        callInProgress: res.callInProgress,
        quality,
      });
      if (res.mediaBudget) this.applyBudget(res.mediaBudget);
    } catch {
      /* the next beat tries again; the server's stale window is 3 beats wide */
    }
  }

  /**
   * Ask the sender to stay inside the budget the server chose.
   *
   * ⛔ ONLY the customer side can do this — the budget limits an ENCODER, and
   * the support side has no outgoing video track. Calling it there is a silent
   * no-op rather than an error, so a shared code path stays honest.
   *
   * ⛔ Advisory, never a permission. Nothing here decides what may be seen; it
   * decides how much bandwidth is spent showing it. A failure to apply must
   * never end a session.
   */
  private applyBudget(budget: MediaBudget): void {
    if (this.role !== "customer" || !this.pc) return;
    const key = `${budget.maxBitrateKbps}/${budget.maxFramerate}/${budget.maxHeight}`;
    if (key === this.appliedBudget) return; // nothing changed — don't churn the encoder
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      for (const e of params.encodings) {
        e.maxBitrate = budget.maxBitrateKbps * 1000;
        e.maxFramerate = budget.maxFramerate;
      }
      void sender.setParameters(params).then(
        () => { this.appliedBudget = key; },
        () => { /* some browsers refuse mid-negotiation; the next beat retries */ },
      );
    } catch {
      /* never fatal */
    }
  }

  /**
   * What the link looks like from here, from the peer connection's own stats.
   *
   * ⛔ Loss is measured as a DELTA between beats, not a lifetime ratio. A
   * lifetime figure is dominated by the connection's first seconds and would
   * keep reporting a bad link long after it recovered — the budget would then
   * stay clamped for the rest of the session.
   */
  async readQuality(): Promise<LinkQuality | null> {
    if (!this.pc) return null;
    const stats = await this.pc.getStats();
    let lost: number | null = null;
    let received: number | null = null;
    let bytes: number | null = null;
    let rtt: number | null = null;

    stats.forEach((report: any) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        if (typeof report.packetsLost === "number") lost = report.packetsLost;
        if (typeof report.packetsReceived === "number") received = report.packetsReceived;
        if (typeof report.bytesReceived === "number") bytes = report.bytesReceived;
      } else if (report.type === "outbound-rtp" && report.kind === "video") {
        if (typeof report.bytesSent === "number" && bytes == null) bytes = report.bytesSent;
      } else if (report.type === "candidate-pair" && report.state === "succeeded") {
        if (typeof report.currentRoundTripTime === "number") rtt = Math.round(report.currentRoundTripTime * 1000);
      }
    });

    let packetLoss: number | null = null;
    if (lost != null && received != null) {
      const dLost = Math.max(0, lost - this.lastPacketsLost);
      const dRecv = Math.max(0, received - this.lastPacketsReceived);
      this.lastPacketsLost = lost;
      this.lastPacketsReceived = received;
      const total = dLost + dRecv;
      // ⛔ A tiny sample is noise, not a verdict — one lost packet out of three
      // would read as 33% loss and clamp the encoder for no reason.
      if (total >= 30) packetLoss = dLost / total;
    }

    let kbps: number | null = null;
    if (bytes != null) {
      const now = Date.now();
      if (this.lastBytesAt > 0 && now > this.lastBytesAt) {
        const dBytes = Math.max(0, bytes - this.lastBytes);
        kbps = Math.round((dBytes * 8) / (now - this.lastBytesAt));
      }
      this.lastBytes = bytes;
      this.lastBytesAt = now;
    }

    return { packetLoss, roundTripMs: rtt, kbps };
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
