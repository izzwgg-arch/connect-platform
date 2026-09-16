# Yiddish Learning Engine + Yiddish24 Source #1: PHASE ZERO (architecture, inventory, mockups), nothing built (2026-09-15)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_YIDDISH_LEARNING_ENGINE_2026-09-15.md`**. It absorbs the Voice Lab design as its evaluation module.
Mockups: `docs/mockups/yiddish-learning-engine/learning-engine.html` (artifact https://claude.ai/artifact/K78Se8hWqGUyHL1NAQoudP, 18 screens).

- Izzy asked for a Loopcom-owned Yiddish learning engine that learns from all existing Yiddish data and then from Yiddish24 audio. He wants mockups and architecture first, then a production build and a pilot.
- **Verified production inventory (read-only):**
  - 3,510 Yiddish voicemail transcripts ≈ 35.8 h (1,839 / 21.9 h with local audio). ⛔ Customer-private, and **the provider is not recoverable per row**, so all of it is Yiddish Labs no-train.
  - 1,863 supermarket drafts (Yiddish Labs, one tenant).
  - ≈1,707 h of call recordings with no transcripts and no consent field.
  - 434 + 59 Yiddish Labs translations.
  - The purpose-built corpus is empty: `AgentTranscript` 1, `AgentDialectTerm` 0, archive 0.
  - One tenant is ~68% of Yiddish voicemail.
- **Infrastructure:**
  - ⛔ pgvector is not available in the postgres:15 image (semantic search needs an image decision).
  - No GPU; the call server hosts live traffic, so bulk analysis belongs on a separate worker.
  - Reuse the `EmailJob` job-row pattern or BullMQ.
- **Design spine:**
  - Originals are referenced and never mutated.
  - Observation ("we heard") and rule ("we apply") are separate.
  - Independence-weighted evidence, with per-source scores so a source can be excluded later.
  - Governance classes PLATFORM / CUSTOMER_PRIVATE / EXTERNAL, plus training-export eligibility.
  - Candidate → Testing → Approved → Production promotion, human-gated.
- **Yiddish24, inspected read-only:**
  - No feed, no API, no transcripts; about 35k items and 136 series.
  - MP3 URLs sit in the HTML, but ⛔ **the CDN returns 403 without the site's Referer (a hotlink restriction)**, so pulling audio off-site would bypass an access control. That is not done.
  - No terms page, and "All Rights Reserved" → storing audio is not permitted; training is unknown / not allowed.
  - Only route to audio: written permission and a feed from Info@yiddish24.com. A metadata-only catalog is the most a pilot can do without it.
- ⏳ **Open for Izzy:**
  - Customer data basis (excluded / aggregate / per-tenant consent).
  - Yiddish24 pilot and audio storage after the terms findings.
  - Worker box.
  - pgvector.
- ⏳ Nothing built, crawled, downloaded or deployed.

## BUILT END TO END — 2026-09-16, commit `88682602`

Izzy: *"Build this end-to-end... Yiddish24, 24/7... stress-tested end-to-end, ready to use."*

- **Shipped:** 21 additive `Yc*` tables + migration `20260916180000`; the api module
  `apps/api/src/yiddishCorpus/` (contract, governance, evidence, corpus, lexicon,
  internal indexer, retention, Yiddish24 adapter, audio pipeline, novelty, site
  health, leased worker, 34 routes, benchmark, seed); ten portal pages at
  `/admin/yiddish-learning` with 10 per-page keys, all platform-staff Locked; a
  `yiddish-corpus` docker volume.
- **Runs continuously today: METADATA ONLY.** The worker walks and dedupes the
  Yiddish24 catalog, ≥2 s per request, stopping on 429/Cloudflare. Audio stages
  are SKIPPED with a reason, never failed.
- ⛔⛔ **The three walls are code with guard tests**, not convention: customer
  voicemails/calls/chats are counted-never-read; Yiddish Labs output is
  serving-only (an unprovable `stt-yi` provider counts as YL); external audio
  needs `audioFetchMode=OWNER_AUTHORIZED` **and** a GRANTED rights record. The
  Yiddish24 `Referer` literal exists once, inside that gate, guard-tested.
- **Proof:** 127/127 tests in the new folder; migration test-applied to a
  throwaway DB (21 tables, safe defaults, cascades) before production; the
  parser run against the LIVE site (10 episodes, 100% field coverage,
  totalPages=8/perPage=10/catId=227, 136 series).
- ⚠️ **36 api tests fail on the workstation and none are ours** —
  `packages/integrations/dist/index.js` is a gitignored artifact from 2026-05-24
  vs source from 2026-08-12, so those suites load a stale build. Server builds fresh.
- ⏳ **Still Izzy's to decide:** the customer-data basis; whether to email
  Info@yiddish24.com for permission (draft in handoff §2b); a worker box for
  bulk audio; pgvector for semantic search.

## HARDENED AND PROVEN RUNNING — 2026-09-16 (`e6b975d2` → `2627b1be`)

Izzy: *"bring it to good condition so the agent can start learning right up …
stress-tested the fuck out of end-to-end, ready to use."*

**The build was green and the deployed system was not right.** All six defects
below were found by reading production — the cursor, the job table, the route
payloads — not by a test. Every one now has a regression test.

1. **Every catalogued item's category was `"darkred"`.** The listing rows carry
   no category, and the parser fell back to `data-cat-color`, which is the CSS
   swatch the site paints the row with. The catalog browser's category filter
   was meaningless. The honest source is the series catalog; unknown is now
   NULL, never a colour.
2. **Discovery held the only worker lane.** A discover job walks listing pages
   at the ≥2 s politeness gap, so it runs for MINUTES, and it shared the single
   in-flight guard with everything else. The queue read "busy" while every
   cheap local stage stood still. Discovery now has its own lane and guard;
   the stage filter is applied in the CLAIM QUERY, so a post-filter can never
   claim-then-drop a row and burn its attempt.
3. **5 jobs a minute.** Against ~35k items × ~10 job rows each that is weeks.
   Now 50 per 20 s. ⛔ These knobs change how much LOCAL work a tick does —
   never how fast Yiddish24 is asked. Measured after: 150 jobs/min, and items
   climbing at the same time, which is the proof the lanes are independent.
4. **`observe` and `aggregate` had no handler at all.** Both are declared in
   `YC_STAGES`; neither existed. `runDueJobs` fell through to
   `no handler for stage "observe"` and marked the job SKIPPED — and a SKIP is
   a lawful outcome with a reason, so the pipeline looked healthy while its
   last two steps did not exist. 214 jobs had already "skipped" that way.
   The audio stages never hit this because the rights gate answers first.
5. **A rights grant would not have reached the backlog.** SKIPPED is terminal,
   so the day Izzy records permission the already-catalogued episodes would
   have stayed skipped for ever and only NEW items would get audio.
6. **A walk in progress never learned the category map.** It was written only
   when a walk STARTED, and a walk under way does not start.

**What `observe` and `aggregate` do, and what they refuse to do.**
`observe` tokenizes an item's transcripts into lexemes — vocabulary is the part
text alone can honestly teach — and records a pronunciation observation ONLY
where the text is pinned to an aligned segment, stamped ACOUSTIC_ALIGNED.
⛔ It will not infer a pronunciation from spelling: that would put a guess in
the evidence table where everything downstream reads it as something we heard.
`aggregate` scores observations with the existing evidence module and writes
rules at CANDIDATE and findings at PROPOSED. ⛔⛔ It never approves, and a real
split becomes a conflict finding for a person instead of the engine choosing.

**Proven on production, 2026-09-16:**
- 157/157 folder tests; 21/21 stress harness run INSIDE the api container.
- Every read route 200 with honest empty-state notes; all 10 portal pages 200.
- Dashboard numbers are real: `audioHours` 0 against `catalogDurationHours`
  (published, never fetched), 0 audio assets ever, wall counts live (72,548
  call recordings / 1,707.6 h; 3,514 voicemail transcripts / 35.8 h).
- Catalog grew unattended 270 → 519 → 2,593 items; 0 `no handler` rows left;
  every item carries a real main-category label.
- `scripts/yc-backfill-categories.ts` (re-runnable) repaired 519 then 1,747
  rows; it never overwrites a real label and leaves unplaceable series NULL.

⛔ **UNCHANGED AND NOT NEGOTIABLE:** audio is still DISABLED. Nothing has been
downloaded from Yiddish24, the hotlink `Referer` is still never sent, and the
customer wall is still counted-never-read. The engine builds a CATALOG today;
it cannot learn pronunciation until audio is authorised, and it says so on
every screen rather than showing a number it did not earn.

## 2026-09-16 (later) — "listen until I say stop", and the R / CH accent

Izzy: *"Make it start listening to Yiddish24 right now, and until I say 'stop
listening Yiddish24,' do not stop."* Then: *"major focus on improving its
accent, grammar, and dialogue. What mainly, it's accents the R and the CH."*

**⛔⛔ What "listening" can and cannot mean today.** The engine walks and
catalogues Yiddish24 continuously. It does NOT download or hear the audio: the
CDN refuses requests without the site's own Referer (a hotlink restriction)
and the site says "All Rights Reserved". Working around that is bypassing an
access control, which Izzy's own brief forbids and which no agent may do on a
"just start" instruction. Audio starts only through the gate: OWNER_AUTHORIZED
**and** a GRANTED rights record, i.e. real permission from Yiddish24 (draft
email in handoff §2b). Until then the stop phrase stops the METADATA crawl:
pause the `source:yiddish24` budget.

**The crawler paused itself the day it finished (fixed, `fb563e27`).** 09:46 —
all 136 series walked (32,210 items, ~11,084 h catalogued). The next two
re-checks correctly found no new episodes, and site health's "two empty runs =
the site or parser changed" rule paused the source at 10:01. A run now counts
empty only when it recognised NOTHING (no new item AND no known one). Once the
catalog is caught up, re-checks run hourly (`YIDDISH_RECHECK_EVERY_MS`) — a
full re-check is one page per series, so the 5-minute clock would have been
~27 requests/min for ever. Unpaused through the real budget route; the 11:03
re-check re-read 581 known episodes, probe OK, 0 broken probes, still running.

**R and CH.** What actually speaks Yiddish is OpenAI: `gpt-realtime` (voice
`cedar`) on the voice agent, `gpt-4o-mini-tts` in the benchmark. Neither can be
trained on accent. The one real lever is the spoken-delivery `instructions`
field. ⛔ That is STEERING, not learning, and only a native ear can say whether
it moved anything.

A/B ear test sent 2026-09-16: 6 sentences taken VERBATIM from
`AgentTranslation` (densest in ר and ח/כ/ך — `יישר כח`, `רופט מיך צוריק`,
`דערנאך`), `gpt-4o-mini-tts`/`cedar`, A = no instructions, B = instructions
asking for a uvular R (never American, never rolled) and a guttural "kh" for
ח / final ך / undotted כ (never English "ch", never "k", never "h"). ~1¢.
Script ran once inside the container and was removed; nothing written to the
corpus. ⏳ **Izzy's per-pair verdict decides the next step:** if B is better,
make it a versioned profile in the benchmark and carry the same instruction to
the realtime voice agent; if not, the honest answer is that prompting cannot
fix R/CH and real improvement needs recorded native audio (a hired speaker
with a written voice-rights contract, or Yiddish24 permission).

⛔ **Grammar and dialogue are the TEXT side**, and Yiddish text comes from
Yiddish Labs — whose credits were OUT at the time of this note
(`[YIDDISH_CREDITS] still out` in the api log). That degrades grammar before
any voice work can help.

## 2026-09-16 (afternoon) — Now listening, no music, and a rollback by another session

Izzy: *"I want to be able to hear and see at all times what the agent is
listening to. It shouldn't be just listening to music. There are also music
spots there, so no music, just audio of people talking."*

**DEPLOYED and container-verified: api + portal `3ace3d4e`** (the branch tip).
The shipped page chunk carries "Now listening" and "Listen on Yiddish24";
`/now` answers worker alive, crawl WAITING (hourly re-check), 0 bytes fetched.

**Now listening.** `GET /admin/yiddish/now` + a panel ABOVE every tab of the
Yiddish24 page, refreshed every 5 s (not while the tab is hidden). It shows the
crawl state (walking / waiting + next check / paused / stopped), the series and
page in hand, the last episode the worker touched with its stage, a 25-row
recent trail (music hidden unless "Show excluded music" is ticked), and
speech-vs-music totals.
⛔ **"Hear" is a link to the episode's own page on yiddish24.com**, where the
site's player plays it. The raw MP3 URL is never put in the payload (test
asserts no `cloudfront` in it): the CDN refuses any page but its own, and
embedding it in our portal would be working around that.

