/**
 * The Remote Desktop client, used by both sides.
 *
 * ⛔ THE SCREEN, THE SOUND, THE MICROPHONE AND THE LOGIN NEVER TOUCH CONNECT'S
 * SERVERS. All of it rides the peer connection. The API carries the request,
 * the machine's acceptance, the handful of signalling messages, the login
 * VERDICT and the heartbeat. Same shape as remote support, deliberately.
 *
 * Two roles:
 *   host   — the computer being reached (the Loopcom app). It carries the machine
 *            key on every call so the server knows it is the machine and not the
 *            owner's other window signed in as the same person.
 *   viewer — the connecting side (an app or a browser tab).
 *
 * ⛔ ONE NEGOTIATION, TRACKS SWAPPED IN LATER. The host offers three transceivers
 * up front — video (sendonly), the computer's sound (sendonly) and the viewer's
 * microphone (recvonly) — with NO tracks attached. Nothing is shared at accept
 * time. Only once the login is verified does the host `replaceTrack` the screen
 * (and sound) in, which needs no renegotiation; the viewer attaches its
 * microphone the same way. A single offer/answer, and a machine that shows its
 * screen only after the password was right.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "./apiClient";
import type { InputCommand } from "../lib/remoteSupportInput";
import { parseMachineFrame, parseViewerFrame, type MachineFrame, type ViewerFrame } from "../lib/remoteDesktop";

export const HEARTBEAT_MS = 10_000;
export const SIGNAL_POLL_MS = 1_000;
/** How often an enrolled, switched-on machine asks whether anyone is connecting. */
export const MACHINE_POLL_MS = 5_000;

export const MACHINE_KEY_HEADER = "x-machine-key";

export type RemoteDesktopMe = {
  canUseRemoteDesktop: boolean;
  canConnectById: boolean;
  canShareOwnComputer: boolean;
  fromDesktopApp: boolean;
};

export type Machine = {
  id: string;
  name: string;
  connectId: string;
  connectIdDisplay: string;
  deviceId: string;
  osLabel: string | null;
  monitors: number;
  appVersion: string | null;
  unattendedEnabled: boolean;
  hasAccessLogin: boolean;
  locked: boolean;
  online: boolean;
  lastSeenAt: string | null;
  activeShares: number;
  standingShares: number;
  createdAt: string;
};

export type DesktopSessionStatus = "REQUESTED" | "CONSENTED" | "ACTIVE" | "ENDED" | "DECLINED" | "EXPIRED";

export type DesktopSession = {
  id: string;
  kind: "support" | "desktop";
  status: DesktopSessionStatus;
  machineId: string | null;
  machineName: string | null;
  shareId: string | null;
  authRequired: boolean;
  clientAuthenticated: boolean;
  capabilitiesGranted: string[];
  requestedByUserId: string;
  requestedByName: string | null;
  targetUserId: string;
  ownerName: string | null;
  viewerLabel: string | null;
  clientOnCall: boolean;
  expiresAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  endedBy: string | null;
  inputEventCount: number;
  createdAt: string;
  /** History only. */
  connectedFrom?: string | null;
  soundUsed?: boolean;
  micUsed?: boolean;
};

export type Share = {
  id: string;
  scope: "company" | "anyone";
  oneTime: boolean;
  expiresAt: string | null;
  allowControl: boolean;
  allowSound: boolean;
  allowMic: boolean;
  allowClipboard: boolean;
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
};

export type MediaBudget = { maxBitrateKbps: number; maxFramerate: number; maxHeight: number; note: string | null };
export type LinkQuality = { packetLoss: number | null; roundTripMs: number | null; kbps: number | null };
export type SessionEvent = { id: string; at: string; kind: "system" | "chat"; code: string; actorRole: string; body: string | null };

/* ─────────────────────────── viewer side ──────────────────────────── */

