/**
 * CRM Drive Service — Phase 1
 *
 * Handles Google Drive API calls on behalf of a connected CrmEmailConnection
 * that has the Drive readonly scope.
 *
 * Scope used: https://www.googleapis.com/auth/drive.readonly
 * Rationale: drive.metadata.readonly does not support files.list with folder
 * traversal. drive.readonly is the narrowest scope that covers listing folders,
 * listing files within a folder, and reading file metadata without content.
 * Using drive.readonly now avoids a second incremental re-auth when file
 * download capability lands in Phase 2.
 *
 * SECURITY rules:
 * - Tokens are NEVER logged or returned to callers.
 * - Only file metadata is surfaced (name, id, mimeType, size, modifiedTime).
 * - The caller must already have verified tenant ownership of the connection.
 */

import { decryptJson, encryptJson } from "@connect/security";
import { db } from "@connect/db";

// ── Constants ────────────────────────────────────────────────────────────────

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Fields returned for every Drive file/folder listing. Strict allowlist — never returns content. */
const DRIVE_FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink";

/** mimeType for Google Drive folders. */
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  createdTime: string | null;
  parents: string[];
  webViewLink: string | null;
}

export interface DriveFolderEntry {
  id: string;
  name: string;
  modifiedTime: string | null;
}

export interface DriveConnectionRow {
  id: string;
  tenantId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date | null;
  scopes: string[];
  emailAddress: string;
  displayName: string | null;
  googleAccountId: string | null;
}

// ── Capability check ─────────────────────────────────────────────────────────

/** Returns true when the connection's granted scopes include Drive readonly. */
export function hasDriveScope(scopes: string[]): boolean {
  return scopes.includes(DRIVE_READONLY_SCOPE);
}

// ── Token management ─────────────────────────────────────────────────────────

/**
 * Returns a valid, non-expired access token for the given connection.
 * Refreshes automatically when the token is within 60 seconds of expiry.
 * Updates the encrypted token in DB after a refresh.
 *
 * NEVER returns the token in any log statement.
 */
export async function getDriveAccessToken(connection: DriveConnectionRow): Promise<string> {
  const needsRefresh =
    !connection.tokenExpiresAt ||
    connection.tokenExpiresAt.getTime() - Date.now() < 60_000;

  if (!needsRefresh) {
    const payload = decryptJson<{ accessToken?: string }>(connection.encryptedAccessToken);
    if (payload?.accessToken) return payload.accessToken;
  }

  // Refresh the token
  const refreshPayload = decryptJson<{ refreshToken?: string }>(connection.encryptedRefreshToken);
  const refreshToken = refreshPayload?.refreshToken;
  if (!refreshToken) {
    throw new DriveServiceError("no_refresh_token", "Google connection has no refresh token — reconnect required");
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new DriveServiceError("oauth_not_configured", "Google OAuth credentials not configured");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const json: any = await res.json();
  if (!res.ok) {
    // Map Google error codes to our error codes
    const googleError = String(json?.error || "");
    if (googleError === "invalid_grant") {
      // Mark connection as needing re-auth — fire-and-forget
      db.crmEmailConnection.update({
        where: { id: connection.id },
        data: { status: "ERROR", lastError: "token_revoked" },
      }).catch(() => undefined);
      throw new DriveServiceError("token_revoked", "Drive token revoked — reconnect required");
    }
    throw new DriveServiceError("token_refresh_failed", `Token refresh failed: ${googleError}`);
  }

  const newAccessToken = String(json.access_token || "");
  const expiresIn = Number(json.expires_in || 3600);
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);
  const scope = String(json.scope || "").split(/\s+/).filter(Boolean);

  // Persist updated token (do not await — best-effort; next request will refresh again if needed)
  db.crmEmailConnection.update({
    where: { id: connection.id },
    data: {
      encryptedAccessToken: encryptJson({ accessToken: newAccessToken }),
      tokenExpiresAt: newExpiresAt,
      ...(scope.length > 0 ? { scopes: scope } : {}),
      lastError: null,
    },
  }).catch(() => undefined);

  return newAccessToken;
}

// ── Drive API helpers ────────────────────────────────────────────────────────

/**
 * Lists all folders at the root "My Drive" level (or under a parent folder if given).
 * Returns only folders (mimeType = application/vnd.google-apps.folder).
 */
