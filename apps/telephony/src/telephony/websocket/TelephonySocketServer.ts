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
  /** Calling user's owned extension numbers (e.g. ["101","102"]).
   *  Empty for global/admin clients (no per-user filter applied). */
  extensions: string[];
  /** True when this client is global/admin and bypasses per-user filtering. */
  bypassExtensionFilter: boolean;
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
    let userId: string | null = null;
    let bypassExtensionFilter = true;

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as Record<string, unknown>;
      const rawTenantId =
        typeof payload["tenantId"] === "string" ? payload["tenantId"] : null;
      const role =
        typeof payload["role"] === "string" ? payload["role"].toUpperCase() : "";
      userId = typeof payload["sub"] === "string" ? payload["sub"] : null;
      // SUPER_ADMIN and ADMIN users see all tenants — treat as global (tenantId = null)
      // so tenantFilter broadcasts every live call to them regardless of which tenant owns it.
      const isGlobalRole = role === "SUPER_ADMIN" || role === "ADMIN";
      tenantId = isGlobalRole ? null : rawTenantId;
      // Per-user extension filter: bypassed for workspace admins (SUPER_ADMIN,
      // ADMIN, TENANT_ADMIN, MANAGER) — they see all calls in scope. Everyone
      // else is filtered to calls involving one of their owned extensions.
      bypassExtensionFilter =
        role === "SUPER_ADMIN" ||
        role === "TENANT_ADMIN" ||
        role === "ADMIN" ||
        role === "MANAGER";
    } catch {
      ws.close(1008, "Unauthorized");
      this.decrementIpCount(clientIp);
      return;
    }

    const client: WsClient = {
      ws,
      tenantId,
      extensions: [],
      bypassExtensionFilter,
      isAlive: true,
    };
    this.clients.add(client);
    log.info(
      { tenantId, userId, bypassExtensionFilter, ip: clientIp, total: this.clients.size },
      "WS client connected",
    );

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

    // Resolve the user's owned extensions for per-user live-call filtering.
    // The snapshot is sent AFTER this resolves so initial calls are already
    // filtered; subsequent broadcasts also use these extensions.
    if (!bypassExtensionFilter && userId && token && env.API_INTERNAL_URL) {
      this.fetchUserExtensions(token).then(
        (extensions) => {
          client.extensions = extensions;
          log.info(
            { userId, tenantId, extensions, count: extensions.length },
            "WS client extensions resolved",
          );
          this.sendSnapshot(client);
        },
        (err) => {
          log.warn(
            { userId, tenantId, err: err?.message || String(err) },
            "WS client extension fetch failed — sending snapshot without per-user filter",
          );
          // Fail-open: if we can't fetch extensions (API unreachable etc.),
          // fall back to tenant-only filtering rather than breaking the UI.
          client.bypassExtensionFilter = true;
          this.sendSnapshot(client);
        },
      );
    } else {
      // Admin / global-role / no API URL configured → tenant filter only.
      this.sendSnapshot(client);
    }
  }

  // Fetches the calling user's owned extension numbers from Connect API.
  // Used to scope live-call broadcasts to "calls that involve me" for
  // non-admin users. Returns [] on any failure (treated as "no calls").
  private async fetchUserExtensions(token: string): Promise<string[]> {
    const base = (env.API_INTERNAL_URL || "").replace(/\/$/, "");
    if (!base) return [];
    const res = await fetch(`${base}/me/extensions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`/me/extensions http_${res.status}`);
    }
    const body = (await res.json()) as { extensions?: unknown };
    const raw = Array.isArray(body?.extensions) ? body.extensions : [];
    const out: string[] = [];
    for (const v of raw) {
      const n = String(v ?? "").trim();
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
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
    // Per-user extension scoping for the initial snapshot. Admin/global
    // clients (bypassExtensionFilter) always get the full tenant snapshot.
    if (!client.bypassExtensionFilter) {
      if (client.extensions.length === 0) {
        snap.calls = [];
      } else {
        const owned = new Set(client.extensions);
        snap.calls = snap.calls.filter((c) => {
          const callExts = (c as { extensions?: string[] }).extensions ?? [];
          for (const e of callExts) if (owned.has(e)) return true;
          return false;
        });
      }
    }
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
