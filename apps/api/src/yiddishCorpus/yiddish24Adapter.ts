/**
 * Yiddish24 — external source adapter (source #1).
 *
 * WHAT THIS IS ALLOWED TO DO TODAY: read the public HTML listings at a polite
 * rate and normalize the metadata the pages already carry (post id, title,
 * series, host, Hebrew-calendar date label, duration, image, media URL).
 *
 * ⛔⛔ WHAT IT MUST NEVER DO: fetch audio bytes, or send a `Referer` header to
 * the media host, unless `assertAudioFetchAllowed()` says the owner has
 * recorded a rights grant. The MP3s on cloudfront.yiddish24.com answer 403
 * without `Referer: https://www.yiddish24.com/`. That is an ACCESS CONTROL.
 * Sending that header from an off-site fetcher would be working around it, so
 * `fetchAudio()` below is written with the REFUSAL as the default path and the
 * fetch behind one gate — see the comment on it. The Referer string appears in
 * exactly one place in this file: inside that gated branch, where it is the
 * owner's recorded decision and not ours.
 *
 * Site facts this adapter is written against (read-only inspection 2026-09-15,
 * recorded in §2 of AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md):
 *  - Custom PHP/jQuery behind Cloudflare. No RSS, no API, no sitemap, no
 *    /wp-json. No transcripts anywhere.
 *  - Main categories `/mainCategory/{id}`; ~136 series at `/cat/{catId}/`.
 *  - Every page carries the whole series catalog in its nav submenu.
 *  - Listing pages hold 10 items and expose hidden inputs `totalPages`,
 *    `perPage`, `catID`. Later pages come from POST /ajax/cat_pagination.php
 *    (`page_no`, `data_id`, `total_pages`, `page_limit`, `cat_id`), which
 *    answers `{"result": "<html>", "next_page", "prev_page", "curr_page"}` —
 *    the SAME item markup, so one parser serves both.
 *  - Series names are base64 of a URL-encoded Hebrew string, with `+` for
 *    space (the site does `btoa(encodeURIComponent(name))`).
 *
 * The parsers are deliberately regex-based and tolerant: there is no HTML
 * parser in apps/api's dependency tree and this task adds none. Every parser
 * assumption has a probe in `probeSite()` and a golden-file test, because a
 * silent zero from a changed page must never read as "nothing new".
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { YIDDISH24_SOURCE_KEY, YC_AUDIO_BLOCKED_MESSAGE } from "./contracts";
// ⛔ The one gate. Lives in governance.ts and answers
// { ok: boolean, reason: string | null }; it says ok only when the source is
// OWNER_AUTHORIZED *and* the owner has recorded a rights grant. It is pure, so
// `resolveAudioGate()` below is the single place that loads the rows for it —
// everything in this folder asks the gate through that one function.
import { assertAudioFetchAllowed } from "./governance";
import { probeAudio } from "./audioPipeline";

// ── constants ────────────────────────────────────────────────────────────────

export const YIDDISH24_ORIGIN = "https://www.yiddish24.com";
export const YIDDISH24_MEDIA_HOST = "cloudfront.yiddish24.com";

/** The main categories, as the site numbers them. */
export const YIDDISH24_MAIN_CATEGORIES: { id: number; label: string }[] = [
  { id: 1, label: "News" },
  { id: 4, label: "Interviews" },
  { id: 19, label: "Analysis" },
  { id: 2, label: "Miscellaneous" },
  { id: 3, label: "Health" },
  { id: 5, label: "Business" },
  { id: 8, label: "Video" },
  { id: 7, label: "Music" },
  { id: 6, label: "Torah" },
];

/**
 * The site's own "Music" main category (נגינה). ⛔ The engine learns from
 * people TALKING. Series under this category are never walked, and any item
 * that reaches the pipeline from one is skipped before its first stage.
 * This is decided by the SITE's own grouping, never by guessing from titles.
 * Music inside a talk episode (jingles, song breaks) is a different problem:
 * only the audio pipeline's SPEECH/MUSIC segment classifier can see that.
 */
export const YIDDISH24_MUSIC_MAIN_CATEGORY_ID = "7";

/**
 * Bump when parseSeriesLinks changes how it attributes series to categories.
 * A cursor carrying an older version re-reads the nav once, so a map built by
 * a wrong parser is replaced instead of trusted for ever.
 */
export const YIDDISH24_CATALOG_PARSER_VERSION = 2;

/**
 * Music series the site files OUTSIDE its Music category. A named, reviewable
 * decision by catId — never inferred from a title at runtime.
 *   233  נגינה ווידעאס  (music videos, filed under Video) — excluded 2026-09-16
 *        on Izzy's "no music, just audio of people talking".
 */
export const YIDDISH24_EXTRA_MUSIC_SERIES: readonly string[] = ["233"];

/** True when this series is music: under the site's Music category, or named above. */
export function isMusicSeries(mainCategoryId: string | null | undefined, catId?: string | null): boolean {
  if (catId != null && YIDDISH24_EXTRA_MUSIC_SERIES.includes(String(catId))) return true;
  return String(mainCategoryId ?? "") === YIDDISH24_MUSIC_MAIN_CATEGORY_ID;
}

/**
 * Is this catalogued item music? Decided only from the site's own grouping,
 * held in the discovery cursor: the item's series is one of the Music
 * category's series. Unknown (no catalog yet) is NOT music — we never skip an
 * episode on a guess.
 */
export function isMusicItem(
  item: { seriesName?: string | null; category?: string | null },
  discoveryCursorRaw: string | null | undefined,
): boolean {
  let cursor: any = {};
  try {
    cursor = discoveryCursorRaw ? JSON.parse(String(discoveryCursorRaw)) : {};
  } catch {
    return false;
  }
  const musicIds: string[] = Array.isArray(cursor?.musicCatIds) ? cursor.musicCatIds : [];
  if (!musicIds.length) return false;
  const names = new Set(musicIds.map((id) => cursor?.seriesNames?.[id]).filter(Boolean).map((n: string) => n.trim()));
  const series = String(item?.seriesName ?? "").trim();
  return series.length > 0 && names.has(series);
}

