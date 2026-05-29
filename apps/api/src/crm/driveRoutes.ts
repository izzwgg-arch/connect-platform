/**
 * CRM Drive Routes — Phase 1
 *
 * Endpoints for Google Drive integration: connection status, incremental OAuth,
 * folder listing, folder config (save/get/delete), folder access test, and
 * recent file listing for verification.
 *
 * All routes require a valid tenant JWT.
 * Folder config routes additionally verify the tenant owns the referenced
 * GoogleConnection — cross-tenant access returns 403.
 *
 * Drive scope: https://www.googleapis.com/auth/drive.readonly
 * (see driveService.ts for scope rationale)
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { hasCredentialsMasterKey, encryptJson } from "@connect/security";
import {
  DRIVE_READONLY_SCOPE,
  hasDriveScope,
  listDriveFolders,
  listDriveFolderFiles,
  testDriveFolderAccess,
  DriveServiceError,
  type DriveConnectionRow,
} from "./driveService.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return String(v);
}

function base64url(input: string | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hmacSha256(key: string, data: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto");
  return base64url(crypto.createHmac("sha256", key).update(data, "utf8").digest());
}

async function requireAuth(req: any, reply: any) {
  const user = req.user as { sub: string; tenantId: string; role?: string } | undefined;
  if (!user?.sub || !user?.tenantId) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

/** Loads a CrmEmailConnection that belongs to this tenant, with all token fields. */
async function loadConnectionForTenant(
  connectionId: string,
  tenantId: string,
): Promise<DriveConnectionRow | null> {
  return db.crmEmailConnection.findFirst({
    where: { id: connectionId, tenantId },
    select: {
      id: true,
      tenantId: true,
      encryptedAccessToken: true,
      encryptedRefreshToken: true,
      tokenExpiresAt: true,
      scopes: true,
      emailAddress: true,
      displayName: true,
      googleAccountId: true,
    },
  }) as Promise<DriveConnectionRow | null>;
}

/**
 * Finds the best Drive-capable connection for a tenant.
 * Prefers CONNECTED connections that already have the Drive scope.
 * Returns null if no connection has Drive scope yet.
 */