**No music, decided by the site, never by a title guess.**
- Series under the site's Music main category (id 7, נגינה, 11 series) plus
  `YIDDISH24_EXTRA_MUSIC_SERIES` = #233 נגינה ווידעאס (music videos, filed under
  Video) are never walked.
- An item from one is skipped at the FIRST stage (`fingerprint`), marked
  `state SKIPPED` + `error = YC_MUSIC_EXCLUDED_MESSAGE`. A guard in `runDueJobs`
  refuses any stage already queued for a marked item. No other code sets an item
  to SKIPPED, so the marker cannot collide.
- Production: 4,182 items / ~1,049 h excluded, 4,180 queued jobs skipped;
  28,029 speech episodes / ~10,036 h remain.
- ⏳ **Open for Izzy:** two series inside Music are people talking about music
  (נגינה אינטערוויוס, מוזיקאלישע שמועסן). They are excluded by default.
- ⛔ **Music INSIDE a talk episode** (jingles, song breaks) cannot be seen from
  metadata. Only the audio pipeline's SPEECH/MUSIC segment classifier can, and
  it only runs once audio is permitted.

**The category parser was wrong.** The live page carries the nav more than once
and the old parser let the LAST sighting of a series decide its category, so
news bulletins were filed as Torah and NO series as news. It now reads the
category block a link sits in (first block wins; a block stops at the next
heading — an unclosed list in the saved fixture had swallowed the next category,
caught by the new test). Proven on the live page: 136 series, 9 categories,
News 12 (was 0), Music 11. `catalogVersion` makes an old cursor re-read the nav
once. `scripts/yc-backfill-categories.ts --relabel --apply` relabelled 7,469
items to נייעס (Torah 9,517 → 2,048).

**Heartbeat.** The worker's heartbeat row is UPSERTED per day: tick time is
`value`, not `createdAt`. `/now` first read `createdAt` and showed a working
worker as dead; fixed in `3ace3d4e`, and the test fails replayed on `4266093d`.

⛔⛔ **Another session's deploy rolled this back.** api was deployed at
`9c0fefde` (desk-phones, an older base) at 11:51 UTC and portal at 11:54. That
reverted the music exclusion, the live view and the quiet-re-check fix, and the
crawler paused itself at 12:03 on the exact false alarm `fb563e27` fixes. The
deploy log said `success`. Recovered by deploying the branch tip (contains their
commits too) and unpausing through the budget route; all three peer sessions
were messaged. **Deploy the origin tip, and after any deploy check your fixes
are ancestors of the live `/app/.build-commit`.**
