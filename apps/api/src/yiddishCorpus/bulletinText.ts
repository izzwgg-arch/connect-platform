/**
 * Yiddish24 bulletin harvest — pure HTML → article records.
 *
 * WHY this source matters (Izzy, 2026-09-18): the בולעטין section pairs a short
 * news recording with the SAME story typed out. That is a human-written label
 * for real speech, which is exactly what the fine-tune has never had — every
 * label so far is the model's own output, and a model cannot correct itself
 * from its own mistakes. Verified on item 166573: our ASR heard `דאס רעדן`
 * where the typed text reads `אפטרעטן` (resign), and dropped `קיר` entirely.
 *
 * ⛔ It is NOT a verbatim transcript. Izzy, same day: "It's not 100% word for
 * word, but it is, I would say, 97%, so the agent is going to have to use
 * common sense here too." So this module only EXTRACTS; deciding which spans
 * are safe to train on is `align.ts`'s job, and nothing here may be treated as
 * ground truth on its own.
 *
 * ⛔ The article body exists ONLY on the category listing (`/cat/57`) and the
 * `POST /ajax/cat_pagination.php` responses behind it. The per-item page
 * (`/news/bulletin/<id>`) carries no body at all — 2,982 Hebrew characters,
 * every one of them navigation. Fetching item pages would harvest nothing.
 */

/** Section ids on yiddish24. Only בולעטין has article bodies — Traffic (153),
 * רשות הרבים (302), ביזנעס (45) and אינטערוויוס (12) return the player
 * placeholder only, which is why this harvest is bulletin-only. */
export const BULLETIN_CAT_ID = 57;

/** `YcSourceItem.seriesName` for the bulletin section. ⛔ `category` reads
 * "News" for these items (the MAIN category label), so filtering on `category`
 * selects 9,895 unrelated news items and none of the pairing this harvest is
 * for. The series name is the only field that isolates the section. */
export const BULLETIN_SERIES_NAME = "בולעטין";

/** `YcTranscript.engine` for text the PUBLISHER typed, as opposed to `ivrit`
 * (our ASR) or `human` (a reviewer's correction of our ASR). Kept distinct so
 * nothing downstream can mistake it for either: `buildIvritClips` and
 * `buildGoldClips` in the dataset builder both filter on an exact engine
 * string, so a `publisher` row is inert until something deliberately reads it.
 * ⛔ It is NOT a transcript — it has no timing and it is only ~97% of what was
 * actually said. Only `bulletinAlign` may turn it into training text. */
export const PUBLISHER_ENGINE = "publisher";

/** `YcTranscript.originRef` prefix for a harvested article, matching the
 * existing `"{assetId}#{chunk}"` (machine) and `"gold:{reviewId}"` (human)
 * conventions. */
export function publisherOriginRef(externalId: string): string {
  return `bulletin:${externalId}`;
}

export interface BulletinArticle {
  /** yiddish24 item id — matches `YcSourceItem.externalId`. */
  externalId: string;
  title: string;
  /** Body paragraphs, in order, tags stripped and whitespace collapsed. */
  paragraphs: string[];
  /** `title` + body as one string: what the recording plausibly reads. */
  fullText: string;
  mediaUrl: string | null;
  /** Hebrew-script character count — the cheapest "is this really Yiddish text
   * and not an empty placeholder" check. */
  hebrewChars: number;
}

const HEBREW = /[\u0590-\u05FF]/g;

/**
 * Tokens for comparison: Hebrew-script words only, with the Yiddish niqqud /
 * rafe marks the site sprinkles inconsistently stripped. ⛔ The SAME sentence
 * appears with and without those marks across the site, so comparing raw
 * strings reports two identical sentences as different and the alignment
 * throws away good text.
 */
