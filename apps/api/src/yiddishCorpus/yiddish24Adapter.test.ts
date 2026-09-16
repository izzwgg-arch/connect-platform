/**
 * Yiddish24 adapter — parser and politeness tests.
 *
 * ⛔ NO NETWORK. Every HTML string here is a TRIMMED VERBATIM excerpt of a real
 * yiddish24.com page saved under ./fixtures on 2026-09-15. That is the point:
 * a site change has to fail a test rather than quietly return zero items and
 * read like a slow news day.
 *
 * ⛔ AND NO AUDIO. Nothing in this file touches cloudfront.yiddish24.com. The
 * audio tests assert the REFUSAL — that `fetchAudio` makes no request at all
 * while the rights gate says no.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createRateLimiter,
  discover,
  decodeSeriesName,
  encodeSeriesName,
  fetchAudio,
  fingerprintItem,
  parseDuration,
  parseListingHtml,
  parsePaginationResponse,
  parseSeriesLinks,
  parseTotalPages,
  resolveAudioGate,
  setYiddish24Fetch,
  YIDDISH24_MIN_REQUEST_GAP_MS,
} from "./yiddish24Adapter";

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");

const LISTING = fixture("yiddish24-listing-cat11.html");
const NAV = fixture("yiddish24-nav-series.html");
const PAGINATION = fixture("yiddish24-pagination-page2.json");

// ── 1. the listing parser, against a real saved page ────────────────────────

test("parseListingHtml pulls every field off a real /cat/ listing page", () => {
  const items = parseListingHtml(LISTING);
  assert.equal(items.length, 10, "a listing page holds exactly 10 items");

  // Every item must carry the fields the pipeline depends on.
  for (const it of items) {
    assert.match(it.externalId, /^\d+$/, `post id looks wrong: ${it.externalId}`);
    assert.ok(it.mediaUrl && it.mediaUrl.startsWith("https://"), `no media url on ${it.externalId}`);
    assert.ok(it.title && it.title.length > 3, `no title on ${it.externalId}`);
    assert.ok(it.seriesName && it.seriesName.length > 1, `no decoded series name on ${it.externalId}`);
    assert.ok(it.durationSec && it.durationSec > 0, `no duration on ${it.externalId}`);
    assert.ok(it.fingerprint.length >= 32, "fingerprint missing");
    // The site publishes a Hebrew-calendar label and nothing else. We keep it
    // verbatim and never invent a Gregorian date from it.
    assert.ok(it.publishedLabel && it.publishedLabel.length > 2, `no date label on ${it.externalId}`);
    assert.equal(it.host, null, "the site publishes no host field — we must not invent one");
  }

  const first = items[0];
  assert.equal(first.externalId, "147575");
  assert.equal(
    first.mediaUrl,
    "https://cloudfront.yiddish24.com/Kol_Mivaser_12526_Rabbi_Y_Derebarindiger__612555221.mp3",
  );
  assert.equal(first.durationSec, 35 * 60 + 53);
  assert.equal(first.seriesName, "מרדכי וויינבערגער");
  assert.ok(first.imageUrl?.startsWith("https://cloudfront.yiddish24.com/"));
  assert.ok((first.metadata as any).description, "the one-line description is carried when present");

  // Post ids are unique across the page — proximity parsing would duplicate.
  assert.equal(new Set(items.map((i) => i.externalId)).size, 10);
});

test("parseListingHtml parses the SAME markup out of the ajax pagination response", () => {
  const parsed = parsePaginationResponse(PAGINATION);
  assert.equal(parsed.currPage, 2);
  assert.equal(parsed.nextPage, 3);
  assert.ok(parsed.html.length > 1000);

  const items = parseListingHtml(parsed.html);
  assert.equal(items.length, 10);
  assert.equal(items[0].externalId, "140225");
  assert.ok(items.every((i) => i.mediaUrl && i.title && i.seriesName));
});

test("parseListingHtml answers an empty list — not a throw — on rubbish", () => {
  assert.deepEqual(parseListingHtml(""), []);
  assert.deepEqual(parseListingHtml("<html><body>nothing here</body></html>"), []);
  assert.deepEqual(parsePaginationResponse("not json").html, "");
});

test("parseTotalPages reads the hidden inputs the pagination POST needs", () => {
  const inputs = parseTotalPages(LISTING);
  assert.equal(inputs.totalPages, 27);
  assert.equal(inputs.perPage, 10);
  assert.equal(inputs.catId, "11");

  // A page that lost them must read as null, so the probe can call it BROKEN
  // instead of the walker guessing.
  const stripped = LISTING.replace(/<input[^>]*id="(?:totalPages|perPage)"[^>]*>/g, "");
  const gone = parseTotalPages(stripped);
  assert.equal(gone.totalPages, null);
  assert.equal(gone.perPage, null);
});

test("parseSeriesLinks finds the whole series catalog in one page's nav", () => {
  const series = parseSeriesLinks(NAV);
  assert.ok(series.length >= 30, `expected the nav to carry the catalog, got ${series.length}`);
  const byId = new Map(series.map((s) => [s.catId, s]));
  const bulletin = byId.get("57");
  assert.ok(bulletin, "series 57 (בולעטין) should be in the nav");
  assert.equal(bulletin!.name, "בולעטין");
  assert.equal(bulletin!.mainCategoryId, "1");
  assert.ok(series.every((s) => /^\d+$/.test(s.catId)));
  assert.equal(new Set(series.map((s) => s.catId)).size, series.length, "no duplicate series ids");
});

// ── 2. the small pure functions ─────────────────────────────────────────────

test("parseDuration reads the site's clock strings and refuses everything else", () => {
  assert.equal(parseDuration("1:09:40"), 4180);
  assert.equal(parseDuration("35:53"), 2153);
  assert.equal(parseDuration("0:26"), 26);
  assert.equal(parseDuration("<i>35:53</i>"), 2153);
  assert.equal(parseDuration("  12:00:00 "), 43200);
  // A wrong duration is worse than a missing one — novelty scores on it.
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("--:--"), null);
});

test("decodeSeriesName round-trips the site's base64-of-urlencoded Hebrew", () => {
  // Real values lifted from the saved pages.
  assert.equal(decodeSeriesName("JUQ3JTkxJUQ3JTk1JUQ3JTlDJUQ3JUEyJUQ3JTk4JUQ3JTk5JUQ3JTlG"), "בולעטין");
  assert.equal(
    decodeSeriesName(
      "JUQ3JTlFJUQ3JUE4JUQ3JTkzJUQ3JTlCJUQ3JTk5KyVENyU5NSVENyU5NSVENyU5OSVENyU5OSVENyVBMCVENyU5MSVENyVBMiVENyVBOCVENyU5MiVENyVBMiVENyVBOA==",
    ),
    // the `+` inside the decoded percent-string is a SPACE, not a plus
    "מרדכי וויינבערגער",
  );
  for (const name of ["בולעטין", "מרדכי וויינבערגער", "Kol Mevaser", "א ב ג"]) {
    assert.equal(decodeSeriesName(encodeSeriesName(name)), name, `round trip failed for ${name}`);
  }
  assert.equal(decodeSeriesName(null), null);
  assert.equal(decodeSeriesName(""), null);
  assert.equal(decodeSeriesName("!!!not base64!!!"), null);
});

test("fingerprintItem collides on the same CONTENT and separates different content", () => {
  const a = {
    externalId: "1",
    mediaUrl: "https://cloudfront.yiddish24.com/Kol_Mivaser_1.mp3",
    durationSec: 2153,
    title: "פראגן פון די טעראפיסט",
    seriesName: "מרדכי וויינבערגער",
  };
  // Same episode re-posted under a NEW post id must dedupe.
  const reposted = { ...a, externalId: "999" };
  assert.equal(fingerprintItem(a), fingerprintItem(reposted));
  // Whitespace and case in the title must not split it either.
  assert.equal(fingerprintItem({ ...reposted, title: "  פראגן   פון די טעראפיסט " }), fingerprintItem(a));
  // A different episode must not collide.
  assert.notEqual(fingerprintItem({ ...a, mediaUrl: "https://cloudfront.yiddish24.com/Other.mp3" }), fingerprintItem(a));
  assert.notEqual(fingerprintItem({ ...a, durationSec: 60 }), fingerprintItem(a));

  // And on a real page every item is its own fingerprint.
  const items = parseListingHtml(LISTING);
  assert.equal(new Set(items.map((i) => i.fingerprint)).size, items.length);
});

// ── 3. politeness: the limiter really spaces requests ───────────────────────

test("the rate limiter spaces requests at least 2s apart, and a budget can only slow it", async () => {
  let clock = 1_000_000;
  const slept: number[] = [];
  const limiter = createRateLimiter(30, {
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms; // a real sleep advances the clock; the fake one must too
    },
  });
  assert.equal(limiter.minGapMs, YIDDISH24_MIN_REQUEST_GAP_MS);

  await limiter.wait();
  await limiter.wait();
  await limiter.wait();
  assert.deepEqual(slept, [2000, 2000], "first request is free, every later one waits the gap");

  // A caller that does its own work between requests waits less, never more.
  clock += 1_500;
  await limiter.wait();
  assert.equal(slept[slept.length - 1], 500);

  // ⛔ A budget CANNOT make this faster than the floor.
  const greedy = createRateLimiter(6000);
  assert.equal(greedy.minGapMs, YIDDISH24_MIN_REQUEST_GAP_MS);
  const lazy = createRateLimiter(6); // 6/min = one every 10s
  assert.equal(lazy.minGapMs, 10_000);
  // Nonsense values fall back to the ceiling, never to "no limit".
  assert.equal(createRateLimiter(0).minGapMs, YIDDISH24_MIN_REQUEST_GAP_MS);
  assert.equal(createRateLimiter(NaN as any).minGapMs, YIDDISH24_MIN_REQUEST_GAP_MS);
  assert.equal(createRateLimiter(null).minGapMs, YIDDISH24_MIN_REQUEST_GAP_MS);
});

test("the limiter serializes: three callers firing at once still cost three gaps", async () => {
  let clock = 0;
  const slept: number[] = [];
  const limiter = createRateLimiter(30, {
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  // Three callers with no coordination of their own — "one page at a time" has
  // to come from the limiter, not from the caller being careful.
  await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
  assert.deepEqual(slept, [2000, 2000]);
  assert.equal(clock, 4000, "three concurrent requests span two full gaps");
});

// ── 4. ⛔ the audio refusal is the default path ──────────────────────────────

function sourceRow(over: Record<string, unknown> = {}) {
  return {
    id: "src1",
    key: "yiddish24",
    name: "Yiddish24",
    kind: "EXTERNAL_ADAPTER",
    governanceClass: "EXTERNAL",
    trainingExportEligibility: "UNKNOWN",
    contentAllowed: true,
    audioFetchMode: "DISABLED",
    enabled: true,
    rights: [],
    ...over,
  };
}

function fakeDb(source: any) {
  return {
    ycSource: { findUnique: async () => source },
    ycAudioAsset: {
      create: async ({ data }: any) => ({ id: "asset1", ...data }),
    },
  } as any;
}

test("fetchAudio makes NO request while the gate refuses — the refusal is the default path", async () => {
  let calls = 0;
  setYiddish24Fetch(async () => {
    calls += 1;
    throw new Error("the adapter must not reach the network while the gate refuses");
  });
  try {
    const item = { id: "i1", externalId: "1", mediaUrl: "https://cloudfront.yiddish24.com/x.mp3" };

    // (a) default source: DISABLED, no rights records.
    let res = await fetchAudio(fakeDb(sourceRow()), item);
    assert.equal(res.fetched, false);
    assert.match(String(res.reason), /rights grant|not fetched/i);
    assert.equal(calls, 0);

    // (b) mode flipped but NO grant recorded — still refuses.
    res = await fetchAudio(fakeDb(sourceRow({ audioFetchMode: "OWNER_AUTHORIZED" })), item);
    assert.equal(res.fetched, false);
    assert.equal(calls, 0);

    // (c) a grant recorded but the mode still DISABLED — still refuses.
    res = await fetchAudio(
      fakeDb(sourceRow({ rights: [{ allowedUse: "store_audio", state: "GRANTED" }] })),
      item,
    );
    assert.equal(res.fetched, false);
    assert.equal(calls, 0);

    // (d) the source row missing entirely — fails CLOSED.
    res = await fetchAudio(fakeDb(null), item);
    assert.equal(res.fetched, false);
    assert.equal(calls, 0);

    // (e) the gate throwing — fails CLOSED.
    const angry = { ycSource: { findUnique: async () => { throw new Error("db down"); } } } as any;
    res = await fetchAudio(angry, item);
    assert.equal(res.fetched, false);
    assert.equal(calls, 0);

    // (f) no media url at all.
    res = await fetchAudio(fakeDb(sourceRow()), { id: "i2", externalId: "2", mediaUrl: null });
    assert.equal(res.fetched, false);
    assert.equal(calls, 0);
  } finally {
    setYiddish24Fetch(null);
  }
});

test("resolveAudioGate only says yes with BOTH the owner mode and a recorded grant", async () => {
  assert.equal((await resolveAudioGate(fakeDb(sourceRow()))).ok, false);
  assert.equal(
    (await resolveAudioGate(fakeDb(sourceRow({ audioFetchMode: "OWNER_AUTHORIZED" })))).ok,
    false,
  );
  assert.equal(
    (
      await resolveAudioGate(
        fakeDb(sourceRow({ audioFetchMode: "OWNER_AUTHORIZED", rights: [{ allowedUse: "store_audio", state: "DENIED" }] })),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await resolveAudioGate(
        fakeDb(sourceRow({ audioFetchMode: "OWNER_AUTHORIZED", rights: [{ allowedUse: "store_audio", state: "GRANTED" }] })),
      )
    ).ok,
    true,
  );
});

// ── 5. discovery: polite, resumable, and it stops dead when told to ─────────

/** The smallest db discover() needs, plus a record of what it wrote. */
function discoveryDb(source: any) {
  const items: any[] = [];
  return {
    items,
    updates: [] as any[],
    ycSource: {
      findUnique: async () => source,
      update: async ({ data }: any) => {
        Object.assign(source, data);
        return source;
      },
    },
    ycSourceItem: {
      findUnique: async ({ where }: any) =>
        items.find(
          (i) =>
            i.sourceId === where.sourceId_externalId.sourceId &&
            i.externalId === where.sourceId_externalId.externalId,
        ) ?? null,
      findFirst: async ({ where }: any) =>
        items.find((i) => i.fingerprint === where.fingerprint && i.id !== where.NOT?.id) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `item-${items.length + 1}`, ...data };
        items.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = items.find((i) => i.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  } as any;
}

test("discover walks a series, upserts real items, and leaves a resumable cursor", async () => {
  const source = {
    ...sourceRow(),
    budget: { requestsPerMinute: 30, paused: false, mode: "METADATA_ONLY" },
    discoveryCursor: null,
  };
  const db = discoveryDb(source);
  const asked: string[] = [];

  setYiddish24Fetch(async (url: any, init: any) => {
    asked.push(`${init?.method ?? "GET"} ${String(url)}`);
    const u = String(url);
    if (u.includes("/mainCategory/")) return { ok: true, status: 200, text: async () => NAV };
    if (u.includes("/cat/")) return { ok: true, status: 200, text: async () => LISTING };
    if (u.includes("cat_pagination")) return { ok: true, status: 200, text: async () => PAGINATION };
    return { ok: false, status: 404, text: async () => "" };
  });
  try {
    const res = await discover(db, { maxPages: 3, requestsPerMinute: 6000, sleep: async () => {} });
    assert.equal(res.healthy, true);
    assert.ok(res.discovered >= 10, `expected real items, got ${res.discovered}`);
    assert.equal(res.pages, 3);

    // The catalog read costs ONE request, then it walks series pages.
    assert.match(asked[0], /mainCategory/);
    assert.ok(asked.slice(1).every((a) => /\/cat\/|cat_pagination/.test(a)));

    // Every probe reported, and the item rows carry the decoded series name.
    const keys = res.probes.map((p) => p.probeKey).sort();
    assert.deepEqual(keys, ["ajax_cat_pagination", "listing_item_attributes", "listing_pagination_inputs", "series_catalog_nav", "series_name_base64"]);
    assert.ok(res.probes.every((p) => p.state === "OK"), JSON.stringify(res.probes));
    assert.ok(db.items.every((i: any) => i.seriesName && !/^[A-Za-z0-9+/=]{20,}$/.test(i.seriesName)), "base64 must be decoded at ingest");

    // Resumable: the cursor was written and names where to continue.
    const cursor = JSON.parse(String(source.discoveryCursor));
    assert.ok(Array.isArray(cursor.pending) && cursor.pending.length > 0);
    assert.ok(cursor.catId || cursor.completed?.length);
  } finally {
    setYiddish24Fetch(null);
  }
});

test("⛔ discover stops DEAD on a 429 and reports BLOCKED — it never retries into a rate limit", async () => {
  const source = { ...sourceRow(), budget: { requestsPerMinute: 30 }, discoveryCursor: null };
  const db = discoveryDb(source);
  let calls = 0;
  setYiddish24Fetch(async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "slow down" };
  });
  try {
    const res = await discover(db, { maxPages: 10, requestsPerMinute: 6000, sleep: async () => {} });
    assert.equal(calls, 1, "one refusal is enough — no retry storm");
    assert.equal(res.healthy, false);
    assert.equal(res.discovered, 0);
    assert.ok(res.probes.some((p) => p.state === "BLOCKED"));
    assert.match(String(res.stoppedReason), /429/);
  } finally {
    setYiddish24Fetch(null);
  }
});