export async function listDriveFolders(
  connection: DriveConnectionRow,
  opts: { parentId?: string; pageToken?: string; maxResults?: number } = {},
): Promise<{ folders: DriveFolderEntry[]; nextPageToken: string | null }> {
  const accessToken = await getDriveAccessToken(connection);
  const parentClause = opts.parentId
    ? `'${opts.parentId}' in parents`
    : `'root' in parents`;
  const q = `${parentClause} and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`;

  const params = new URLSearchParams({
    q,
    fields: `nextPageToken,files(id,name,modifiedTime)`,
    pageSize: String(Math.min(opts.maxResults ?? 50, 100)),
    orderBy: "name",
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new DriveServiceError(
      "drive_api_error",
      `Drive API listFolders failed: ${res.status} ${err?.error?.message || "unknown"}`,
    );
  }

  const json: any = await res.json();
  const folders: DriveFolderEntry[] = (json.files || []).map((f: any) => ({
    id: String(f.id || ""),
    name: String(f.name || ""),
    modifiedTime: f.modifiedTime ? String(f.modifiedTime) : null,
  }));

  return {
    folders,
    nextPageToken: json.nextPageToken ? String(json.nextPageToken) : null,
  };
}

/**
 * Lists files inside a specific folder. Does NOT recurse into sub-folders.
 * Returns file metadata only — no content.
 */
export async function listDriveFolderFiles(
  connection: DriveConnectionRow,
  folderId: string,
  opts: { pageToken?: string; maxResults?: number; mimeTypeFilter?: string } = {},
): Promise<{ files: DriveFileMetadata[]; nextPageToken: string | null }> {
  const accessToken = await getDriveAccessToken(connection);

  let q = `'${folderId}' in parents and trashed = false`;
  if (opts.mimeTypeFilter) {
    q += ` and mimeType = '${opts.mimeTypeFilter}'`;
  }

  const params = new URLSearchParams({
    q,
    fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
    pageSize: String(Math.min(opts.maxResults ?? 20, 50)),
    orderBy: "modifiedTime desc",
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new DriveServiceError(
      "drive_api_error",
      `Drive API listFiles failed: ${res.status} ${err?.error?.message || "unknown"}`,
    );
  }

  const json: any = await res.json();
  const files: DriveFileMetadata[] = (json.files || []).map((f: any) =>
    normalizeFileMetadata(f),
  );

  return {
    files,
    nextPageToken: json.nextPageToken ? String(json.nextPageToken) : null,
  };
}

/**
 * Fetches metadata for a single Drive file by ID.
 * Does NOT fetch content.
 */
export async function getDriveFileMetadata(
  connection: DriveConnectionRow,
  fileId: string,
): Promise<DriveFileMetadata> {
  const accessToken = await getDriveAccessToken(connection);

  const params = new URLSearchParams({ fields: DRIVE_FILE_FIELDS });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 404) {
    throw new DriveServiceError("file_not_found", `Drive file ${fileId} not found`);
  }
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new DriveServiceError(
      "drive_api_error",
      `Drive API getFile failed: ${res.status} ${err?.error?.message || "unknown"}`,
    );
  }

  const json: any = await res.json();
  return normalizeFileMetadata(json);
}

/**
 * Tests access to a folder by attempting to list one file inside it.
 * Returns { ok: true, folderName } on success.
 */
export async function testDriveFolderAccess(
  connection: DriveConnectionRow,
  folderId: string,
): Promise<{ ok: boolean; folderName: string | null; fileCount: number }> {
  // First: verify the folder itself is accessible
  const folderMeta = await getDriveFileMetadata(connection, folderId);
  if (folderMeta.mimeType !== DRIVE_FOLDER_MIME) {
    throw new DriveServiceError("not_a_folder", "The selected item is not a Drive folder");
  }
  // Second: list a small sample of files
  const { files } = await listDriveFolderFiles(connection, folderId, { maxResults: 5 });
  return { ok: true, folderName: folderMeta.name, fileCount: files.length };
}

// ── Error type ───────────────────────────────────────────────────────────────

export class DriveServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DriveServiceError";
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeFileMetadata(f: any): DriveFileMetadata {
  return {
    id: String(f.id || ""),
    name: String(f.name || ""),
    mimeType: String(f.mimeType || ""),
    size: f.size != null ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ? String(f.modifiedTime) : null,
    createdTime: f.createdTime ? String(f.createdTime) : null,
    parents: Array.isArray(f.parents) ? f.parents.map(String) : [],
    webViewLink: f.webViewLink ? String(f.webViewLink) : null,
  };
}
