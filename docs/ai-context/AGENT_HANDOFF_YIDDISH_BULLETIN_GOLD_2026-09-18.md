# Yiddish24 bulletin → the first NON-self-distilled labels (2026-09-18)

**Owner's find, verbatim (Izzy, 2026-09-18):** *"I'm seeing now that in the Yiddish 24
bulletin section … have news with typed-out text. … just gold for us … this way we can
train text-to-speech and speech-to-text as well, without having to use Yiddish Labs."*
Then, the same day, the correction that shapes the entire design: *"It's not 100% word for
word, but it is, I would say, 97%, so the agent is going to have to use common sense here
too."*

Parent handoffs: `AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md` (the fine-tune),
`AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md` (the engine).

## 0. Why this matters more than any other source we have

Every label in the corpus so far is **the model's own output**. 44,176 `ivrit` transcript
rows, all produced by `yi-whisper-large-v3-ct2` listening to our audio. Training a model on
its own pseudo-labels adapts it to our acoustics — telephone bandwidth, our speakers, our
rooms — but it **cannot teach it a word it gets wrong**, because the wrong word is what the
label says.

The bulletin section pairs a short news recording with the same story **typed by a human**.
That is the first label in this project that the model did not write.

**Proof it corrects real errors (item 166573, verified before any of this was built):** our
ASR heard `דאס רעדן` where the typed article reads `אפטרעטן` ("resign"), and dropped `קיר`
entirely. Neither error is fixable from our own output.

## 1. What is actually there (measured, not assumed)

| Section | seriesName | items | hours | typed article body? |
|---|---|---|---|---|
| בולעטין | `בולעטין` | 3,343 | 32.6 | **YES — full articles** |
| טרעפיק אפדעיטס | traffic | 2,417 | 79.9 | no |
| רשות הרבים | public | 1,366 | 34.4 | no |
| ביזנעס | business | 1,434 | 704 | no |
| אינטערוויוס | interviews | 437 | 489 | no |

⛔ **Izzy asked for Business and Interviews too. They have no typed text.** Their category
pages return the player placeholder only. Those 1,193 hours are machine-labelling material
(the existing Kaggle lane), never gold. Only בולעטין pairs text with audio.

⛔ **The body is ONLY on the listing page.** `/news/bulletin/<id>` — the per-item page —
carries 2,982 Hebrew characters and every one of them is navigation. A harvester that
fetched item pages would collect nothing and look like it was working.

## 2. How the listing is read

- Page 1: `GET /cat/57/`. Hidden inputs give `catID=57`, `totalPages=323..324`, `perPage=10`.
- Pages 2..N: `POST /ajax/cat_pagination.php` with
  `page_no, data_id=57, total_pages, page_limit=10, cat_id=` → JSON
  `{result: "<html>", next_page, prev_page, curr_page}`; `result` is the same markup.
- ⛔ There is **no URL form of pagination**. `/cat/57/2`, `?page=2`, `/cat/57/page/2` all
  serve page 1 with a 200, so a crawler built on them harvests page 1 three hundred times
  and reports success.
- Fetching goes through the adapter's own `getText` + `createRateLimiter`
  (`yiddish24Adapter.ts`; 2 s floor, 30 rpm ceiling, Cloudflare-challenge detection).
  `getText` was exported for this. ⛔ Never add a second fetcher: the site owner gave Izzy
  permission personally, and "polite" has to mean one crawler, not two.

## 3. ⛔⛔ TWO layouts, and keying on the wrong one silently loses 70% of the archive

Newer posts wrap the body in `<div class="content_block" data-id="_57_NNN">` (they have an
image gallery). **Older posts put the same `<p>` straight into the row with no wrapper.**

The first version of the parser anchored on `content_block`. It harvested **931 of ~3,230
articles** and reported every page from about item 164,000 backwards as **empty** — i.e. it
reported a parser miss as "the archive ends here", which is exactly the kind of failure that
gets believed. The fix anchors on the `bulletin-news-des-row` block and takes the id from
`<h1 id="song-titleNNN">`; both layouts then parse identically (verified 10/10 on live
pages 1, 2 and 150).