test("⛔ a Cloudflare challenge is BLOCKED too, not parsed as an empty catalog", async () => {
  const source = { ...sourceRow(), budget: { requestsPerMinute: 30 }, discoveryCursor: null };
  const db = discoveryDb(source);
  setYiddish24Fetch(async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><title>Just a moment...</title><div id=cf-challenge></div></html>",
  }));
  try {
    const res = await discover(db, { maxPages: 5, requestsPerMinute: 6000, sleep: async () => {} });
    assert.equal(res.healthy, false);
    assert.ok(res.probes.some((p) => p.state === "BLOCKED"));
  } finally {
    setYiddish24Fetch(null);
  }
});

test("discover refuses to run at all when the source is disabled or its budget is paused", async () => {
  setYiddish24Fetch(async () => {
    throw new Error("discover must not touch the network when it is switched off");
  });
  try {
    const off = discoveryDb({ ...sourceRow({ enabled: false }), budget: null });
    assert.equal((await discover(off)).stoppedReason, "source disabled");
    const paused = discoveryDb({ ...sourceRow(), budget: { paused: true } });
    assert.equal((await discover(paused)).stoppedReason, "budget paused");
    const missing = discoveryDb(null);
    assert.equal((await discover(missing)).stoppedReason, "source not registered");
  } finally {
    setYiddish24Fetch(null);
  }
});

