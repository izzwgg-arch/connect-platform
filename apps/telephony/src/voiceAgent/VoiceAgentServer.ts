/**
 * The AudioSocket TCP server — where the PBX's voice-agent calls arrive.
 *
 * Security model: the port is reachable from the internet (docker-published
 * ports bypass ufw — a documented fact of this host), so the UUID frame is
 * treated as a BEARER TOKEN. A connection must present, within 5 seconds, a
 * UUID that the dialplan announced over AMI moments earlier; anything else is
 * terminated without a word. 128 random bits, single-use, ~60 s lifetime —
 * the same class of credential as a pay-link token. A defense-in-depth
 * iptables DOCKER-USER rule further restricts the port to the PBX's address,
 * but the token gate is the structural lock and must never be removed.
 *
 * Isolation: nothing here touches CallStateStore, the wake machinery, or any
 * other telephony service. A voice-agent fault can cost voice-agent calls
 * only — and those fall through to the dialplan's human fallback.
 */

import net, { type Socket } from "net";
import { childLogger } from "../logging/logger";
import { AudioSocketParser, FRAME_UUID, uuidBytesToString } from "./audioSocketFrames";
import { AnnouncementRegistry, type VoiceAgentAnnouncement } from "./voiceAgentEvents";
import { VoiceAgentApiClient } from "./voiceAgentApiClient";
import { VoiceAgentSession, type VoiceAgentSessionDeps } from "./VoiceAgentSession";

const log = childLogger("VoiceAgentServer");

export interface VoiceAgentServerOptions {
  port: number;
  maxConcurrentSessions?: number;
  registry?: AnnouncementRegistry;
  api?: VoiceAgentApiClient;
  sessionDeps?: Partial<VoiceAgentSessionDeps>;
  /** AMI DBPut for the dialplan transfer flag. */
  dbPut: (family: string, key: string, value: string) => Promise<unknown>;
}

export class VoiceAgentServer {
  readonly registry: AnnouncementRegistry;
  private readonly api: VoiceAgentApiClient;
  private readonly opts: VoiceAgentServerOptions;
  private server: net.Server | null = null;
  private readonly sessions = new Set<VoiceAgentSession>();
  /** Refused-connection counter for the log — a probe storm should be visible. */
  private refusedCount = 0;

  constructor(opts: VoiceAgentServerOptions) {
    this.opts = opts;
    this.registry = opts.registry ?? new AnnouncementRegistry();
    this.api = opts.api ?? new VoiceAgentApiClient();
  }

  start(): void {
    if (this.server) return;
    const server = net.createServer((socket) => this.onConnection(socket));
    server.on("error", (err) => {
      log.error({ err: String(err) }, "voice-agent: TCP server error");
    });
    server.listen(this.opts.port, () => {
      log.info(
        { port: this.opts.port, apiConfigured: this.api.configured },
        "VOICE_AGENT_ARMED — AudioSocket server listening",
      );
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const s of [...this.sessions]) {
      await s.end("socket_error");
    }
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  announce(ann: VoiceAgentAnnouncement): void {
    this.registry.put(ann);
  }

  private onConnection(socket: Socket): void {
    socket.setNoDelay(true);
    const parser = new AudioSocketParser();
    let settled = false;
    const earlyChunks: Buffer[] = [];

    const refuse = (why: string) => {
      if (settled) return;
      settled = true;
      this.refusedCount++;
      log.warn({ why, remote: socket.remoteAddress, refusedTotal: this.refusedCount }, "voice-agent: connection refused");
      VoiceAgentSession.refuse(socket);
    };

    const deadline = setTimeout(() => refuse("uuid_timeout"), 5_000);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      let frames;
      try {
        frames = parser.push(chunk);
      } catch {
        clearTimeout(deadline);
        refuse("garbage_stream");
        return;
      }
      for (const frame of frames) {
        if (frame.type !== FRAME_UUID) {
          // Audio may race ahead of our session setup — keep it for the session.
          continue;
        }
        const uuid = uuidBytesToString(frame.payload);
        if (!uuid) {
          clearTimeout(deadline);
          refuse("bad_uuid_frame");
          return;
        }
        settled = true;
        clearTimeout(deadline);
        socket.off("data", onData);
        void this.adopt(socket, uuid, earlyChunks);
        return;
      }
      // No UUID yet — remember nothing (pre-UUID audio is not a thing Asterisk
      // sends), but cap hostile buffering via the parser's own overflow guard.
    };

    socket.on("data", onData);
    socket.on("error", () => {
      clearTimeout(deadline);
    });
    socket.on("close", () => {
      clearTimeout(deadline);
    });
  }

  private async adopt(socket: Socket, uuid: string, _earlyChunks: Buffer[]): Promise<void> {
    // The AMI announcement and the TCP connection race by design — wait
    // briefly for the announcement before refusing.
    let ann: VoiceAgentAnnouncement | null = null;
    for (let i = 0; i < 25 && !ann; i++) {
      ann = this.registry.take(uuid);
      if (!ann) await sleep(100);
    }
    if (!ann) {
      this.refusedCount++;
      log.warn({ uuid, remote: socket.remoteAddress }, "voice-agent: unknown session uuid — refused");
      VoiceAgentSession.refuse(socket);
      return;
    }
    const cap = this.opts.maxConcurrentSessions ?? 8;
    if (this.sessions.size >= cap) {
      log.warn({ uuid, active: this.sessions.size }, "voice-agent: concurrency cap — refused (call falls to human fallback)");
      VoiceAgentSession.refuse(socket);
      return;
    }

    const startResp = await this.api.sessionStart({
      sessionUuid: uuid,
      pbxTenant: ann.pbxTenant,
      did: ann.did,
      callerNumber: ann.callerNumber,
    });
    if (!startResp.ok) {
      log.info({ uuid, reason: startResp.reason }, "voice-agent: session refused by api — call falls to fallback");
      VoiceAgentSession.refuse(socket);
      return;
    }

    const deps: VoiceAgentSessionDeps = {
      api: this.api,
      setTransferFlag: async (u) => {
        await this.opts.dbPut("connect/va", u, "transfer");
      },
      ...this.opts.sessionDeps,
      onClosed: (s) => {
        this.sessions.delete(s);
        this.opts.sessionDeps?.onClosed?.(s);
      },
    };
    const session = new VoiceAgentSession(socket, ann, startResp, deps);
    this.sessions.add(session);
    session.run();
    log.info(
      { uuid, tenantId: startResp.tenantId, caller: ann.callerNumber, active: this.sessions.size },
      "voice-agent: session started",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