/**
 * A normal desktop browser UA. We identify as a browser because the site is
 * behind Cloudflare and a blank UA is what gets challenged — not to disguise
 * anything. Rate, not identity, is what keeps this polite.
 */
export const YIDDISH24_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

/** Hard floor: never faster than one request every 2 seconds, whatever a budget says. */
export const YIDDISH24_MIN_REQUEST_GAP_MS = 2_000;
/** Hard ceiling on the budget's requestsPerMinute for this source. */
export const YIDDISH24_MAX_RPM = 30;

/** Probe keys. Each one is a parser assumption that can rot. */
export const YIDDISH24_PROBE_KEYS = [
  "listing_item_attributes",
  "listing_pagination_inputs",
  "series_catalog_nav",
  "ajax_cat_pagination",
  "series_name_base64",
  "audio_referer_required",
  "no_rss_feed",
  "no_sitemap",
] as const;
export type Yiddish24ProbeKey = (typeof YIDDISH24_PROBE_KEYS)[number];

export interface YcProbeResult {
  probeKey: string;
  /** OK | DEGRADED | BROKEN | BLOCKED | ABSENT */
  state: string;
  detail: string | null;
}

// ── normalized item shape (maps 1:1 onto YcSourceItem columns) ───────────────

export interface Yiddish24Item {
  externalId: string;
  canonicalUrl: string | null;
  title: string | null;
  seriesName: string | null;
  category: string | null;
  host: string | null;
  /** Exactly as the site states it — a Hebrew-calendar date. Never converted. */
  publishedLabel: string | null;
  durationSec: number | null;
  mediaUrl: string | null;
  imageUrl: string | null;
  fingerprint: string;
  metadata: Record<string, unknown>;
}

export interface Yiddish24SeriesLink {
  catId: string;
  name: string | null;
  mainCategoryId: string | null;
  mainCategoryLabel: string | null;
}

// ── injectable network (tests never touch the network) ──────────────────────

type FetchLike = (input: any, init?: any) => Promise<any>;
let fetchImpl: FetchLike | null = null;
/** Tests and callers inject their own fetch. Default is the platform fetch. */
export function setYiddish24Fetch(f: FetchLike | null): void {
  fetchImpl = f;
}
function theFetch(): FetchLike {
  if (fetchImpl) return fetchImpl;
  const g: any = globalThis as any;
  if (typeof g.fetch !== "function") throw new Error("no fetch available in this runtime");
  return g.fetch.bind(g);
}

// ── pure parsing (unit-testable without a network) ──────────────────────────

const COMMENT_RE = /<!--[\s\S]*?-->/g;