test("SOURCE GUARD: the media-host Referer appears in exactly one gated place", () => {
  const src = readFileSync(path.join(__dirname, "yiddish24Adapter.ts"), "utf8").replace(/\r\n/g, "\n");
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  // One `referer:` literal pointing at the site's own origin, inside fetchAudio.
  const hits = body.match(/referer:\s*`\$\{YIDDISH24_ORIGIN\}\/`/g) || [];
  assert.equal(hits.length, 1, "the media-host Referer must live in exactly one gated branch");
  const gateAt = body.indexOf("resolveAudioGate(db, YIDDISH24_SOURCE_KEY)");
  const refererAt = body.indexOf("referer: `${YIDDISH24_ORIGIN}/`");
  assert.ok(gateAt > 0 && refererAt > gateAt, "the Referer must sit AFTER the gate, never before it");
  // And no constant hoisting it out of the gate.
  assert.equal(/const\s+\w*REFERER\w*\s*=/.test(body), false, "do not hoist the Referer to a constant");
});

test("an item's category is never a CSS colour", () => {
  // Real defect: the fallback was attrs["data-cat-color"], so every catalogued
  // item was filed under "darkred".
  const html = readFileSync(path.join(__dirname, "fixtures", "yiddish24-listing-cat11.html"), "utf8");
  const items = parseListingHtml(html);
  assert.ok(items.length > 0, "fixture should parse items");
  for (const item of items) {
    assert.ok(
      item.category === null || !/^(dark|light)?(red|blue|green|orange|purple|grey|gray|black|white)$/i.test(item.category),
      `category was a colour: ${item.category}`,
    );
  }
  // and when the caller knows the real one, it is used
  const withCat = parseListingHtml(html, { category: "Interviews" });
  assert.equal(withCat[0].category, "Interviews");
});

