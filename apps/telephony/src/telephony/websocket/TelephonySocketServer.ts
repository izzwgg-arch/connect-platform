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
  private connectionsByIp = new Map<string, number>();
  private readonly MAX_CONNECTIONS_PER_IP = 10;

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

  countMatchingClients(filter?: (client: WsClient) => boolean): number {
    if (!filter) return this.clients.size;
    let n = 0;
    for (const c of this.clients) {
      if (c.isAlive && c.ws.readyState === 1 /* OPEN */ && filter(c)) n++;
    }
    return n;
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.wss.close();
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientIp = req.socket.remoteAddress ?? "unknown";
    const currentCount = this.connectionsByIp.get(clientIp) ?? 0;
    if (currentCount >= this.MAX_CONNECTIONS_PER_IP) {
      log.warn({ ip: clientIp, count: currentCount }, "WS per-IP connection limit exceeded — closing");
      ws.close(1008, "Too many connections");
      return;
    }
    this.connectionsByIp.set(clientIp, currentCount + 1);

    const url = new URL(req.url ?? "/", "http://localhost");
    const token =
      extractBearerToken(req.headers.authorization) ??
      url.searchParams.get("token") ??
      "";

    let tenantId: string | null = null;

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as Record<string, unknown>;
      const rawTenantId =
        typeof payload["tenantId"] === "string" ? payload["tenantId"] : null;
      const role =
        typeof payload["role"] === "string" ? payload["role"].toUpperCase() : "";
      // SUPER_ADMIN and ADMIN users see all tenants — treat as global (tenantId = null)
      // so tenantFilter broadcasts every live call to them regardless of which tenant owns it.
      const isGlobalRole = role === "SUPER_ADMIN" || role === "ADMIN";
      tenantId = isGlobalRole ? null : rawTenantId;
    } catch {
      ws.close(1008, "Unauthorized");
      this.decrementIpCount(clientIp);
      return;
    }

    const client: WsClient = { ws, tenantId, isAlive: true };
    this.clients.add(client);
    log.info({ tenantId, ip: clientIp, total: this.clients.size }, "WS client connected");

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("close", () => {
      this.clients.delete(client);
      this.decrementIpCount(clientIp);
      log.debug({ tenantId, total: this.clients.size }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      log.warn({ err: err.message }, "WS client error");
      this.clients.delete(client);
      this.decrementIpCount(clientIp);
    });

    // Send initial snapshot
    this.sendSnapshot(client);
  }

  private decrementIpCount(ip: string): void {
    const n = this.connectionsByIp.get(ip) ?? 0;
    if (n <= 1) {
      this.connectionsByIp.delete(ip);
    } else {
      this.connectionsByIp.set(ip, n - 1);
    }
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