function stripHtml(s: string): string {
  return s
    .replace(COMMENT_RE, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Escape a value for safe inclusion in a RegExp source. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `"1:09:40"` → 4180, `"35:53"` → 2153, `"0:26"` → 26.
 * Anything that is not a clock reads as null — a wrong duration is worse than
 * a missing one, because novelty scores on it.
 */
export function parseDuration(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = stripHtml(String(raw));
  const m = /(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?/.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] == null ? null : Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const secs = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  return Number.isFinite(secs) && secs >= 0 ? secs : null;
}

/**
 * The site stores series names as `btoa(encodeURIComponent(name))`, so the
 * decoded payload is percent-encoded with `+` standing in for a space.
 * Decoded ONCE at ingest and stored as published — nothing downstream should
 * ever see base64.
 */
export function decodeSeriesName(b64: string | null | undefined): string | null {
  if (!b64) return null;
  const raw = String(b64).trim();
  if (!raw) return null;
  // Buffer.from(..., "base64") silently eats anything that is not base64 and
  // answers mojibake, so the shape is checked before it is trusted.
  if (!/^[A-Za-z0-9+/= ]+$/.test(raw)) return null;
  try {
    const pct = Buffer.from(raw.replace(/ /g, "+"), "base64").toString("utf8");
    // The payload is always `encodeURIComponent(...)` output: printable ASCII.
    // Anything else means we decoded something that was never a series name.
    if (!pct || /[^\x20-\x7E]/.test(pct)) return null;
    const decoded = decodeURIComponent(pct.replace(/\+/g, "%20"));
    const clean = decoded.replace(/\s+/g, " ").trim();
    return clean || null;
  } catch {
    return null;
  }
}

/** The inverse, so the round-trip is a test and not a belief. */
export function encodeSeriesName(name: string): string {
  return Buffer.from(encodeURIComponent(name).replace(/%20/g, "+"), "utf8").toString("base64");
}

/**
 * The hidden inputs a listing page carries. POST /ajax/cat_pagination.php
 * needs all three, and a page that suddenly has none is a BROKEN probe, not
 * an empty catalog.
 */
export function parseTotalPages(html: string): {
  totalPages: number | null;
  perPage: number | null;
  catId: string | null;
  mainCatId: string | null;
} {
  const pick = (id: string): string | null => {
    const re = new RegExp(`<input[^>]*id="${reEscape(id)}"[^>]*>`, "i");
    const m = re.exec(html);
    if (!m) return null;
    const v = attrsOf(m[0]).value;
    return v == null || v === "" ? null : v;
  };
  const num = (v: string | null): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return {
    totalPages: num(pick("totalPages")),
    perPage: num(pick("perPage")),
    catId: pick("catID"),
    mainCatId: pick("mainCatId"),
  };
}

/**
 * Every page carries the full series catalog in its nav submenu, so ONE fetch
 * gives the whole `/cat/{id}` list grouped by main category. That is why
 * discovery does not have to walk nine main-category pages every run.
 */
export function parseSeriesLinks(html: string): Yiddish24SeriesLink[] {
  const body = html.replace(COMMENT_RE, "");
  const out = new Map<string, Yiddish24SeriesLink>();

  // ⛔ STRUCTURE FIRST. The nav nests each series inside its main category:
  //   <a href="/mainCategory/N">label</a> <ul class="submenu_list"> …/cat/X… </ul>
  // The old parser attributed a series to whichever mainCategory anchor came
  // before it in the DOCUMENT, and let a later sighting overwrite an earlier
  // one. The live page carries the nav more than once, so the LAST sighting
  // (under the wrong heading) won: news bulletins were filed as Torah and no
  // series at all was filed as news. Membership is now read from the block
  // the link sits in, and the first block that names a series wins.
  const blockRe =
    /<a\b[^>]*href="\/mainCategory\/(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>\s*<ul\b[^>]*class="[^"]*submenu_list[^"]*"[^>]*>((?:(?!href="\/mainCategory\/)[\s\S])*?)(?:<\/ul>|(?=<a\b[^>]*href="\/mainCategory\/)|$)/gi;
  // ⛔ A block ends at its </ul> OR at the next category heading, whichever
  // comes first. Without the second stop, one unclosed list (the saved fixture
  // has one) swallowed the next category and filed its series under the wrong
  // heading — exactly how a music series would have been walked as talk.
  const blockOf = new Map<string, { id: string; label: string | null }>();
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(body))) {
    const group = { id: b[1], label: stripHtml(b[2]) || null };
    const catRe = /href="\/cat\/(\d+)\/?"/gi;
    let c: RegExpExecArray | null;
    while ((c = catRe.exec(b[3]))) {
      if (!blockOf.has(c[1])) blockOf.set(c[1], group);
    }
  }

  // Document-order fallback, used ONLY for a series no block names.
  const groups: { at: number; id: string; label: string | null }[] = [];
  const gRe = /<a\b[^>]*href="\/mainCategory\/(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let g: RegExpExecArray | null;
  while ((g = gRe.exec(body))) {
    groups.push({ at: g.index, id: g[1], label: stripHtml(g[2]) || null });
  }

  const aRe = /<a\b[^>]*href="\/cat\/(\d+)\/?"[^>]*>([\s\S]{0,900}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(body))) {
    const catId = m[1];
    const inner = m[2];
    let name: string | null = null;
    const sub = new RegExp(`class="[^"]*subname_${reEscape(catId)}[^"]*"[^>]*>([\\s\\S]{0,200}?)<`, "i").exec(inner);
    if (sub) name = stripHtml(sub[1]) || null;
    if (!name) {
      const txt = /class="(?:txt|item_title)"[^>]*>([\s\S]{0,200}?)<\//i.exec(inner);
      if (txt) name = stripHtml(txt[1]) || null;
    }
    if (!name) name = stripHtml(inner) || null;

    let group: { id: string; label: string | null } | null = blockOf.get(catId) ?? null;
    if (!group) {
      for (const cand of groups) {
        if (cand.at < m.index) group = cand;
        else break;
      }
    }
    const prev = out.get(catId);
    if (prev) {
      // First sighting keeps its category; a later one may only fill a name.
      if (!prev.name && name) prev.name = name;
      continue;
    }
    out.set(catId, {
      catId,
      name,
      mainCategoryId: group?.id ?? null,
      mainCategoryLabel: group?.label ?? null,
    });
  }
  return [...out.values()];
}

/**
 * The one item parser. Works on a `/cat/{id}/` page, a `/mainCategory/{id}`
 * page, the home page, and on the HTML inside a cat_pagination response —
 * they all carry the same `data-song-url` panel div.
 *
 * Each item is anchored on its post id, so title/date/duration are matched by
 * that id rather than by proximity. Proximity is what breaks when the site
 * reshuffles a card.
 */
export function parseListingHtml(html: string, opts: { category?: string | null } = {}): Yiddish24Item[] {
  const body = String(html || "").replace(COMMENT_RE, "");
  const items: Yiddish24Item[] = [];
  const seen = new Set<string>();

  const panelRe = /<div\b[^>]*\bdata-song-url="[^"]*"[^>]*>/gi;
  const panels: { at: number; attrs: Record<string, string> }[] = [];
  let p: RegExpExecArray | null;
  while ((p = panelRe.exec(body))) panels.push({ at: p.index, attrs: attrsOf(p[0]) });

  for (let i = 0; i < panels.length; i += 1) {
    const { at, attrs } = panels[i];
    const externalId = (attrs["data-id"] || attrs["data-post_id"] || attrs["data-postid"] || "").trim();
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);

    const after = body.slice(at, panels[i + 1]?.at ?? body.length);
    const before = body.slice(panels[i - 1]?.at ?? 0, at);

    // Title: keyed on the post id in both markups (listing h1, card anchor).
    let title: string | null = null;
    const h1 = new RegExp(`id="song-title${reEscape(externalId)}"[^>]*>([\\s\\S]{0,800}?)<\\/`, "i").exec(body);
    if (h1) title = stripHtml(h1[1]) || null;
    if (!title) {
      const anchor = new RegExp(
        `<a\\b[^>]*data-postid="${reEscape(externalId)}"[^>]*>([\\s\\S]{0,800}?)<\\/a>`,
        "i",
      ).exec(body);
      if (anchor) title = stripHtml(anchor[1]) || null;
    }

    // Date label: the nearest one BEFORE the panel. Hebrew-calendar only —
    // we publish it verbatim and never guess a Gregorian date from it.
    let publishedLabel: string | null = null;
    const dateRe = /<(?:span|div)\b[^>]*class="[^"]*\b(?:news-date|date)\b[^"]*"[^>]*>([\s\S]{0,160}?)<\//gi;
    let d: RegExpExecArray | null;
    while ((d = dateRe.exec(before))) {
      const v = stripHtml(d[1]);
      if (v) publishedLabel = v;
    }

    // Duration: the first one AFTER the panel opens (it is inside the panel).
    let durationSec: number | null = null;
    const dur = /class="[^"]*\bsong-duration\b[^"]*"[^>]*>([\s\S]{0,120}?)<\/div>/i.exec(after);
    if (dur) durationSec = parseDuration(dur[1]);

    // Canonical URL: the share button carries the real permalink.
    let canonicalUrl: string | null = null;
    const share = /data-url="(https?:\/\/[^"]+)"/i.exec(after);
    if (share) canonicalUrl = share[1];

    // One-line description, when the card has one.
    let description: string | null = null;
    const para = /<p\b[^>]*>([\s\S]{0,600}?)<\/p>\s*$/i.exec(before.slice(-1500));
    if (para) description = stripHtml(para[1]) || null;

    const seriesName = decodeSeriesName(attrs["data-cat-title"]);
    const mediaUrl = attrs["data-song-url"] || null;
    const videoUrl = attrs["data-link"] || null;

    const item: Yiddish24Item = {
      externalId,
      canonicalUrl,
      title,
      seriesName,
      // ⛔ NOT data-cat-color. That attribute is a CSS colour ("darkred"), and
      // using it as a fallback filed all 270 catalogued items under a colour.
      // The real main category comes from the series catalog; unknown is null.
      category: opts.category ?? null,
      // The site does not publish a host field. The series name IS the host on
      // personality shows; we do not invent one by splitting the title.
      host: null,
      publishedLabel,
      durationSec,
      mediaUrl,
      imageUrl: attrs["data-image"] || null,
      fingerprint: "",
      metadata: {
        description,
        videoUrl,
        mediaKind: videoUrl ? "video" : mediaUrl ? "audio" : "unknown",
        catColor: attrs["data-cat-color"] || null,
        seriesNameEncoded: attrs["data-cat-title"] || null,
        dataType: attrs["data-type"] || null,
      },
    };
    item.fingerprint = fingerprintItem(item);
    items.push(item);
  }
  return items;
}