export function compareTokens(text: string): string[] {
  return text
    .replace(/[\u0591-\u05C7]/g, "")
    .split(/[^\u05D0-\u05EA'"\u05F3\u05F4-]+/)
    .map((t) => t.replace(/^[-'"]+|[-'"]+$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * On this site the headline is SOMETIMES the first sentence of the body
 * (item 167511: identical for 141 characters) and sometimes a separate summary
 * (item 167510: no overlap at all). Concatenating blindly would feed the
 * aligner the opening sentence twice for roughly half the archive. Treat the
 * title as a duplicate only when the body demonstrably opens with it.
 */
export const TITLE_DUPLICATE_MIN_TOKENS = 6;

export function titleDuplicatesBody(title: string, body: string): boolean {
  const t = compareTokens(title);
  const b = compareTokens(body);
  if (t.length < TITLE_DUPLICATE_MIN_TOKENS || b.length < TITLE_DUPLICATE_MIN_TOKENS) return false;
  let shared = 0;
  while (shared < t.length && shared < b.length && t[shared] === b[shared]) shared += 1;
  return shared >= TITLE_DUPLICATE_MIN_TOKENS;
}

export function hebrewCharCount(s: string): number {
  return (s.match(HEBREW) || []).length;
}

/** Decode the entities this site actually emits, then collapse whitespace. */
export function stripTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse one listing page into article records.
 *
 * Each article is one `bulletin-news-des-row` block. Inside it the id is on
 * the headline (`<h1 id="song-titleNNN">`), the body is the block's `<p>`
 * elements, and the recording is on the player panel (`item-data-NNN`).
 *
 * ⛔⛔ TWO layouts exist and BOTH carry article text. Newer posts wrap the
 * body in `<div class="content_block" data-id="_57_NNN">` (they have an image
 * gallery); older ones put the same `<p>` straight in the row with no wrapper
 * at all. Keying on `content_block` — which the first version did — harvested
 * 931 of about 3,230 articles and reported the other 2,300 pages as EMPTY
 * rather than as a parser miss. Anchor on the row, never on the wrapper.
 *
 * ⛔ The page also repeats the headline inside an HTML COMMENT just above the
 * real one, and a commented-out `<p class="photo-credit">` sits in the image
 * markup. Comments are stripped before any of this is read, or the harvest
 * picks up markup the site deliberately disabled.
 */
export function parseBulletinPage(html: string, catId: number = BULLETIN_CAT_ID): BulletinArticle[] {
  void catId; // the row markup is the same for every section; kept for callers
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ");
  const out: BulletinArticle[] = [];
  const rows = clean.split(/<div class="bulletin-news-des-row/);
  for (const row of rows.slice(1)) {
    const idM = row.match(/<h1 id="song-title(\d+)"/);
    if (!idM) continue;
    const externalId = idM[1];
    const titleM = row.match(new RegExp(`<h1 id="song-title${externalId}"[^>]*>([\\s\\S]*?)</h1>`));
    const title = titleM ? stripTags(titleM[1]) : "";
    const paragraphs: string[] = [];
    for (const p of row.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      if (/photo-credit/i.test(p[1])) continue;
      const text = stripTags(p[2]);
      if (hebrewCharCount(text) >= 10) paragraphs.push(text);
    }
    const mediaM = row.match(new RegExp(`item-data-${externalId}[^>]*data-song-url="([^"]+)"`));
    const body = paragraphs.join(" ");
    const fullText = (titleDuplicatesBody(title, body) ? body : [title, body].filter(Boolean).join(" ")).trim();
    if (!fullText) continue;
    out.push({
      externalId,
      title,
      paragraphs,
      fullText,
      mediaUrl: mediaM ? mediaM[1] : null,
      hebrewChars: hebrewCharCount(fullText),
    });
  }
  return out;
}

/** The pagination response is `{result: "<html>", next_page, prev_page, curr_page}`. */
export function parsePaginationResponse(body: string): { html: string; nextPage: number | null; currPage: number | null } {
  const json = JSON.parse(body);
  const next = Number(json.next_page);
  const curr = Number(json.curr_page);
  return {
    html: String(json.result ?? ""),
    nextPage: Number.isFinite(next) && next > 0 ? next : null,
    currPage: Number.isFinite(curr) ? curr : null,
  };
}

/** `totalPages` / `perPage` / `catID` are hidden inputs on the first page. */
export function readListingParams(html: string): { catId: number | null; totalPages: number | null; perPage: number | null } {
  const grab = (id: string): number | null => {
    const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`value="([^"]*)"[^>]*id="${id}"`));
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return { catId: grab("catID"), totalPages: grab("totalPages"), perPage: grab("perPage") };
}

// ── harvest runner ──────────────────────────────────────────────────────────

/**
 * Walk the bulletin listing and return every article it carries.
 *
 * ⛔ Uses the adapter's OWN `getText` + `createRateLimiter` (2 s floor, 30 rpm
 * ceiling, Cloudflare-challenge detection, one user-agent). A second fetcher
 * here would be a second, politer-on-paper-only crawler against a site whose
 * owner gave us permission personally.
 *
 * Page 1 is a plain GET of `/cat/57/`; pages 2..N are the same
 * `POST /ajax/cat_pagination.php` the site's own pagination uses, whose JSON
 * `result` is the same markup. `totalPages` comes from the hidden input on
 * page 1, so the walk length is the site's own number, not a guess.
 */
export interface HarvestOptions {
  catId?: number;
  /** Stop after this many pages (a probe run); omit to walk the whole section. */
  maxPages?: number;
  requestsPerMinute?: number | null;
  onPage?: (page: number, totalPages: number, articles: BulletinArticle[]) => void | Promise<void>;
}

export interface HarvestResult {
  articles: BulletinArticle[];
  pagesRead: number;
  totalPages: number | null;
  /** Pages that parsed to zero articles — a listing shape change shows up here
   * as a run of zeros rather than as a silently short harvest. */
  emptyPages: number[];
}

export async function harvestBulletinArticles(opts: HarvestOptions = {}): Promise<HarvestResult> {
  const { createRateLimiter, getText, YIDDISH24_ORIGIN } = await import("./yiddish24Adapter");
  const catId = opts.catId ?? BULLETIN_CAT_ID;
  const limiter = createRateLimiter(opts.requestsPerMinute ?? null);
  const listingUrl = `${YIDDISH24_ORIGIN}/cat/${catId}/`;

  const firstHtml = await getText(listingUrl, limiter);
  const params = readListingParams(firstHtml);
  const totalPages = params.totalPages;
  const perPage = params.perPage ?? 10;

  const byId = new Map<string, BulletinArticle>();
  const emptyPages: number[] = [];
  const take = async (page: number, html: string) => {
    const found = parseBulletinPage(html, catId);
    if (found.length === 0) emptyPages.push(page);
    // Keyed by id: the listing re-orders as new posts land mid-walk, so the
    // same article can appear on two pages. Last write wins, count stays true.
    for (const a of found) byId.set(a.externalId, a);
    await opts.onPage?.(page, totalPages ?? 0, found);
  };

  await take(1, firstHtml);
  const limit = Math.min(totalPages ?? 1, opts.maxPages ?? Number.MAX_SAFE_INTEGER);
  let pagesRead = 1;
  for (let page = 2; page <= limit; page += 1) {
    const body = new URLSearchParams({
      page_no: String(page),
      data_id: String(catId),
      total_pages: String(totalPages ?? ""),
      page_limit: String(perPage),
      cat_id: "",
    }).toString();
    const raw = await getText(`${YIDDISH24_ORIGIN}/ajax/cat_pagination.php`, limiter, {
      method: "POST",
      body,
      referer: listingUrl,
    });
    const { html } = parsePaginationResponse(raw);
    await take(page, html);
    pagesRead += 1;
  }

  return { articles: [...byId.values()], pagesRead, totalPages, emptyPages };
}
