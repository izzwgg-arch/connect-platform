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