/**
 * Content identity, NOT row identity: the same episode re-posted under a new
 * post id must collide. So the media filename, the duration and the
 * normalized title are the fingerprint, and the post id is deliberately not.
 */
export function fingerprintItem(item: {
  mediaUrl?: string | null;
  durationSec?: number | null;
  title?: string | null;
  seriesName?: string | null;
  externalId?: string;
}): string {
  const media = item.mediaUrl ? item.mediaUrl.split("?")[0].split("/").pop() || "" : "";
  const title = (item.title || "").replace(/\s+/g, " ").trim().toLowerCase();
  const series = (item.seriesName || "").replace(/\s+/g, " ").trim().toLowerCase();
  const basis = media || title ? [media, item.durationSec ?? "", title, series].join("|") : `id:${item.externalId ?? ""}`;
  return createHash("sha256").update(`yiddish24|${basis}`).digest("hex").slice(0, 40);
}

/** The cat_pagination response: `{ result: "<html>", next_page, curr_page }`. */
export function parsePaginationResponse(text: string): {
  html: string;
  currPage: number | null;
  nextPage: number | null;
} {
  try {
    const j = JSON.parse(text);
    const html = typeof j?.result === "string" ? j.result : "";
    const n = (v: any) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    };
    return { html, currPage: n(j?.curr_page), nextPage: n(j?.next_page) };
  } catch {
    return { html: "", currPage: null, nextPage: null };
  }
}

// ── politeness ──────────────────────────────────────────────────────────────

export interface RateLimiter {
  /** Resolves when it is polite to make the next request. */
  wait(): Promise<void>;
  readonly minGapMs: number;
}

/**
 * At most one request every `minGapMs`, serialized. The 2 s floor is a floor:
 * a budget can only make this SLOWER, never faster. now/sleep are injectable
 * so the spacing is a test, not a promise.
 */
export function createRateLimiter(
  requestsPerMinute?: number | null,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): RateLimiter {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rpmRaw = Number(requestsPerMinute);
  const rpm = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.min(rpmRaw, YIDDISH24_MAX_RPM) : YIDDISH24_MAX_RPM;
  const minGapMs = Math.max(YIDDISH24_MIN_REQUEST_GAP_MS, Math.ceil(60_000 / rpm));
  let last = 0;
  // ⛔ A flag, not `last === 0`: a clock that legitimately reads 0 would make
  // every request look like the first one and drop the gap entirely.
  let started = false;
  let chain: Promise<void> = Promise.resolve();
  return {
    minGapMs,
    wait(): Promise<void> {
      // Serialized: "one page at a time" is enforced here, not by the caller.
      chain = chain.then(async () => {
        const gap = started ? minGapMs - (now() - last) : 0;
        if (gap > 0) await sleep(gap);
        started = true;
        last = now();
      });
      return chain;
    },
  };
}

// ── HTTP with a hard stop ───────────────────────────────────────────────────

export class Yiddish24Blocked extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "Yiddish24Blocked";
  }
}

function looksLikeChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 503) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes("cf-challenge") ||
    head.includes("just a moment") ||
    head.includes("/cdn-cgi/challenge-platform") ||
    head.includes("attention required! | cloudflare")
  );
}

