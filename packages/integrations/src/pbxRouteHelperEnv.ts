export type PbxRouteHelperConfig = {
  baseUrl: string;
  secret: string;
  connectDestinationId?: string | null;
};

type HelperMapEntry = {
  baseUrl?: string;
  url?: string;
  secret?: string;
  connectDestinationId?: string | number;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Resolve PBX route-helper base URL + HMAC secret from env (global or per-instance JSON). */
export function resolvePbxRouteHelperConfig(pbxInstanceId?: string | null): PbxRouteHelperConfig | null {
  const byInstanceRaw = String(process.env.PBX_ROUTE_HELPER_BY_INSTANCE_JSON || "").trim();
  if (byInstanceRaw && pbxInstanceId) {
    try {
      const parsed = JSON.parse(byInstanceRaw) as Record<string, HelperMapEntry>;
      const entry = parsed[pbxInstanceId];
      const baseUrl = String(entry?.baseUrl || entry?.url || "").trim();
      const secret = String(entry?.secret || "").trim();
      if (baseUrl && secret) {
        return {
          baseUrl: trimSlash(baseUrl),
          secret,
          connectDestinationId: entry?.connectDestinationId == null ? null : String(entry.connectDestinationId),
        };
      }
    } catch {
      // Fall through to global env; callers surface helper-not-configured when
      // neither source is usable.
    }
  }

  const baseUrl = String(process.env.PBX_ROUTE_HELPER_BASE_URL || "").trim();
  const secret = String(process.env.PBX_ROUTE_HELPER_SECRET || "").trim();
  if (!baseUrl || !secret) return null;
  return {
    baseUrl: trimSlash(baseUrl),
    secret,
    connectDestinationId: String(process.env.PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID || "").trim() || null,
  };
}

export type VoicemailSpoolListBody = {
  tenantId: string;
  extension: string;
  /** Asterisk voicemail context (AMI MessageWaiting mailbox@context), optional. */
  voicemailContext?: string;
  /** Alias for voicemailContext */
  context?: string;
  /** Helper schema 2: page size (capped server-side). */
  limit?: number;
  offset?: number;
  /** Helper schema 2: only messages with origtime >= this unix second. */
  sinceOrigtime?: number;
};

export type VoicemailSpoolListMessage = {
  folder: string;
  origtime: string;
  callerid: string;
  duration: string;
  filename: string;
  msg_num: string;
  recfile: string;
};

export type VoicemailSpoolListResponse = {
  ok: true;
  mailboxPath: string;
  resolvedContext?: string | null;
  messages: VoicemailSpoolListMessage[];
  /** 2 = newest-first sort, pagination + maxOrigtimeAll over full mailbox scan */
  spoolListSchema?: number;
  totalCount?: number;
  returnedCount?: number;
  offset?: number;
  limit?: number;
  truncated?: boolean;
  /** Unix seconds as string; max origtime across all matching msgs in mailbox (all pages). */
  maxOrigtimeAll?: string;
  sort?: string;
  folderMsgCounts?: Record<string, number>;
};

export type VoicemailSpoolListMergedResponse = VoicemailSpoolListResponse & {
  paginationComplete: boolean;
  pagesFetched: number;
};

/** Read-only: single POST page to on-PBX helper /voicemail/spool/list. */
export async function listVoicemailSpoolFromHelper(
  cfg: PbxRouteHelperConfig,
  body: VoicemailSpoolListBody,
  timeoutMs = 12_000,
): Promise<VoicemailSpoolListResponse> {
  const resp = await fetch(`${cfg.baseUrl}/voicemail/spool/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const detail = parsed?.error || parsed?.message || text || `HTTP ${resp.status}`;
    const err: any = new Error(String(detail));
    err.httpStatus = resp.status;
    err.payload = parsed;
    throw err;
  }
  return parsed as VoicemailSpoolListResponse;
}

/**
 * Fetches all spool messages by following helper pagination (schema 2).
 * Legacy helpers (no spoolListSchema) return one page as-is.
 */
export async function fetchAllVoicemailSpoolMessages(
  cfg: PbxRouteHelperConfig,
  body: VoicemailSpoolListBody,
  options?: { pageSize?: number; timeoutMs?: number; maxPages?: number },
): Promise<VoicemailSpoolListMergedResponse> {
  const pageSize = Math.min(Math.max(options?.pageSize ?? 2000, 1), 20000);
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const maxPagesEnv = Number(process.env.VOICEMAIL_HELPER_SPOOL_MAX_PAGES || "");
  const maxPages = Math.max(
    1,
    options?.maxPages ?? (Number.isFinite(maxPagesEnv) && maxPagesEnv > 0 ? maxPagesEnv : 250),
  );

  const base: VoicemailSpoolListBody = {
    tenantId: body.tenantId,
    extension: body.extension,
    ...(body.voicemailContext != null ? { voicemailContext: body.voicemailContext } : {}),
    ...(body.context != null ? { context: body.context } : {}),
    ...(body.sinceOrigtime != null ? { sinceOrigtime: body.sinceOrigtime } : {}),
  };

  let offset = 0;
  const all: VoicemailSpoolListMessage[] = [];
  let mailboxPath = "";
  let resolvedContext: string | null | undefined;
  let totalCount = 0;
  let maxOrigtimeAll = "";
  let folderMsgCounts: Record<string, number> | undefined;
  let pagesFetched = 0;

  for (;;) {
    const page = await listVoicemailSpoolFromHelper(
      cfg,
      { ...base, limit: pageSize, offset },
      timeoutMs,
    );
    pagesFetched += 1;
    mailboxPath = page.mailboxPath;
    resolvedContext = page.resolvedContext ?? null;
    const batch = page.messages || [];
    if (page.totalCount != null) totalCount = page.totalCount;
    if (page.maxOrigtimeAll != null && String(page.maxOrigtimeAll) !== "") {
      maxOrigtimeAll = String(page.maxOrigtimeAll);
    }
    if (page.folderMsgCounts && typeof page.folderMsgCounts === "object") {
      folderMsgCounts = page.folderMsgCounts;
    }
    all.push(...batch);

    if (page.spoolListSchema !== 2) {
      return {
        ok: true,
        mailboxPath,
        resolvedContext: resolvedContext ?? null,
        messages: all,
        paginationComplete: true,
        pagesFetched,
        totalCount: page.totalCount ?? all.length,
        returnedCount: all.length,
        truncated: false,
        maxOrigtimeAll: maxOrigtimeAll || undefined,
        folderMsgCounts,
      };
    }

    const truncated = page.truncated === true;
    const returned = page.returnedCount ?? batch.length;
    offset += returned;

    if (!truncated) {
      return {
        ok: true,
        mailboxPath,
        resolvedContext: resolvedContext ?? null,
        messages: all,
        spoolListSchema: 2,
        totalCount,
        returnedCount: all.length,
        truncated: false,
        maxOrigtimeAll: maxOrigtimeAll || undefined,
        sort: page.sort,
        folderMsgCounts,
        paginationComplete: true,
        pagesFetched,
      };
    }

    if (returned === 0 || pagesFetched >= maxPages) {
      return {
        ok: true,
        mailboxPath,
        resolvedContext: resolvedContext ?? null,
        messages: all,
        spoolListSchema: 2,
        totalCount,
        returnedCount: all.length,
        truncated: true,
        maxOrigtimeAll: maxOrigtimeAll || undefined,
        sort: page.sort,
        folderMsgCounts,
        paginationComplete: false,
        pagesFetched,
      };
    }
  }
}

export type VoicemailSpoolAudioBody = {
  tenantId: string;
  extension: string;
  folder: "INBOX" | "Old" | "Urgent";
  msgNum: string;
  voicemailContext?: string;
};

/** Stream one voicemail message file from Asterisk spool via on-PBX helper (raw audio). */
export async function fetchVoicemailSpoolAudioFromHelper(
  cfg: PbxRouteHelperConfig,
  body: VoicemailSpoolAudioBody,
  timeoutMs = 90_000,
): Promise<{ contentType: string; buffer: ArrayBuffer }> {
  const resp = await fetch(`${cfg.baseUrl}/voicemail/spool/audio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = await resp.arrayBuffer();
  if (!resp.ok) {
    let parsed: { error?: string; message?: string } | null = null;
    try {
      const text = new TextDecoder().decode(buf.slice(0, 8192));
      parsed = text ? (JSON.parse(text) as { error?: string; message?: string }) : null;
    } catch {
      parsed = null;
    }
    const detail = parsed?.error || parsed?.message || `HTTP ${resp.status}`;
    const err: Error & { httpStatus?: number } = new Error(String(detail));
    err.httpStatus = resp.status;
    throw err;
  }
  const contentType = resp.headers.get("content-type") || "audio/wav";
  return { contentType, buffer: buf };
}