Also in that markup and handled: the headline appears **twice**, once inside an HTML comment
just above the real one, and a `<p class="photo-credit">` sits in the image block. Comments
are stripped before anything is read.

⛔ **Everything is looked up BY ID, never by position.** A row that renders without a player
(a pulled recording) would otherwise hand its neighbour's audio URL to the wrong article.

## 4. The headline is sometimes the first sentence and sometimes not

Item 167511: the headline is byte-identical to the body's first 141 characters.
Item 167510: headline and body share nothing. Concatenating blindly feeds the aligner the
opening sentence twice for roughly half the archive, so `titleDuplicatesBody()` drops the
headline only when the body demonstrably opens with it (≥6 shared leading tokens — two or
three is just "די ניו יארק" and must not count).

## 5. The 97% problem, and what is done about it

A 97%-accurate label handed to a trainer as truth teaches the model to produce the 3% that
was never said. So **the typed text is never a label on its own**. It is only ever used to
CORRECT a stretch our own ASR already heard in the same order:

- the **ASR** supplies the timing and the evidence that the words were spoken;
- the **publisher** supplies the correct spelling of them.

`bulletinAlign.ts`:
1. Tokenise both sides with `compareTokens` — Hebrew script only, **niqqud stripped**. The
   site points some words and not others; comparing raw strings calls two identical
   sentences different and throws away good text.
2. LCS between the heard words and the typed words → `tokenAgreement` (share of HEARD words
   the article also has, **in order**; a bag-of-words measure would score a shuffled article
   1.0).
3. Anchors = runs of ≥3 consecutive matches.
4. Spans grow from an anchor through the next while the GAP between them is small.
   ⛔ Judge a gap by its **size**, not by how much of it matches: a gap is unmatched by
   definition, so a one-word substitution — the single most valuable correction this source
   offers — scores 100% divergent, and an earlier version refused every one of them.
   Bridge ≤4 tokens; a one-sided gap (an ASR deletion like `קיר`, or a word the writer left
   out) ≤2. A clause on one side alone breaks the span.
5. Anything outside a span is dropped. There is no evidence of what was said there.

⛔ **An earlier version only emitted anchor-PAIR spans, so a recording that matched its
article perfectly — the best possible case — produced nothing at all.** Spans grow from a
single anchor for that reason.

## 6. Storage: two engines, and the split IS the safety property

| engine | timing | trainable | meaning |
|---|---|---|---|
| `publisher` | none | **no** | the typed article, whole, as published |
| `publisher_aligned` | from the AUDIO | yes | one span alignment proved |

`originRef`: `bulletin:<externalId>` and `bulletin:<externalId>#<n>`, matching the existing
`{assetId}#{chunk}` and `gold:{reviewId}` conventions.

⛔ `buildIvritClips` and `buildGoldClips` in `scripts/yiddish-finetune/build-dataset.ts`
filter on an **exact** engine string (`ivrit`, `human`). A `publisher` row is therefore inert
until something deliberately reads it — a downstream mistake reads as *no data*, never as
*wrong data*. Keep it that way.

⛔ Whisper word times are **seconds inside the chunk**; the row's `startMs` is the chunk's
offset. `timedWordsFrom` applies both. Dropping either produces timing that looks plausible
and points at the wrong audio.

## 7. Files

| file | what |
|---|---|
| `apps/api/src/yiddishCorpus/bulletinText.ts` | markup → articles; harvest runner; `publisher` engine constants |
| `apps/api/src/yiddishCorpus/bulletinAlign.ts` | LCS, anchors, span growth — pure |
| `apps/api/src/yiddishCorpus/bulletinIngest.ts` | per-item decision + the exact transcript rows |
| `scripts/yiddish-bulletin/measure-agreement.ts` | read-only: prints the real agreement distribution |
| `apps/api/src/yiddishCorpus/yiddish24Adapter.ts` | `getText` exported (one fetcher) |