async function getText(
  url: string,
  limiter: RateLimiter,
  init?: { method?: string; body?: string; referer?: string },
): Promise<string> {
  await limiter.wait();
  const headers: Record<string, string> = {
    "user-agent": YIDDISH24_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
  if (init?.body) headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  if (init?.body) headers["x-requested-with"] = "XMLHttpRequest";
  // Only ever a same-site referer to the site's OWN pages, which is what a
  // browser sends anyway. The media host is a different matter entirely — see
  // fetchAudio().
  if (init?.referer) headers.referer = init.referer;

  const res = await theFetch()(url, { method: init?.method ?? "GET", headers, body: init?.body });
  const status = Number(res?.status ?? 0);
  const text = typeof res?.text === "function" ? await res.text() : "";
  if (status === 429) {
    throw new Yiddish24Blocked("Yiddish24 answered 429 — rate limited. Discovery stopped.", 429);
  }
  if (!res?.ok || looksLikeChallenge(status, text)) {
    throw new Yiddish24Blocked(`Yiddish24 answered ${status || "no status"} (challenge or refusal).`, status || null);
  }
  return text;
}

// ── discovery ───────────────────────────────────────────────────────────────

interface DiscoveryCursor {
  /** Series ids still to walk this pass, in order. */
  pending?: string[];
  /** The series currently being walked, and how far into it we got. */
  catId?: string | null;
  page?: number;
  /** totalPages of the series being walked, read from its page-1 hidden input. */
  totalPages?: number | null;
  /** Series finished at least once — a later run only checks their page 1. */
  completed?: string[];
  /** catId -> main category label, from the series catalog. */
  categories?: Record<string, string>;
  /** catId -> the site's main category id. Music is decided from this. */
  mainCategoryIds?: Record<string, string>;
  /** catId -> series name, so a screen can say what is being walked. */
  seriesNames?: Record<string, string>;
  /** Series under the Music category. Never walked. */
  musicCatIds?: string[];
  /** YIDDISH24_CATALOG_PARSER_VERSION that built the maps above. */
  catalogVersion?: number;
  /** Series catalog refreshed at this ISO time. */
  catalogAt?: string | null;
  /** How many consecutive runs found nothing (siteHealth reads this). */
  emptyRuns?: number;
}

function readCursor(raw: string | null | undefined): DiscoveryCursor {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as DiscoveryCursor) : {};
  } catch {
    return {};
  }
}