test("a walk already in progress still learns the category map, without losing its place", async () => {
  // The listing rows carry no category, so the nav map is the only honest
  // source for one. It used to be written only when a walk STARTED, so a walk
  // already under way filed every item as null until the whole 136-series
  // catalog finished. This pins the mid-walk refresh — and pins that it does
  // NOT reshuffle the queue.
  const calls: string[] = [];
  setYiddish24Fetch(async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/mainCategory/1")) {
      return { ok: true, status: 200, text: async () => NAV };
    }
    return { ok: true, status: 200, text: async () => LISTING };
  });
  try {
    const saved: any[] = [];
    const source = {
      id: "src-1",
      key: "yiddish24",
      // Mid-walk: a series in hand, more queued, and NO category map.
      discoveryCursor: JSON.stringify({ catId: "57", page: 2, totalPages: 3, pending: ["58", "59"], completed: [] }),
    };
    const db: any = {
      ycSource: {
        findUnique: async () => source,
        findFirst: async () => source,
        update: async ({ data }: any) => {
          if (data.discoveryCursor) saved.push(JSON.parse(data.discoveryCursor));
          return source;
        },
      },
      ycBudget: { findFirst: async () => ({ paused: false, mode: "METADATA_ONLY", requestsPerMinute: 30 }) },
      ycSourceItem: { findUnique: async () => null, findFirst: async () => null, create: async ({ data }: any) => ({ id: "i1", ...data }), update: async ({ data }: any) => ({ id: "i1", ...data }) },
      ycRightsRecord: { findMany: async () => [] },
    };

    await discover(db, { maxPages: 2, sleep: async () => {} } as any);

    assert.ok(calls.some((u) => u.includes("/mainCategory/1")), "the nav must be re-read when the map is missing");
    const withCats = saved.find((c) => c.categories && Object.keys(c.categories).length > 0);
    assert.ok(withCats, "the category map must be written");
    // ⛔ And the queue must be untouched by that refresh.
    assert.equal(withCats.catId, "57", "the series in hand must not change");
    assert.deepEqual(withCats.pending, ["58", "59"], "the queue must not be reshuffled");
    assert.equal(withCats.page, 2, "the page must not be rewound");
  } finally {
    setYiddish24Fetch(null);
  }
});