Tests: `bulletinText.test.ts` (14), `bulletinAlign.test.ts` (8), `bulletinIngest.test.ts` (7).
Every case is a shape the archive really has, including both layouts, the skipped
paragraph, the mis-paired article and the niqqud difference.

## 8. MEASURED, 2026-09-18 (`scripts/yiddish-bulletin/measure-agreement.ts`)

Harvest: **3,227 articles, 324/324 pages, ZERO empty pages.** Of the 101 bulletins that
already have ASR, 98 have a harvested article (3 are older than the listing reaches).

Agreement = share of HEARD words the typed article also has, **in order**:

| p5 | p10 | p25 | p50 | p75 | p90 | p95 | mean |
|---|---|---|---|---|---|---|---|
| 0.430 | 0.477 | 0.528 | **0.636** | 0.703 | 0.733 | 0.748 | 0.615 |

Alignment keeps **2,691 s of 3,423 s (78.6%)**; 93 of 98 items produce at least one span;
the 5 rejections are all `agreement below 0.45`.

### ⛔ The 0.64 median is NOT a measurement of the article. It is a measurement of OUR ASR.

`tokenAgreement` falls when either side is wrong, and it cannot tell which. Inside the
well-anchored spans, divergence is **0–14%** — so within the stretches we can check, the
article IS close to verbatim, exactly as Izzy said. The other ~35% is our own model getting
words wrong, which is the entire reason this source is worth having.

⛔ **Do not "fix" the low agreement by raising `MIN_ITEM_AGREEMENT`.** A high bar throws away
the items where our ASR is WORST — the ones with the most to teach.

Real corrections from the first run (heard → typed), none of them fixable from our own output:

| our ASR heard | the article says | what it is |
|---|---|---|
| `פאטים` | `פוטין` | Putin |
| `יארגאף` | `'יו-גאוו'` | YouGov |
| `אלאסקע` | `אלאסקא` | Alaska |
| `פארטיילט דערשאסן` | `פאטאל דערשאסן` | fatally shot |
| `פעקלער` | `פעקלעך` | plural morphology |
| `די באדייטענדע צאל` | `א באדייטענדע צאל` | article |

Extrapolating 78.6% across all 3,343 bulletins once they are transcribed gives roughly
**25 hours of human-written labels**, against 0 hours today.

⏳ **Nobody has read a span to confirm the substitution is right.** The six above were read
and are right; the remaining hundreds have not been. That is what the gold-review screen
(`/admin/yiddish-learning/gold`) is for, and it should see these before any of them trains.

## 9. State

- ✅ Parser, aligner and ingest shaping BUILT and unit-green (29 tests).
- ✅ Harvest RUN: 3,227 articles, 324/324 pages, zero empty (`scripts/yiddish-bulletin/harvest.ts`).
- ⏳ **NOT DONE: nothing is written to the database yet.** `transcriptRowsFor` returns the
  rows; no caller persists them. The measurement has to set the thresholds first.
- ⏳ **NOT DONE: `build-dataset` does not read `publisher_aligned`.** A third clip builder is
  needed, and it must treat these as gold-grade (no machine-confidence gate), like
  `buildGoldClips` does for `human`.
- ✅ `MIN_ITEM_AGREEMENT = 0.45` and the gap sizes are now backed by the distribution in §8.

## 10. Next

1. ✅ DONE — see §8. Re-run it after any threshold change.
2. Persist `publisher` + `publisher_aligned` rows (chunked `createMany` — a per-row
   `create()` over the tunnel exhausted the pool at 12,056 rows on 2026-09-17).
3. Add the `publisher_aligned` clip builder to `build-dataset.ts`, gold-grade.
4. Only the ~101 bulletins with ASR can align today. The other ~3,100 need `transcribe`
   first — that is the existing Kaggle labelling lane, and it is what makes this source
   worth 32 hours instead of 1.