export interface DiscoverOptions {
  /** Stop after this many HTTP page reads. Keeps one run bounded. */
  maxPages?: number;
  /** Walk only these series. */
  catIds?: string[];
  /** Force a full re-walk instead of the incremental first-page check. */
  full?: boolean;
  requestsPerMinute?: number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DiscoverResult {
  discovered: number;
  duplicates: number;
  pages: number;
  healthy: boolean;
  newItemIds: string[];
  probes: YcProbeResult[];
  stoppedReason: string | null;
}

/**
 * Walk the series catalog and the listing pages, normalize and upsert.
 *
 * Resumable: the cursor is written after EVERY page, so a restart continues
 * where it stopped rather than re-reading the site.
 * Incremental: a series already completed is only re-checked on page 1, and a
 * page that yields no unseen items ends that series (`full: true` overrides).
 */
export async function discover(db: any, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const source = await db.ycSource.findUnique({
    where: { key: YIDDISH24_SOURCE_KEY },
    include: { budget: true },
  });
  if (!source) {
    return {
      discovered: 0,
      duplicates: 0,
      pages: 0,
      healthy: false,
      newItemIds: [],
      probes: [{ probeKey: "listing_item_attributes", state: "ABSENT", detail: "source row missing" }],
      stoppedReason: "source not registered",
    };
  }
  if (source.enabled === false) {
    return {
      discovered: 0, duplicates: 0, pages: 0, healthy: true, newItemIds: [], probes: [],
      stoppedReason: "source disabled",
    };
  }
  if (source.budget?.paused) {
    return {
      discovered: 0, duplicates: 0, pages: 0, healthy: true, newItemIds: [], probes: [],
      stoppedReason: "budget paused",
    };
  }

  const limiter = createRateLimiter(opts.requestsPerMinute ?? source.budget?.requestsPerMinute ?? null, {
    now: opts.now,
    sleep: opts.sleep,
  });
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 25, 500));
  const cursor = readCursor(source.discoveryCursor);
  const probes: YcProbeResult[] = [];

  let discovered = 0;
  let duplicates = 0;
  let pages = 0;
  let stoppedReason: string | null = null;
  const newItemIds: string[] = [];

  const saveCursor = async (next: DiscoveryCursor) => {
    await db.ycSource.update({
      where: { id: source.id },
      data: { discoveryCursor: JSON.stringify(next), lastDiscoveryAt: new Date() },
    });
  };

  try {
    // 1. The series catalog. One page carries all of it (the nav submenu).
    if (opts.catIds?.length) {
      cursor.pending = [...opts.catIds];
      cursor.catId = null;
      cursor.page = 1;
    } else {
      // The nav is re-read in two cases: a fresh walk (nothing queued), or a
      // walk in progress that has no category map.
      //
      // ⛔ THE SECOND CASE IS NOT COSMETIC. The listing rows carry no category
      // at all, so the map is the ONLY honest source for one. It used to be
      // written only when a walk STARTED, which meant a walk already under way
      // filed every item it found as null until the whole 136-series catalog
      // finished - days of items with no category. One extra page read fixes
      // that, and it never disturbs the queue: on this path `pending`, `catId`
      // and `page` are left exactly as they are.
      const startingFresh = !cursor.pending?.length && !cursor.catId;
      const missingCategories = Object.keys(cursor.categories ?? {}).length === 0;
      const staleParser = (cursor.catalogVersion ?? 1) < YIDDISH24_CATALOG_PARSER_VERSION;
      if (startingFresh || missingCategories || staleParser) {
        const navHtml = await getText(`${YIDDISH24_ORIGIN}/mainCategory/1`, limiter);
        pages += 1;
        const series = parseSeriesLinks(navHtml);
        probes.push({
          probeKey: "series_catalog_nav",
          state: series.length >= 20 ? "OK" : series.length > 0 ? "DEGRADED" : "BROKEN",
          detail: `${series.length} series links in the nav`,
        });
        const music = series.filter((x) => isMusicSeries(x.mainCategoryId, x.catId)).map((x) => x.catId);
        const musicSet = new Set(music);
        if (startingFresh) {
          const completed = new Set(cursor.completed ?? []);
          const talk = series.filter((x) => !musicSet.has(x.catId));
          // Never-seen series first; already-completed ones get their page-1 check after.
          cursor.pending = [
            ...talk.filter((x) => !completed.has(x.catId)).map((x) => x.catId),
            ...talk.filter((x) => completed.has(x.catId)).map((x) => x.catId),
          ];
        } else if (cursor.pending?.length) {
          // A walk in progress drops any music series it had queued.
          cursor.pending = cursor.pending.filter((id) => !musicSet.has(id));
        }
        cursor.musicCatIds = music;
        cursor.mainCategoryIds = Object.fromEntries(
          series.filter((x) => x.mainCategoryId).map((x) => [x.catId, x.mainCategoryId as string]),
        );
        cursor.seriesNames = Object.fromEntries(series.filter((x) => x.name).map((x) => [x.catId, x.name as string]));
        cursor.catalogVersion = YIDDISH24_CATALOG_PARSER_VERSION;
        // Keep the main-category label per series: the listing rows do not
        // carry it, and it is the only honest source for an item's category.
        cursor.categories = Object.fromEntries(
          series.filter((x) => x.mainCategoryLabel).map((x) => [x.catId, x.mainCategoryLabel as string]),
        );
        cursor.catalogAt = new Date().toISOString();
        await saveCursor(cursor);
      }
    }

    // 2. Walk the series, one page at a time.
    while (pages < maxPages) {
      if (!cursor.catId) {
        const music = new Set(cursor.musicCatIds ?? []);
        let next = cursor.pending?.shift() ?? null;
        while (next && music.has(next)) next = cursor.pending?.shift() ?? null;
        cursor.catId = next;
        cursor.page = 1;
        if (!cursor.catId) {
          stoppedReason = "catalog walked";
          break;
        }
      }
      if ((cursor.musicCatIds ?? []).includes(cursor.catId)) {
        // A series already in hand when it was found to be music: leave it.
        cursor.catId = null;
        cursor.page = 1;
        cursor.totalPages = null;
        continue;
      }
      const catId = cursor.catId;
      const page = Math.max(1, cursor.page ?? 1);
      const alreadyCompleted = (cursor.completed ?? []).includes(catId);

      let html: string;
      let totalPages: number | null = cursor.totalPages ?? null;
      if (page === 1) {
        html = await getText(`${YIDDISH24_ORIGIN}/cat/${encodeURIComponent(catId)}/`, limiter);
        const inputs = parseTotalPages(html);
        totalPages = inputs.totalPages;
        cursor.totalPages = totalPages;
        if (probes.every((x) => x.probeKey !== "listing_pagination_inputs")) {
          probes.push({
            probeKey: "listing_pagination_inputs",
            state: inputs.totalPages && inputs.perPage ? "OK" : "BROKEN",
            detail: `totalPages=${inputs.totalPages} perPage=${inputs.perPage} catID=${inputs.catId}`,
          });
        }
      } else {
        const body = new URLSearchParams({
          page_no: String(page),
          data_id: catId,
          total_pages: String(totalPages ?? page + 1),
          page_limit: "10",
          cat_id: "",
        }).toString();
        const raw = await getText(`${YIDDISH24_ORIGIN}/ajax/cat_pagination.php`, limiter, {
          method: "POST",
          body,
          referer: `${YIDDISH24_ORIGIN}/cat/${catId}/`,
        });
        const parsed = parsePaginationResponse(raw);
        html = parsed.html;
        if (probes.every((x) => x.probeKey !== "ajax_cat_pagination")) {
          probes.push({
            probeKey: "ajax_cat_pagination",
            state: html ? "OK" : "BROKEN",
            detail: html ? `page ${parsed.currPage} → next ${parsed.nextPage}` : "no result html in the response",
          });
        }
      }
      pages += 1;

      const parsedItems = parseListingHtml(html, { category: cursor.categories?.[catId] ?? null });
      if (probes.every((x) => x.probeKey !== "listing_item_attributes")) {
        const withMedia = parsedItems.filter((i) => i.mediaUrl).length;
        probes.push({
          probeKey: "listing_item_attributes",
          state: parsedItems.length > 0 && withMedia > 0 ? "OK" : parsedItems.length > 0 ? "DEGRADED" : "BROKEN",
          detail: `${parsedItems.length} items, ${withMedia} with a media url`,
        });
      }
      if (probes.every((x) => x.probeKey !== "series_name_base64")) {
        const named = parsedItems.filter((i) => i.seriesName).length;
        probes.push({
          probeKey: "series_name_base64",
          state: parsedItems.length === 0 ? "DEGRADED" : named > 0 ? "OK" : "BROKEN",
          detail: `${named}/${parsedItems.length} items decoded a series name`,
        });
      }

      let fresh = 0;
      for (const parsed of parsedItems) {
        const res = await upsertItem(db, source, parsed);
        if (res.created) {
          discovered += 1;
          fresh += 1;
          newItemIds.push(res.id);
        } else {
          duplicates += 1;
        }
      }

      const noMorePages = totalPages != null && page >= totalPages;
      const exhausted = parsedItems.length === 0;
      // Incremental: an already-walked series whose newest page holds nothing
      // unseen is done for this run. `full` walks it anyway.
      const caughtUp = !opts.full && alreadyCompleted && fresh === 0;
      if (noMorePages || exhausted || caughtUp) {
        cursor.completed = [...new Set([...(cursor.completed ?? []), catId])];
        cursor.catId = null;
        cursor.page = 1;
        cursor.totalPages = null;
      } else {
        cursor.page = page + 1;
      }
      await saveCursor(cursor);
    }
    if (!stoppedReason && pages >= maxPages) stoppedReason = "page budget reached";
  } catch (err: any) {
    if (err instanceof Yiddish24Blocked) {
      // ⛔ Hard stop. We do not retry into a rate limit or a challenge.
      probes.push({
        probeKey: "listing_item_attributes",
        state: "BLOCKED",
        detail: err.message,
      });
      stoppedReason = err.message;
      await saveCursor(cursor).catch(() => {});
      return { discovered, duplicates, pages, healthy: false, newItemIds, probes, stoppedReason };
    }
    stoppedReason = String(err?.message || err).slice(0, 300);
    probes.push({ probeKey: "listing_item_attributes", state: "DEGRADED", detail: stoppedReason });
    await saveCursor(cursor).catch(() => {});
    return { discovered, duplicates, pages, healthy: false, newItemIds, probes, stoppedReason };
  }

  await db.ycSource.update({ where: { id: source.id }, data: { lastRunAt: new Date() } }).catch(() => {});
  const healthy = probes.every((p) => p.state === "OK" || p.state === "DEGRADED");
  return { discovered, duplicates, pages, healthy, newItemIds, probes, stoppedReason };
}