// ── music: decided by the site's own grouping, never walked ─────────────────

import { isMusicItem, isMusicSeries, YIDDISH24_CATALOG_PARSER_VERSION } from "./yiddish24Adapter";

test("a series seen again later under another heading keeps its FIRST category", () => {
  // The live page carries the nav more than once. The old parser let the last
  // sighting win, which filed news bulletins as Torah and no series as news.
  const tail =
    '<div class="footer"><a href="/mainCategory/6">תורה רובריק</a>' +
    '<a class="item_inner" href="/cat/57/"><span class="item_subtitle subname_57">בולעטין</span></a></div>';
  const series = parseSeriesLinks(NAV + tail);
  const bulletin = series.find((x) => x.catId === "57");
  assert.ok(bulletin);
  assert.equal(bulletin!.mainCategoryId, "1", "57 lives in the News block and must stay there");
});

test("music is the site's category 7, and an item is music only by its series", () => {
  assert.equal(isMusicSeries("7"), true);
  assert.equal(isMusicSeries("1"), false);
  assert.equal(isMusicSeries(null), false);
  const cursor = JSON.stringify({ musicCatIds: ["90"], seriesNames: { "90": "ניגונים", "57": "בולעטין" } });
  assert.equal(isMusicItem({ seriesName: "ניגונים" }, cursor), true);
  assert.equal(isMusicItem({ seriesName: "בולעטין" }, cursor), false);
  // No catalog yet: never skip an episode on a guess.
  assert.equal(isMusicItem({ seriesName: "ניגונים" }, null), false);
  assert.equal(isMusicItem({ seriesName: "ניגונים" }, "not json"), false);
});

