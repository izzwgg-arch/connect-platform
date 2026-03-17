import http from "http";
import jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonyEventEnvelope } from "../types";
import type { SnapshotService } from "../services/SnapshotService";

const log = childLogger("TelephonySocketServer");

export interface WsClient {
  ws: WebSocket;
  tenantId: string | null;
  isAlive: boolean;
}

// Wraps WebSocketServer with:
//  - JWT authentication on upgrade
//  - Initial snapshot on connect
//  - Heartbeat (ping/pong)
//  - Tenant-scoped subscriptions

export class TelephonySocketServer {
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly server: http.Server,
    private readonly snapshot: SnapshotService,
  ) {
    this.wss = new WebSocketServer({
      server,
      path: env.TELEPHONY_WS_PATH,
    });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => log.error({ err: err.message }, "WSS error"));

    this.startHeartbeat();
  }

  // Broadcast a typed event to all matching clients.
  broadcast<T>(
    eventName: string,
    data: T,
    filter?: (client: WsClient) => boolean,
  ): void {
    const envelope: TelephonyEventEnvelope<T> = {
      event: eventName,
      ts: new Date().toISOString(),
      data,
    };
    const payload = JSON.stringify(envelope);

    for (const client of this.clients) {
      if (!client.isAlive) continue;
      if (filter && !filter(client)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      client.ws.send(payload);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.wss.close();
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token =
      extractBearerToken(req.headers.authorization) ??
      url.searchParams.get("token") ??
      "";

    let tenantId: string | null = null;

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as Record<string, unknown>;
      // Expect the JWT payload to carry an optional tenantId claim
      tenantId =
        typeof payload["tenantId"] === "string" ? payload["tenantId"] : null;
    } catch {
      ws.close(1008, "Unauthorized");
      return;
    }

    const client: WsClient = { ws, tenantId, isAlive: true };
    this.clients.add(client);
    log.info({ tenantId, total: this.clients.size }, "WS client connected");

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("close", () => {
      this.clients.delete(client);
      log.debug({ tenantId, total: this.clients.size }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      log.warn({ err: err.message }, "WS client error");
      this.clients.delete(client);
    });

    // Send initial snapshot
    this.sendSnapshot(client);
  }

  private sendSnapshot(client: WsClient): void {
    const snap = this.snapshot.getSnapshot(client.tenantId);
    const envelope: TelephonyEventEnvelope = {
      event: "telephony.snapshot",
      ts: new Date().toISOString(),
      data: snap,
    };
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(envelope));
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 25_000);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }
}

function extractBearerToken(header?: string): string | null {
  if (!header) return null;
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}