/** Upsert one parsed item; fingerprint collisions land as DUPLICATE, not as a new row. */
async function upsertItem(
  db: any,
  source: any,
  parsed: Yiddish24Item,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.ycSourceItem.findUnique({
    where: { sourceId_externalId: { sourceId: source.id, externalId: parsed.externalId } },
  });
  const data: Record<string, unknown> = {
    canonicalUrl: parsed.canonicalUrl,
    title: parsed.title,
    seriesName: parsed.seriesName,
    category: parsed.category,
    host: parsed.host,
    publishedLabel: parsed.publishedLabel,
    durationSec: parsed.durationSec,
    mediaUrl: parsed.mediaUrl,
    imageUrl: parsed.imageUrl,
    metadata: parsed.metadata as any,
    fingerprint: parsed.fingerprint,
  };
  if (existing) {
    await db.ycSourceItem.update({ where: { id: existing.id }, data });
    return { id: existing.id, created: false };
  }
  const twin = await db.ycSourceItem.findFirst({
    where: { sourceId: source.id, fingerprint: parsed.fingerprint },
    select: { id: true },
  });
  const created = await db.ycSourceItem.create({
    data: {
      ...data,
      sourceId: source.id,
      externalId: parsed.externalId,
      state: twin ? "DUPLICATE" : "DISCOVERED",
      duplicateOfId: twin?.id ?? null,
    },
  });
  return { id: created.id, created: !twin };
}

// ── audio: the refusal is the default path ──────────────────────────────────

export interface FetchAudioResult {
  fetched: boolean;
  reason: string | null;
  assetId?: string;
  sha256?: string;
  bytes?: number;
  durationMs?: number | null;
  storagePath?: string;
}

/** Where fetched audio lands when — and only when — a grant exists. */
export function yiddishCorpusAudioDir(): string {
  return process.env.YC_AUDIO_DIR || "/data/yiddish-corpus/audio";
}

/**
 * THE ONE GATE, with its rows loaded.
 *
 * `assertAudioFetchAllowed` is pure (source + rights in, decision out). This is
 * the only function in the folder that fetches those rows for it, so there is
 * exactly one code path to audit. It FAILS CLOSED: a missing source, a missing
 * rights table, a thrown query — every one of them answers `ok: false`.
 */
export async function resolveAudioGate(
  db: any,
  sourceKey: string = YIDDISH24_SOURCE_KEY,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const source = await db.ycSource.findUnique({ where: { key: sourceKey }, include: { rights: true } });
    if (!source) {
      return { ok: false, reason: `the source "${sourceKey}" is not registered, so no audio is fetched` };
    }
    const decision = assertAudioFetchAllowed(source as any, source.rights ?? []);
    return { ok: decision.ok === true, reason: decision.reason ?? null };
  } catch (err: any) {
    return { ok: false, reason: `the rights gate could not answer: ${String(err?.message || err).slice(0, 200)}` };
  }
}

/**
 * ⛔⛔ READ THE SHAPE OF THIS FUNCTION BEFORE CHANGING IT.
 *
 * The refusal is the DEFAULT PATH: everything up to the gate returns
 * `{ fetched: false }`, and the fetch lives inside one `if` behind
 * `assertAudioFetchAllowed()`. The `Referer` header for the media host is
 * written in exactly one place — inside that branch — because sending it is
 * the OWNER'S recorded decision about an access control on someone else's
 * server, never this code's.
 *
 * Do not lift the fetch out, do not add an `opts.force`, and do not hoist the
 * header to a constant. The whole point is that the only way to reach the
 * fetch is through the gate.
 */
export async function fetchAudio(db: any, item: any): Promise<FetchAudioResult> {
  if (!item?.mediaUrl) return { fetched: false, reason: "this item has no media url" };

  const gate = await resolveAudioGate(db, YIDDISH24_SOURCE_KEY);

  if (!gate || gate.ok !== true) {
    // DEFAULT PATH. No request is made, no header is sent, nothing is stored.
    return { fetched: false, reason: gate?.reason || YC_AUDIO_BLOCKED_MESSAGE };
  }

  // ── gated branch: the owner has recorded a rights grant ──────────────────
  const dir = yiddishCorpusAudioDir();
  await mkdir(dir, { recursive: true });
  const base = `${item.id || item.externalId}-${(item.mediaUrl.split("/").pop() || "audio.mp3").replace(/[^\w.\-]/g, "_")}`;
  const dest = path.join(dir, base);

  const res = await theFetch()(item.mediaUrl, {
    headers: {
      "user-agent": YIDDISH24_USER_AGENT,
      accept: "audio/*,*/*;q=0.8",
      // The owner's recorded decision, applied here and nowhere else.
      referer: `${YIDDISH24_ORIGIN}/`,
    },
  });
  if (!res?.ok) {
    return { fetched: false, reason: `media host answered ${res?.status ?? "no status"}` };
  }

  const hash = createHash("sha256");
  try {
    if (res.body && typeof Readable.fromWeb === "function") {
      const stream = Readable.fromWeb(res.body as any);
      stream.on("data", (chunk: Buffer) => hash.update(chunk));
      await pipeline(stream, createWriteStream(dest));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      hash.update(buf);
      await pipeline(Readable.from(buf), createWriteStream(dest));
    }
  } catch (err: any) {
    await unlink(dest).catch(() => {});
    return { fetched: false, reason: `write failed: ${String(err?.message || err).slice(0, 200)}` };
  }

  const sha256 = hash.digest("hex");
  const bytes = await stat(dest).then((s) => s.size).catch(() => 0);
  const probed = await probeAudio(dest);

  const asset = await db.ycAudioAsset.create({
    data: {
      itemId: item.id,
      storage: "STORED",
      uri: item.mediaUrl,
      storageKey: dest,
      sha256,
      bytes,
      durationMs: probed.available ? probed.durationMs ?? null : null,
      sampleRate: probed.available ? probed.sampleRate ?? null : null,
      channels: probed.available ? probed.channels ?? null : null,
      codec: probed.available ? probed.codec ?? null : null,
      kind: "EXTERNAL",
    },
  });

  return {
    fetched: true,
    reason: null,
    assetId: asset.id,
    sha256,
    bytes,
    durationMs: probed.available ? probed.durationMs ?? null : null,
    storagePath: dest,
  };
}