test("discovery never walks a music series, even one already queued, and re-reads a stale catalog", async () => {
  const musicNav =
    NAV +
    '<ul><li class="submenu_item"><a class="request-page" href="/mainCategory/7" data-id="7">נגינה</a>' +
    '<ul class="submenu_list"><li class="sub-item"><a class="item_inner request-page" href="/cat/900/">' +
    '<span class="item_subtitle subname_900">ניגונים</span></a></li></ul></li></ul>';
  const calls: string[] = [];
  setYiddish24Fetch(async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/mainCategory/1")) return { ok: true, status: 200, text: async () => musicNav };
    return { ok: true, status: 200, text: async () => LISTING };
  });
  try {
    const saved: any[] = [];
    const source: any = {
      id: "src-1",
      key: "yiddish24",
      // Built by the OLD parser (no catalogVersion), with the music series queued first.
      discoveryCursor: JSON.stringify({ catId: null, pending: ["900", "57"], completed: [], categories: { "57": "x" } }),
    };
    const db: any = {
      ycSource: {
        findUnique: async () => source,
        findFirst: async () => source,
        update: async ({ data }: any) => {
          if (data.discoveryCursor) {
            saved.push(JSON.parse(data.discoveryCursor));
            source.discoveryCursor = data.discoveryCursor;
          }
          return source;
        },
      },
      ycBudget: { findFirst: async () => ({ paused: false, mode: "METADATA_ONLY", requestsPerMinute: 30 }) },
      ycSourceItem: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async ({ data }: any) => ({ id: "i1", ...data }),
        update: async ({ data }: any) => ({ id: "i1", ...data }),
      },
      ycRightsRecord: { findMany: async () => [] },
    };
    await discover(db, { maxPages: 3, sleep: async () => {} } as any);

    assert.ok(calls.some((u) => u.includes("/mainCategory/1")), "a catalog built by the old parser must be re-read");
    assert.equal(calls.some((u) => u.includes("/cat/900")), false, "the music series must never be requested");
    const last = saved[saved.length - 1];
    assert.equal(last.catalogVersion, YIDDISH24_CATALOG_PARSER_VERSION);
    assert.deepEqual(last.musicCatIds, ["900"]);
    assert.equal((last.pending ?? []).includes("900"), false);
  } finally {
    setYiddish24Fetch(null);
  }
});

test("music videos filed under Video are excluded by their named catId", () => {
  assert.equal(isMusicSeries("8", "233"), true, "233 is the music-videos series, filed under Video");
  assert.equal(isMusicSeries("8", "247"), false, "other Video series are not music");
});