export async function me(): Promise<RemoteDesktopMe> {
  return apiGet("/remote-desktop/me");
}
export async function listMachines(): Promise<{ machines: Machine[] }> {
  return apiGet("/remote-desktop/machines");
}
export async function renameMachine(id: string, name: string): Promise<{ ok: boolean; machine: Machine }> {
  return apiPatch(`/remote-desktop/machines/${id}`, { name } as any);
}
export async function removeMachine(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/remote-desktop/machines/${id}`);
}
export async function connectToMachine(id: string, input: { capabilities: string[]; fromLabel: string }): Promise<{ ok: boolean; session: DesktopSession }> {
  return apiPost(`/remote-desktop/machines/${id}/connect`, input as any, undefined, { timeoutMs: 20_000 });
}
export async function connectById(input: { connectId: string; password: string; capabilities: string[]; fromLabel: string }): Promise<{ ok: boolean; session: DesktopSession }> {
  return apiPost("/remote-desktop/connect-by-id", input as any, undefined, { timeoutMs: 20_000 });
}
export async function listShares(machineId: string): Promise<{ shares: Share[] }> {
  return apiGet(`/remote-desktop/machines/${machineId}/shares`);
}
export async function createShare(machineId: string, input: { expiry: "once" | "24h" | "standing"; scope: "company" | "anyone"; allowControl: boolean; allowSound: boolean; allowMic: boolean; allowClipboard: boolean }): Promise<{ ok: boolean; share: Share; password: string; connectId: string; connectIdDisplay: string }> {
  return apiPost(`/remote-desktop/machines/${machineId}/shares`, input as any);
}
export async function revokeShare(machineId: string, shareId: string): Promise<{ ok: boolean }> {
  return apiPost(`/remote-desktop/machines/${machineId}/shares/${shareId}/revoke`, {});
}
export async function history(limit = 30): Promise<{ sessions: DesktopSession[] }> {
  return apiGet(`/remote-desktop/history?limit=${limit}`);
}
export async function getSession(id: string, machineKey?: string): Promise<{ session: DesktopSession }> {
  return apiGet(`/remote-desktop/sessions/${id}`, undefined, machineKey ? { headers: { [MACHINE_KEY_HEADER]: machineKey } } : {});
}
export async function listEvents(id: string, since?: string, machineKey?: string): Promise<{ events: SessionEvent[] }> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiGet(`/remote-desktop/sessions/${id}/events${q}`, undefined, machineKey ? { headers: { [MACHINE_KEY_HEADER]: machineKey } } : {});
}
export async function endSession(id: string, machineKey?: string): Promise<{ ok: boolean }> {
  return apiPost(`/remote-desktop/sessions/${id}/end`, {}, undefined, machineKey ? { headers: { [MACHINE_KEY_HEADER]: machineKey } } : {});
}
export async function reportInputCount(id: string, count: number): Promise<void> {
  await apiPost(`/remote-desktop/sessions/${id}/input`, { count } as any).catch(() => {});
}
export async function reportAudio(id: string, sound: boolean, mic: boolean): Promise<void> {
  await apiPost(`/remote-desktop/sessions/${id}/audio`, { sound, mic } as any).catch(() => {});
}

/* ─────────────────────────── host side ────────────────────────────── */

const hostHeaders = (machineKey: string) => ({ headers: { [MACHINE_KEY_HEADER]: machineKey } });

export async function registerMachine(machineKey: string, input: { deviceId: string; name: string; osLabel: string; monitors: number; appVersion: string; unattendedEnabled: boolean; hasAccessLogin: boolean; locked: boolean }): Promise<{ ok: boolean; machine: Machine }> {
  return apiPost("/remote-desktop/machines/register", input as any, undefined, hostHeaders(machineKey));
}
export async function pollMachine(machineKey: string, input: { deviceId: string; unattendedEnabled: boolean; hasAccessLogin: boolean; locked: boolean; monitors: number }): Promise<{ ok: boolean; connectId: string; connectIdDisplay: string; sessions: DesktopSession[] }> {
  return apiPost("/remote-desktop/machines/poll", input as any, undefined, hostHeaders(machineKey));
}
export async function acceptSession(id: string, machineKey: string): Promise<{ ok: boolean; session: DesktopSession }> {
  return apiPost(`/remote-desktop/sessions/${id}/accept`, {}, undefined, hostHeaders(machineKey));
}
export async function reportLoginResult(id: string, machineKey: string, input: { ok: boolean; attemptsLeft?: number; locked?: boolean }): Promise<{ ok: boolean; ended?: boolean }> {
  return apiPost(`/remote-desktop/sessions/${id}/login-result`, input as any, undefined, hostHeaders(machineKey));
}

async function heartbeat(id: string, body: Record<string, unknown>, machineKey?: string) {
  return apiPost<{
    ok: boolean; role: "VIEWER" | "MACHINE"; status: DesktopSessionStatus; capabilities: string[];
    clientAuthenticated: boolean; canControl: boolean; mediaBudget?: MediaBudget; callInProgress?: boolean; locked?: boolean;
  }>(`/remote-desktop/sessions/${id}/heartbeat`, body as any, undefined, machineKey ? hostHeaders(machineKey) : {});
}
async function postSignal(id: string, kind: string, payload: unknown, machineKey?: string) {
  await apiPost(`/remote-desktop/sessions/${id}/signal`, { kind, payload } as any, undefined, machineKey ? hostHeaders(machineKey) : {});
}
async function drainSignals(id: string, machineKey?: string) {
  return apiGet<{ signals: Array<{ id: string; kind: string; payload: any }>; status: DesktopSessionStatus; clientAuthenticated: boolean; capabilities: string[] }>(
    `/remote-desktop/sessions/${id}/signal`, undefined, machineKey ? hostHeaders(machineKey) : {},
  );
}

/** ICE servers — the platform's own relay, the same one the softphone uses. */
async function iceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await apiGet<{ iceServers?: RTCIceServer[] }>("/voice/ice-servers");
    if (Array.isArray(res?.iceServers) && res.iceServers.length > 0) return res.iceServers;
  } catch { /* fall through */ }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

export type PeerHandlers = {
  /** Viewer: the host's screen (+ its sound) arrived. */
  onStream?: (stream: MediaStream) => void;
  /** Host: the viewer's microphone arrived. */
  onMicStream?: (stream: MediaStream) => void;
  /** Host: an input command from the viewer. */
  onInput?: (command: InputCommand) => void;
  /** Host: a control-channel frame from the viewer. */
  onViewerFrame?: (frame: ViewerFrame) => void;
  /** Viewer: a control-channel frame from the host. */
  onMachineFrame?: (frame: MachineFrame) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onClosed?: (reason: string) => void;
  onHeartbeat?: (info: { status: DesktopSessionStatus; clientAuthenticated: boolean; capabilities: string[]; mediaBudget?: MediaBudget; callInProgress?: boolean; locked?: boolean; quality: LinkQuality | null }) => void;
  /** Which route ICE settled on, once known: "direct" or "relay". */
  onRoute?: (route: "direct" | "relay" | null) => void;
};

/**
 * One side of a Remote Desktop connection.
 *
 * The HOST offers; the VIEWER answers. Both sides pre-allocate their
 * transceivers so no renegotiation is ever needed.
 */
export class RemoteDesktopPeer {
  private pc: RTCPeerConnection | null = null;
  private inputChannel: RTCDataChannel | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private pollTimer: any = null;
  private beatTimer: any = null;
  private stopped = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private videoSender: RTCRtpSender | null = null;
  private soundSender: RTCRtpSender | null = null;
  private micSender: RTCRtpSender | null = null;
  private lastPacketsLost = 0;
  private lastPacketsReceived = 0;
  private lastBytes = 0;
  private lastBytesAt = 0;
  private appliedBudget: string | null = null;
  private routeReported: "direct" | "relay" | null = null;

  /** Host only: is this computer on a phone call right now? */
  onCall: (() => boolean) | null = null;
  /** Host only: is Windows locked right now? */
  isLocked: (() => boolean) | null = null;

  constructor(
    private sessionId: string,
    private role: "host" | "viewer",
    private handlers: PeerHandlers = {},
    /** Host only. */
    private machineKey?: string,
  ) {}

  async start(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    this.pc = pc;

    pc.onconnectionstatechange = () => {
      this.handlers.onStateChange?.(pc.connectionState);
      if (pc.connectionState === "connected") void this.reportRoute();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.handlers.onClosed?.(pc.connectionState);
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.stopped) return;
      void postSignal(this.sessionId, "ice", event.candidate.toJSON(), this.machineKey).catch(() => {});
    };

    if (this.role === "host") {
      // Screen and the computer's sound: OUT. The viewer's microphone: IN.
      // ⛔ No tracks attached yet — the screen is added only after the login.
      this.videoSender = pc.addTransceiver("video", { direction: "sendonly" }).sender;
      this.soundSender = pc.addTransceiver("audio", { direction: "sendonly" }).sender;
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (event) => {
        if (event.track.kind === "audio") this.handlers.onMicStream?.(event.streams?.[0] ?? new MediaStream([event.track]));
      };

      this.inputChannel = pc.createDataChannel("remote-input", { ordered: true });
      this.inputChannel.onmessage = (event) => {
        try { this.handlers.onInput?.(JSON.parse(String(event.data))); } catch { /* dropped */ }
      };
      this.controlChannel = pc.createDataChannel("rd-control", { ordered: true });
      this.controlChannel.onmessage = (event) => {
        const frame = parseViewerFrame(String(event.data));
        if (frame) this.handlers.onViewerFrame?.(frame);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await postSignal(this.sessionId, "offer", { sdp: offer.sdp, type: offer.type }, this.machineKey);
    } else {
      pc.ontrack = (event) => {
        if (event.streams?.[0]) this.handlers.onStream?.(event.streams[0]);
      };
      pc.ondatachannel = (event) => {
        if (event.channel.label === "remote-input") this.inputChannel = event.channel;
        if (event.channel.label === "rd-control") {
          this.controlChannel = event.channel;
          event.channel.onmessage = (ev) => {
            const frame = parseMachineFrame(String(ev.data));
            if (frame) this.handlers.onMachineFrame?.(frame);
          };
        }
      };
    }

    this.pollTimer = setInterval(() => void this.poll(), SIGNAL_POLL_MS);
    this.beatTimer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    void this.beat();
  }

  /** Host: start sending the screen (and, when granted, the computer's sound). */
  async attachScreen(stream: MediaStream): Promise<void> {
    const video = stream.getVideoTracks()[0] ?? null;
    const audio = stream.getAudioTracks()[0] ?? null;
    if (this.videoSender && video) await this.videoSender.replaceTrack(video).catch(() => {});
    if (this.soundSender && audio) await this.soundSender.replaceTrack(audio).catch(() => {});
  }

  /** Host: stop sending the computer's sound (the viewer chose "sound → there"). */
  async setSoundEnabled(on: boolean): Promise<void> {
    const track = this.soundSender?.track;
    if (track) track.enabled = on;
  }

  /** Viewer: send (or stop sending) the local microphone. */
  async attachMicrophone(stream: MediaStream | null): Promise<void> {
    if (!this.pc) return;
    if (!this.micSender) {
      // The host offered a recvonly audio m-line for this; our side of it is the
      // transceiver whose sender has no track and whose receiver track is not the
      // computer's sound. Pick the audio transceiver whose direction lets us send.
      const t = this.pc.getTransceivers().find((tr) => tr.receiver.track.kind === "audio" && (tr.currentDirection === "sendonly" || tr.direction === "sendonly" || tr.direction === "sendrecv"))
        ?? this.pc.getTransceivers().filter((tr) => tr.receiver.track.kind === "audio").pop();
      if (!t) return;
      this.micSender = t.sender;
    }
    await this.micSender.replaceTrack(stream?.getAudioTracks()[0] ?? null).catch(() => {});
  }

  /** Viewer → host, or host → viewer, over the control channel. */
  sendFrame(frame: ViewerFrame | MachineFrame): boolean {
    if (!this.controlChannel || this.controlChannel.readyState !== "open") return false;
    try { this.controlChannel.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  /** Viewer: one input command. No-op unless the channel is open. */
  sendInput(command: InputCommand): boolean {
    if (!this.inputChannel || this.inputChannel.readyState !== "open") return false;
    try { this.inputChannel.send(JSON.stringify(command)); return true; } catch { return false; }
  }

  get controlChannelOpen(): boolean {
    return this.controlChannel?.readyState === "open";
  }

  private async beat(): Promise<void> {
    let quality: LinkQuality | null = null;
    try { quality = await this.readQuality(); } catch { /* advisory */ }
    const body: Record<string, unknown> = {};
    if (this.role === "host") {
      try { if (this.onCall) body.callInProgress = this.onCall(); } catch { /* noop */ }
      try { if (this.isLocked) body.locked = this.isLocked(); } catch { /* noop */ }
    }
    if (quality?.packetLoss != null) body.packetLoss = quality.packetLoss;
    if (quality?.roundTripMs != null) body.roundTripMs = quality.roundTripMs;
    try {
      const res = await heartbeat(this.sessionId, body, this.machineKey);
      this.handlers.onHeartbeat?.({ status: res.status, clientAuthenticated: res.clientAuthenticated, capabilities: res.capabilities ?? [], mediaBudget: res.mediaBudget, callInProgress: res.callInProgress, locked: res.locked, quality });
      if (res.mediaBudget) this.applyBudget(res.mediaBudget);
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode;
      if (status === 409 || status === 403 || status === 404) {
        this.handlers.onClosed?.(err?.body?.error || "session_over");
        this.stop();
      }
    }
  }

  private applyBudget(budget: MediaBudget): void {
    if (this.role !== "host" || !this.videoSender) return;
    const key = `${budget.maxBitrateKbps}/${budget.maxFramerate}/${budget.maxHeight}`;
    if (key === this.appliedBudget) return;
    try {
      const params = this.videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      for (const e of params.encodings) { e.maxBitrate = budget.maxBitrateKbps * 1000; e.maxFramerate = budget.maxFramerate; }
      void this.videoSender.setParameters(params).then(() => { this.appliedBudget = key; }, () => {});
    } catch { /* never fatal */ }
  }

  private async reportRoute(): Promise<void> {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let selected: any = null;
      const locals = new Map<string, any>();
      stats.forEach((r: any) => {
        if (r.type === "local-candidate") locals.set(r.id, r);
        if (r.type === "candidate-pair" && (r.selected || r.nominated) && r.state === "succeeded") selected = r;
      });
      const local = selected ? locals.get(selected.localCandidateId) : null;
      const route: "direct" | "relay" | null = local ? (local.candidateType === "relay" ? "relay" : "direct") : null;
      if (route !== this.routeReported) { this.routeReported = route; this.handlers.onRoute?.(route); }
    } catch { /* advisory */ }
  }

  async readQuality(): Promise<LinkQuality | null> {
    if (!this.pc) return null;
    const stats = await this.pc.getStats();
    let lost: number | null = null, received: number | null = null, bytes: number | null = null, rtt: number | null = null;
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
      this.lastPacketsLost = lost; this.lastPacketsReceived = received;
      const total = dLost + dRecv;
      // ⛔ A tiny sample is noise, not a verdict.
      if (total >= 30) packetLoss = dLost / total;
    }
    let kbps: number | null = null;
    if (bytes != null) {
      const now = Date.now();
      if (this.lastBytesAt > 0 && now > this.lastBytesAt) kbps = Math.round((Math.max(0, bytes - this.lastBytes) * 8) / (now - this.lastBytesAt));
      this.lastBytes = bytes; this.lastBytesAt = now;
    }
    return { packetLoss, roundTripMs: rtt, kbps };
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.pc) return;
    let result;
    try {
      result = await drainSignals(this.sessionId, this.machineKey);
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode;
      if (status === 409 || status === 403 || status === 404) { this.handlers.onClosed?.(err?.body?.error || "session_over"); this.stop(); }
      return;
    }
    if (result.status === "ENDED" || result.status === "DECLINED" || result.status === "EXPIRED") {
      this.handlers.onClosed?.(result.status.toLowerCase());
      this.stop();
      return;
    }
    for (const signal of result.signals) {
      try { await this.applySignal(signal.kind, signal.payload); } catch { /* one bad signal must not kill the negotiation */ }
    }
  }

  private async applySignal(kind: string, payload: any): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (kind === "offer" && this.role === "viewer") {
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await postSignal(this.sessionId, "answer", { sdp: answer.sdp, type: answer.type });
      return;
    }
    if (kind === "answer" && this.role === "host") {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      return;
    }
    if (kind === "ice") {
      if (!this.remoteDescriptionSet) { this.pendingCandidates.push(payload); return; }
      await pc.addIceCandidate(payload).catch(() => {});
    }
  }

  private async flushCandidates(): Promise<void> {
    for (const c of this.pendingCandidates.splice(0)) await this.pc?.addIceCandidate(c).catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer); clearInterval(this.beatTimer);
    this.pollTimer = null; this.beatTimer = null;
    try { this.inputChannel?.close(); } catch { /* closed */ }
    try { this.controlChannel?.close(); } catch { /* closed */ }
    try { this.pc?.close(); } catch { /* closed */ }
    this.inputChannel = null; this.controlChannel = null; this.pc = null;
  }
}

/** The desktop bridge, or null in a plain browser. */
export function desktopBridge(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).connectDesktop ?? null;
}

export function isDesktopShell(): boolean {
  return Boolean(desktopBridge()?.isDesktop);
}