async function findDriveConnection(tenantId: string): Promise<DriveConnectionRow | null> {
  const row = await db.crmEmailConnection.findFirst({
    where: {
      tenantId,
      status: "CONNECTED",
      scopes: { has: DRIVE_READONLY_SCOPE },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      tenantId: true,
      encryptedAccessToken: true,
      encryptedRefreshToken: true,
      tokenExpiresAt: true,
      scopes: true,
      emailAddress: true,
      displayName: true,
      googleAccountId: true,
    },
  });
  return row as DriveConnectionRow | null;
}

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmDriveRoutes(app: FastifyInstance) {
  const cryptoReady = hasCredentialsMasterKey();
  if (!cryptoReady) {
    app.log.warn("CRM Drive routes: CREDENTIALS_MASTER_KEY missing — Drive OAuth will return 503");
  }

  // ── GET /crm/drive/status ─────────────────────────────────────────────────
  // Returns Drive connection status and capability flags for the current tenant.
  // No secrets, no tokens returned.
  app.get("/crm/drive/status", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const { tenantId } = user;

    // Find all connected Google connections for this tenant
    const connections = await db.crmEmailConnection.findMany({
      where: { tenantId, status: "CONNECTED" },
      select: {
        id: true,
        emailAddress: true,
        displayName: true,
        scopes: true,
        status: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Find the folder config (if any)
    const folderConfig = await db.crmDriveFolder.findFirst({
      where: { tenantId, purpose: "LEAD_IMPORT_INBOX" },
      select: {
        id: true,
        folderId: true,
        folderName: true,
        purpose: true,
        googleConnectionId: true,
        updatedAt: true,
      },
    });

    const driveConnection = connections.find((c) => hasDriveScope(c.scopes));
    const gmailConnection = connections.length > 0 ? connections[0] : null;

    return {
      gmailConnected: gmailConnection !== null,
      gmailEmail: gmailConnection?.emailAddress ?? null,
      driveConnected: driveConnection !== null,
      driveEmail: driveConnection?.emailAddress ?? null,
      driveConnectionId: driveConnection?.id ?? null,
      folderConfig: folderConfig
        ? {
            id: folderConfig.id,
            folderId: folderConfig.folderId,
            folderName: folderConfig.folderName,
            purpose: folderConfig.purpose,
            googleConnectionId: folderConfig.googleConnectionId,
            updatedAt: folderConfig.updatedAt,
          }
        : null,
    };
  });

  // ── POST /crm/drive/oauth/start ───────────────────────────────────────────
  // Returns a Google OAuth URL that adds Drive readonly scope incrementally.
  // If the user already has a Gmail connection, this uses the same OAuth app
  // and requests both Gmail + Drive scopes in one consent (incremental auth).
  // Body: { connectionId?: string } — optional existing connection to upgrade.
  app.post("/crm/drive/oauth/start", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    if (!cryptoReady) return reply.status(503).send({ error: "crypto_not_configured" });

    let clientId: string;
    let redirectUri: string;
    try {
      clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
      redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
    } catch {
      return reply.status(503).send({ error: "oauth_not_configured" });
    }

    const body = (req.body as any) || {};
    const existingConnectionId = body?.connectionId ? String(body.connectionId) : null;

    // Verify the connection belongs to this tenant if specified
    if (existingConnectionId) {
      const conn = await db.crmEmailConnection.findFirst({
        where: { id: existingConnectionId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!conn) return reply.status(404).send({ error: "connection_not_found" });
    }

    const payload = {
      tenantId: user.tenantId,
      userId: user.sub,
      purpose: "drive_auth",
      existingConnectionId,
      ts: Date.now(),
      nonce: base64url(Buffer.from(require("crypto").randomBytes(16))),
    };
    const payloadStr = JSON.stringify(payload);
    const sig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadStr);
    const state = base64url(payloadStr) + "." + sig;

    // Request Gmail + Drive scopes together for a complete connection.
    // Using include_granted_scopes=true allows incremental auth — existing
    // Gmail-only connections will be upgraded to include Drive.
    const scopesArr = [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
      DRIVE_READONLY_SCOPE,
    ];

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("scope", scopesArr.join(" "));
    url.searchParams.set("state", state);

    return { url: url.toString() };
  });

  // ── GET /crm/drive/oauth/callback ─────────────────────────────────────────
  // Handles the OAuth callback for Drive auth.
  // Reuses/updates an existing CrmEmailConnection or creates a new one.
  // Always redirects to the Drive settings page on success.
  app.get("/crm/drive/oauth/callback", async (req, reply) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };
      if (!code || !state) return reply.status(400).send({ error: "invalid_callback" });

      const [payloadB64, sig] = String(state).split(".");
      if (!payloadB64 || !sig) return reply.status(400).send({ error: "invalid_state" });
      const payloadJson = Buffer.from(
        payloadB64.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      const expectSig = hmacSha256(process.env.JWT_SECRET || "connect-secret", payloadJson);
      const sigBuf = Buffer.from(sig);
      const expectBuf = Buffer.from(expectSig);
      const sigsMatch =
        sigBuf.length === expectBuf.length &&
        require("crypto").timingSafeEqual(sigBuf, expectBuf);
      if (!sigsMatch) return reply.status(400).send({ error: "invalid_state" });

      const payload = JSON.parse(payloadJson) as {
        tenantId: string;
        userId: string;
        purpose: string;
        existingConnectionId: string | null;
        ts?: number;
      };

      // Validate state age (10-minute window)
      const stateAgeMs = Date.now() - Number(payload.ts || 0);
      if (!Number.isFinite(stateAgeMs) || stateAgeMs < -60_000 || stateAgeMs > 10 * 60_000) {
        return reply.status(400).send({ error: "expired_state" });
      }
      if (!payload.tenantId || !payload.userId || payload.purpose !== "drive_auth") {
        return reply.status(400).send({ error: "invalid_state" });
      }

      let clientId: string;
      let clientSecret: string;
      let redirectUri: string;
      try {
        clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
        clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
        redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
      } catch {
        return reply.status(503).send({ error: "oauth_not_configured" });
      }

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenJson: any = await tokenRes.json();
      if (!tokenRes.ok) {
        return reply.status(502).send({ error: "token_exchange_failed", detail: tokenJson });
      }

      const accessToken = String(tokenJson.access_token || "");
      const refreshToken = String(tokenJson.refresh_token || "");
      const expiresInSec = Number(tokenJson.expires_in || 0);
      const scope = String(tokenJson.scope || "").split(/\s+/).filter(Boolean);
      const tokenExpiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;

      // Fetch Google profile
      const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const profile: any = await profileRes.json().catch(() => ({}));
      const emailAddress = String(profile?.email || "");
      const displayName = String(profile?.name || "");
      const googleAccountId = String(profile?.sub || "");

      const encryptedAccessToken = encryptJson({ accessToken });
      const encryptedRefreshToken = refreshToken
        ? encryptJson({ refreshToken })
        : encryptJson({ refreshToken: null });

      // Upsert the connection — prefer the explicit connectionId if provided,
      // otherwise look for an existing connection for this user/tenant.
      const existingId = payload.existingConnectionId;
      let targetId: string | null = existingId;

      if (!targetId && emailAddress) {
        const existing = await db.crmEmailConnection.findFirst({
          where: {
            tenantId: payload.tenantId,
            emailAddress,
          },
          select: { id: true },
        });
        targetId = existing?.id ?? null;
      }

      if (!targetId) {
        // Check if there's already a USER connection for this user
        const existing = await db.crmEmailConnection.findFirst({
          where: { tenantId: payload.tenantId, userId: payload.userId, scope: "USER" },
          select: { id: true },
        });
        targetId = existing?.id ?? null;
      }

      if (targetId) {
        await db.crmEmailConnection.update({
          where: { id: targetId },
          data: {
            emailAddress: emailAddress || undefined,
            displayName: displayName || undefined,
            googleAccountId: googleAccountId || undefined,
            encryptedAccessToken,
            ...(refreshToken ? { encryptedRefreshToken } : {}),
            tokenExpiresAt,
            scopes: scope,
            status: "CONNECTED",
            lastError: null,
          },
        });
      } else {
        const row = await db.crmEmailConnection.create({
          data: {
            tenantId: payload.tenantId,
            userId: payload.userId,
            scope: "USER",
            managedByUserId: null,
            provider: "GOOGLE_WORKSPACE",
            emailAddress: emailAddress || "",
            displayName: displayName || null,
            googleAccountId: googleAccountId || null,
            encryptedAccessToken,
            encryptedRefreshToken,
            tokenExpiresAt,
            scopes: scope,
            replyTrackingEnabled: false,
            gmailHistoryId: null,
            bodyCacheMode: "METADATA_ONLY",
            bodyCacheRetentionDays: 30,
            status: "CONNECTED",
            lastSyncAt: null,
            lastError: null,
          },
          select: { id: true },
        });
        targetId = row.id;
      }

      await db.auditLog.create({
        data: {
          tenantId: payload.tenantId,
          action: "CRM_DRIVE_CONNECTED",
          entityType: "CrmEmailConnection",
          entityId: targetId || "",
          actorUserId: payload.userId,
          metadata: {
            scopesGranted: scope,
            driveEnabled: scope.includes(DRIVE_READONLY_SCOPE),
          },
        },
      }).catch(() => undefined);

      const portalUrl = (process.env.NEXT_PUBLIC_PORTAL_URL || "").trim();
      const redirectTarget = portalUrl
        ? `${portalUrl.replace(/\/$/, "")}/crm/drive?connected=1`
        : "/crm/drive?connected=1";
      reply.redirect(redirectTarget);
    } catch (e: any) {
      app.log.error({ route: "drive_oauth_callback", err: e?.message || e });
      reply.status(500).send({ error: "oauth_callback_failed" });
    }
  });

  // ── GET /crm/drive/folders ────────────────────────────────────────────────
  // Lists top-level folders from the connected Drive account.
  // Query: ?connectionId=<id> (required if tenant has multiple connections)
  //        ?parentId=<folderId> (optional, for sub-folder browsing)
  //        ?pageToken=<token>
  app.get("/crm/drive/folders", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const { connectionId, parentId, pageToken } = req.query as {
      connectionId?: string;
      parentId?: string;
      pageToken?: string;
    };

    let connection: DriveConnectionRow | null = null;
    if (connectionId) {
      connection = await loadConnectionForTenant(connectionId, user.tenantId);
      if (!connection) return reply.status(404).send({ error: "connection_not_found" });
    } else {
      connection = await findDriveConnection(user.tenantId);
    }

    if (!connection) return reply.status(400).send({ error: "drive_not_connected" });
    if (!hasDriveScope(connection.scopes)) {
      return reply.status(400).send({ error: "drive_scope_missing", detail: "Reconnect to grant Drive access" });
    }

    try {
      const result = await listDriveFolders(connection, {
        parentId: parentId || undefined,
        pageToken: pageToken || undefined,
        maxResults: 50,
      });
      return result;
    } catch (e: any) {
      if (e instanceof DriveServiceError) {
        return reply.status(502).send({ error: e.code, detail: e.message });
      }
      throw e;
    }
  });

  // ── GET /crm/drive/folder-config ─────────────────────────────────────────
  // Returns the saved lead-docs folder config for this tenant.
  app.get("/crm/drive/folder-config", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const row = await db.crmDriveFolder.findFirst({
      where: { tenantId: user.tenantId, purpose: "LEAD_IMPORT_INBOX" },
      select: {
        id: true,
        folderId: true,
        folderName: true,
        purpose: true,
        googleConnectionId: true,
        createdAt: true,
        updatedAt: true,
        googleConnection: {
          select: { emailAddress: true, displayName: true, scopes: true, status: true },
        },
      },
    });

    if (!row) return { folderConfig: null };

    return {
      folderConfig: {
        id: row.id,
        folderId: row.folderId,
        folderName: row.folderName,
        purpose: row.purpose,
        googleConnectionId: row.googleConnectionId,
        connectionEmail: row.googleConnection?.emailAddress ?? null,
        connectionStatus: row.googleConnection?.status ?? null,
        driveAccessValid: hasDriveScope(row.googleConnection?.scopes ?? []),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  });

  // ── POST /crm/drive/folder-config ─────────────────────────────────────────
  // Saves (upserts) the lead-docs folder configuration.
  // Body: { connectionId: string, folderId: string, folderName: string, purpose?: string }
  app.post("/crm/drive/folder-config", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const body = (req.body as any) || {};
    const connectionId = String(body?.connectionId || "").trim();
    const folderId = String(body?.folderId || "").trim();
    const folderName = String(body?.folderName || "").trim();
    const purpose = "LEAD_IMPORT_INBOX"; // Phase 1: only one purpose

    if (!connectionId) return reply.status(400).send({ error: "invalid_payload", detail: "connectionId required" });
    if (!folderId) return reply.status(400).send({ error: "invalid_payload", detail: "folderId required" });
    if (!folderName) return reply.status(400).send({ error: "invalid_payload", detail: "folderName required" });
    if (folderName.length > 500) return reply.status(400).send({ error: "invalid_payload", detail: "folderName too long" });

    // Verify the connection belongs to this tenant and has Drive scope
    const connection = await loadConnectionForTenant(connectionId, user.tenantId);
    if (!connection) return reply.status(404).send({ error: "connection_not_found" });
    if (!hasDriveScope(connection.scopes)) {
      return reply.status(400).send({ error: "drive_scope_missing", detail: "Connection does not have Drive access" });
    }

    const row = await db.crmDriveFolder.upsert({
      where: {
        tenantId_purpose: { tenantId: user.tenantId, purpose },
      },
      create: {
        tenantId: user.tenantId,
        googleConnectionId: connectionId,
        folderId,
        folderName,
        purpose,
      },
      update: {
        googleConnectionId: connectionId,
        folderId,
        folderName,
      },
      select: { id: true, folderId: true, folderName: true, purpose: true, googleConnectionId: true, updatedAt: true },
    });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_DRIVE_FOLDER_SAVED",
        entityType: "CrmDriveFolder",
        entityId: row.id,
        actorUserId: user.sub,
        metadata: { folderId, folderName, purpose },
      },
    }).catch(() => undefined);

    return { ok: true, folderConfig: row };
  });

  // ── DELETE /crm/drive/folder-config ──────────────────────────────────────
  // Removes the saved folder config for this tenant (for a given purpose).
  app.delete("/crm/drive/folder-config", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const existing = await db.crmDriveFolder.findFirst({
      where: { tenantId: user.tenantId, purpose: "LEAD_IMPORT_INBOX" },
      select: { id: true },
    });
    if (!existing) return { ok: true, deleted: 0 };

    await db.crmDriveFolder.delete({ where: { id: existing.id } });

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_DRIVE_FOLDER_REMOVED",
        entityType: "CrmDriveFolder",
        entityId: existing.id,
        actorUserId: user.sub,
      },
    }).catch(() => undefined);

    return { ok: true, deleted: 1 };
  });

  // ── POST /crm/drive/folder-config/test ───────────────────────────────────
  // Tests access to the saved (or a specified) folder.
  // Body: { folderId?: string, connectionId?: string } — uses saved config if omitted.
  app.post("/crm/drive/folder-config/test", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const body = (req.body as any) || {};

    let folderId: string;
    let connection: DriveConnectionRow | null;

    if (body?.folderId && body?.connectionId) {
      // Explicit test — verify connection ownership
      folderId = String(body.folderId);
      connection = await loadConnectionForTenant(String(body.connectionId), user.tenantId);
      if (!connection) return reply.status(404).send({ error: "connection_not_found" });
    } else {
      // Use saved config
      const saved = await db.crmDriveFolder.findFirst({
        where: { tenantId: user.tenantId, purpose: "LEAD_IMPORT_INBOX" },
        select: { folderId: true, googleConnectionId: true },
      });
      if (!saved) return reply.status(400).send({ error: "no_folder_config", detail: "No folder saved yet" });
      folderId = saved.folderId;
      connection = await loadConnectionForTenant(saved.googleConnectionId, user.tenantId);
      if (!connection) return reply.status(400).send({ error: "connection_not_found" });
    }

    if (!hasDriveScope(connection.scopes)) {
      return reply.status(400).send({ error: "drive_scope_missing" });
    }

    try {
      const result = await testDriveFolderAccess(connection, folderId);
      return { ok: result.ok, folderName: result.folderName, fileCount: result.fileCount };
    } catch (e: any) {
      if (e instanceof DriveServiceError) {
        return reply.status(502).send({ error: e.code, detail: e.message });
      }
      throw e;
    }
  });

  // ── GET /crm/drive/folder-config/files ───────────────────────────────────
  // Lists recent files in the saved folder for visual verification.
  // Query: ?limit=<1..20>
  app.get("/crm/drive/folder-config/files", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const limit = Math.min(20, Math.max(1, Number((req.query as any)?.limit ?? 10)));

    const saved = await db.crmDriveFolder.findFirst({
      where: { tenantId: user.tenantId, purpose: "LEAD_IMPORT_INBOX" },
      select: { folderId: true, folderName: true, googleConnectionId: true },
    });
    if (!saved) return reply.status(400).send({ error: "no_folder_config" });

    const connection = await loadConnectionForTenant(saved.googleConnectionId, user.tenantId);
    if (!connection) return reply.status(400).send({ error: "connection_not_found" });
    if (!hasDriveScope(connection.scopes)) {
      return reply.status(400).send({ error: "drive_scope_missing" });
    }

    try {
      const result = await listDriveFolderFiles(connection, saved.folderId, { maxResults: limit });
      return {
        folderName: saved.folderName,
        folderId: saved.folderId,
        files: result.files,
        nextPageToken: result.nextPageToken,
      };
    } catch (e: any) {
      if (e instanceof DriveServiceError) {
        return reply.status(502).send({ error: e.code, detail: e.message });
      }
      throw e;
    }
  });
}
