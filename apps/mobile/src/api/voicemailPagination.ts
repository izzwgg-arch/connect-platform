/** Must match `GET /voice/voicemail` server `take` in `apps/api/src/server.ts`. */
export const VOICEMAIL_API_PAGE_SIZE = 100;

/** Safety cap: max pages fetched per folder on mobile (avoid unbounded mailboxes). */
export const VOICEMAIL_MAX_PAGES_PER_FOLDER = 30;

export function shouldFetchAnotherVoicemailPage(
  batchLen: number,
  page: number,
  total: number,
  maxPages: number,
  pageSize: number,
): boolean {
  if (page >= maxPages) return false;
  if (batchLen < pageSize) return false;
  if (page * pageSize >= total) return false;
  return true;
}