// ── health probes ───────────────────────────────────────────────────────────

/**
 * Check every parser assumption against the live site and answer health rows.
 * A run that finds nothing is only meaningful next to these: without them a
 * changed page reads as "the archive had nothing new today".
 *
 * ⛔ `probeMediaHost` defaults to FALSE. We do not contact the media host to
 * "confirm" its restriction; the restriction is recorded and respected.
 */
export async function probeSite(
  opts: { requestsPerMinute?: number | null; probeMediaHost?: boolean; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<YcProbeResult[]> {
  const limiter = createRateLimiter(opts.requestsPerMinute ?? null, { now: opts.now, sleep: opts.sleep });
  const out: YcProbeResult[] = [];
  const push = (probeKey: string, state: string, detail: string | null) => out.push({ probeKey, state, detail });

  // 1. A listing page: item attributes, hidden inputs, base64 series names.
  try {
    const html = await getText(`${YIDDISH24_ORIGIN}/cat/11/`, limiter);
    const items = parseListingHtml(html);
    const inputs = parseTotalPages(html);
    const withMedia = items.filter((i) => i.mediaUrl).length;
    const withTitle = items.filter((i) => i.title).length;
    const withSeries = items.filter((i) => i.seriesName).length;
    push(
      "listing_item_attributes",
      items.length > 0 && withMedia > 0 && withTitle > 0 ? "OK" : items.length > 0 ? "DEGRADED" : "BROKEN",
      `${items.length} items · ${withMedia} media · ${withTitle} titles`,
    );
    push(
      "listing_pagination_inputs",
      inputs.totalPages && inputs.perPage ? "OK" : "BROKEN",
      `totalPages=${inputs.totalPages} perPage=${inputs.perPage}`,
    );
    push(
      "series_name_base64",
      withSeries > 0 ? "OK" : "BROKEN",
      `${withSeries}/${items.length} series names decoded from base64`,
    );
    const series = parseSeriesLinks(html);
    push(
      "series_catalog_nav",
      series.length >= 20 ? "OK" : series.length > 0 ? "DEGRADED" : "BROKEN",
      `${series.length} series links`,
    );

    // 2. The undocumented pagination endpoint.
    try {
      const body = new URLSearchParams({
        page_no: "2",
        data_id: "11",
        total_pages: String(inputs.totalPages ?? 2),
        page_limit: String(inputs.perPage ?? 10),
        cat_id: "",
      }).toString();
      const raw = await getText(`${YIDDISH24_ORIGIN}/ajax/cat_pagination.php`, limiter, {
        method: "POST",
        body,
        referer: `${YIDDISH24_ORIGIN}/cat/11/`,
      });
      const parsed = parsePaginationResponse(raw);
      const pageItems = parseListingHtml(parsed.html);
      push(
        "ajax_cat_pagination",
        pageItems.length > 0 ? "OK" : "BROKEN",
        `page ${parsed.currPage} returned ${pageItems.length} items`,
      );
    } catch (err: any) {
      push("ajax_cat_pagination", err instanceof Yiddish24Blocked ? "BLOCKED" : "BROKEN", String(err?.message || err).slice(0, 200));
    }
  } catch (err: any) {
    const state = err instanceof Yiddish24Blocked ? "BLOCKED" : "BROKEN";
    push("listing_item_attributes", state, String(err?.message || err).slice(0, 200));
    push("listing_pagination_inputs", state, "listing page unreachable");
    push("series_name_base64", state, "listing page unreachable");
    push("series_catalog_nav", state, "listing page unreachable");
    push("ajax_cat_pagination", state, "listing page unreachable");
  }

  // 3. No feed, no sitemap — the reason this adapter scrapes HTML at all.
  for (const [key, url] of [
    ["no_rss_feed", `${YIDDISH24_ORIGIN}/rss`],
    ["no_sitemap", `${YIDDISH24_ORIGIN}/sitemap.xml`],
  ] as const) {
    try {
      await getText(url, limiter);
      // A feed APPEARING is good news and a reason to stop scraping.
      push(key, "DEGRADED", `${url} now answers — a feed would be cheaper and kinder than HTML listings`);
    } catch {
      push(key, "OK", `${url} is absent, as expected`);
    }
  }

  // 4. The media host. Recorded, never tested.
  push(
    "audio_referer_required",
    opts.probeMediaHost ? "DEGRADED" : "BLOCKED",
    opts.probeMediaHost
      ? "media-host probing was requested but this adapter does not contact the media host"
      : "cloudfront.yiddish24.com refuses requests that do not come from the site's own pages. " +
        "We do not contact it and do not send that header without a recorded rights grant.",
  );

  return out;
}
