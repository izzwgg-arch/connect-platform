import http from "http";
import jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { TelephonyEventEnvelope } from "../types";
import type { SnapshotService } from "../services/SnapshotService";
import type { CrmInboundCallerEnricher } from "../services/CrmInboundCallerEnricher";

const log = childLogger("TelephonySocketServer");

export interface WsClient {
  ws: WebSocket;
  userId: string | null;
  role: string;
  tenantId: string | null;
  extensions: string[];
  isAlive: boolean;
}

export type UserExtensionResolver = (input: {
  userId: string;
  tenantId: string;
  role: string;
}) => Promise<string[]>;

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
  private readonly MAX_CONNECTIONS_PER_IP = 25;

  constructor(
    private readonly server: http.Server,
    private readonly snapshot: SnapshotService,
    private readonly resolveUserExtensions: UserExtensionResolver | null = null,
    private readonly crmEnricher: CrmInboundCallerEnricher | null = null,
  ) {
    this.wss = new WebSocketServer({
      server,
      path: env.TELEPHONY_WS_PATH,
    });

    this.wss.on("connection", (ws, req) => void this.handleConnection(ws, req));
    this.wss.on("error", (err) => log.error({ err: err.message }, "WSS error"));

    this.startHeartbeat();
  }

  // Broadcast a typed event to all matching clients.
  /** Send one event to a single connected client. */
  sendToClient<T>(client: WsClient, eventName: string, data: T): void {
    if (!client.isAlive || client.ws.readyState !== WebSocket.OPEN) return;
    const envelope: TelephonyEventEnvelope<T> = {
      event: eventName,
      ts: new Date().toISOString(),
      data,
    };
    client.ws.send(JSON.stringify(envelope));
  }

  forEachClient(fn: (client: WsClient) => void, filter?: (client: WsClient) => boolean): void {
    for (const client of this.clients) {
      if (!client.isAlive || client.ws.readyState !== WebSocket.OPEN) continue;
      if (filter && !filter(client)) continue;
      fn(client);
    }
  }

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

  broadcastSnapshots(): void {
    for (const client of this.clients) {
      if (!client.isAlive || client.ws.readyState !== WebSocket.OPEN) continue;
      this.sendSnapshot(client);
    }
  }

  broadcastCallSnapshots(): void {
    for (const client of this.clients) {
      if (!client.isAlive || client.ws.readyState !== WebSocket.OPEN) continue;
      this.sendCallSnapshot(client);
    }
  }

  /**
   * Resolve the real client IP. When nginx proxies WebSocket connections, the
   * TCP remote address is always the Docker gateway (172.x.x.x). nginx sets
   * X-Forwarded-For with the real browser IP, so we use that for per-IP limits
   * when the socket arrives from a private/loopback address.
   */
  private getRealClientIp(req: http.IncomingMessage): string {
    const socketIp = req.socket.remoteAddress ?? "unknown";
    const isProxied = /^(127\.|::1$|::ffff:127\.|172\.(1[6-9]|2\d|3[01])\.|10\.)/.test(socketIp);
    if (isProxied) {
      const forwarded = req.headers["x-forwarded-for"];
      if (forwarded) {
        const firstIp = String(forwarded).split(",")[0].trim();
        if (firstIp) return firstIp;
      }
    }
    return socketIp;
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const clientIp = this.getRealClientIp(req);
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
    let userId: string | null = null;
    let role = "";
    let extensions: string[] = [];

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as Record<string, unknown>;
      userId = typeof payload["sub"] === "string" ? payload["sub"] : null;
      const rawTenantId =
        typeof payload["tenantId"] === "string" ? payload["tenantId"] : null;
      role = typeof payload["role"] === "string" ? payload["role"].toUpperCase() : "";
      // SUPER_ADMIN and ADMIN users see all tenants — treat as global (tenantId = null)
      // so tenantFilter broadcasts every live call to them regardless of which tenant owns it.
      const isGlobalRole = role === "SUPER_ADMIN" || role === "ADMIN";
      tenantId = isGlobalRole ? null : rawTenantId;
      // All users see all live calls for their tenant.  Fetch extensions for
      // push-notification matching and future per-user features.
      if (userId && rawTenantId && this.resolveUserExtensions) {
        extensions = await this.resolveUserExtensions({ userId, tenantId: rawTenantId, role });
      }
    } catch {
      ws.close(1008, "Unauthorized");
      this.decrementIpCount(clientIp);
      return;
    }

    const client: WsClient = { ws, userId, role, tenantId, extensions, isAlive: true };
    this.clients.add(client);
    log.info({ tenantId, role, extensionCount: extensions.length, ip: clientIp, total: this.clients.size }, "WS client connected");

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
    void this.buildSnapshotForClient(client).then((snap) => {
      const envelope: TelephonyEventEnvelope = {
        event: "telephony.snapshot",
        ts: new Date().toISOString(),
        data: snap,
      };
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(envelope));
      }
    });
  }

  private sendCallSnapshot(client: WsClient): void {
    void this.buildSnapshotForClient(client).then((snap) => {
      const envelope: TelephonyEventEnvelope = {
        event: "telephony.calls.snapshot",
        ts: new Date().toISOString(),
        data: { calls: snap.calls, health: snap.health },
      };
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(envelope));
      }
    });
  }

  private async buildSnapshotForClient(client: WsClient) {
    const snap = this.snapshot.getSnapshot({
      tenantId: client.tenantId,
      extensions: client.extensions,
    });
    if (!this.crmEnricher?.enabled()) return snap;
    const calls = await this.crmEnricher.enrichCallsForClient(snap.calls, client);
    return { ...snap, calls };
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
