// AgiServer — FastAGI TCP listener. One connection = one inbound call.
// The PBX side needs a single dialplan entry pointing a DID at
// AGI(agi://<loopcom-ip>:<port>) — nothing else runs on the PBX.

import net, { type Server, type Socket } from "net";
import { childLogger } from "../../logging/logger";
import { AgiConnection } from "./AgiConnection";
import { AgiChannel } from "./AgiChannel";

const log = childLogger("AgiServer");

export type AgiCallHandler = (channel: AgiChannel, agiEnv: Record<string, string>) => Promise<void>;

export interface AgiServerConfig {
  port: number;
  bindAddress: string;
  /** Optional allowlist of peer IPs (the PBX). Empty = allow any. */
  allowedPeers: string[];
}

export class AgiServer {
  private readonly cfg: AgiServerConfig;
  private readonly handler: AgiCallHandler;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(cfg: AgiServerConfig, handler: AgiCallHandler) {
    this.cfg = cfg;
    this.handler = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once("error", reject);
      server.listen(this.cfg.port, this.cfg.bindAddress, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log.error({ err }, "AGI server error"));
        log.info(
          { port: this.cfg.port, bind: this.cfg.bindAddress, allowedPeers: this.cfg.allowedPeers },
          "Smart-home FastAGI server listening",
        );
        resolve();
      });
      this.server = server;
    });
  }

  stop(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
  }

  private onConnection(socket: Socket): void {
    const peer = socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    if (this.cfg.allowedPeers.length > 0 && !this.cfg.allowedPeers.includes(peer)) {
      log.warn({ peer }, "Rejected AGI connection from non-allowlisted peer");
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(10 * 60_000, () => socket.destroy());

    const conn = new AgiConnection(socket);
    void (async () => {
      try {
        const agiEnv = await conn.readEnv();
        const channel = new AgiChannel(conn);
        log.info(
          { peer, callerId: channel.callerId || "(withheld)", dnid: agiEnv["agi_dnid"] ?? "" },
          "Smart-home IVR call started",
        );
        await this.handler(channel, agiEnv);
      } catch (err) {
        log.warn({ peer, err: err instanceof Error ? err.message : String(err) }, "AGI call handler ended with error");
      } finally {
        conn.close();
      }
    })();
  }
}
