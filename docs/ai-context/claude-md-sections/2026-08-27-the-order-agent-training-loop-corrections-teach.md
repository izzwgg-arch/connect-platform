# ⛔⛔ AGENT HANDOFF — the ORDER-AGENT TRAINING LOOP: corrections teach INSTANTLY without submitting, house rules ride BOTH brain passes, re-corrections supersede and roll back (2026-08-27) — READ FIRST before touching agentRules.ts / phraseTeaching.ts, before adding a teach gesture to the desk, or before "simplifying" the two-pass rules injection

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §14**
(`f03d8ed0` on `feat/ivr-migration-takeover`. ✅✅ **api + portal DEPLOYED and
container-verified** — both `.build-commit` = `f03d8ed0`; migration
`20260827130000_supermarket_agent_training` applied and read back from the live
DB (SupermarketAgentRule table + `SupermarketPhraseLesson.retiredAt`); the
teach-page chunk ships "HOUSE RULES" and the desk's shared chunk ships the
re-run confirm + fix-from-box hint; 0 restarts, /orders 200 on both hostnames.
**Gesheft SEEDED (3 rules + 4 lessons) and the loop PROVEN LIVE** — see below.)
Izzy, 2026-08-27, training the agent on the live Gesheft drafts: *"correct the
agent without actually putting through the order… every time I correct
something, it should update the agent right away… if I re-correct that same
correction, I should be able to roll back"* — and *"confirm question marks or
just change it right there on the spot."* Memory: [[supermarket-training-loop-built]].

- ⛔⛔ **HOUSE RULES (`SupermarketAgentRule` + `agentRules.ts`) ARE INJECTED INTO
  BOTH BRAIN PASSES — never one.** `EXTRACT_SYSTEM + rulesBlock` AND
  `RESOLVE_SYSTEM + rulesBlock` (source-guarded, `agentTraining.test.ts`):
  EXTRACT needs spelling/quantity conventions because the phrase it emits IS
  what `searchCandidates` tokenizes — a brand spelled wrong never reaches the
  candidate pool; RESOLVE needs the pick rules. Read FRESH per run
  (`loadActiveRules`, best-effort — a missing table costs the rules, never the
  draft), so a correction reaches the very next draft with no deploy. Bounds
  40×300 chars / 4,000 total. **Every edit files the prior wording in
  `history`; rollback restores it and is itself reversible.** Managed on
  /orders/teach ("HOUSE RULES" card) + `/supermarket/agent-rules` routes.
- ⛔⛔ **A TEACH SUPERSEDES THE PREVIOUS CORRECTION — soft, never a delete.**
  `teachPhrase` retires (`SupermarketPhraseLesson.retiredAt`) any OTHER
  product's active lesson on the same phrase; `loadLessons` filters
  `retiredAt: null`, so **the brain sees only the newest correction, never two
  rival hints**. `restoreLesson` toggles back (restoring phrase→A retires the
  active phrase→B); the taught-table ✕ soft-retires. ⛔ **The rep-fix HARVEST
  at submit deliberately does NOT supersede** — hints, not verdicts;
  test-pinned. ⛔ The teach queue's `taughtKeys` counts ACTIVE lessons only,
  or a retired lesson hides its phrase while nothing answers it.
- ⛔⛔ **EVERY CHECKLIST LINE IS CORRECTABLE, WHATEVER ITS MARK — the first cut
  shipped this WRONG and Izzy caught it the same day** (*"each item on each
  item line I should be able to correct… whether it's a question mark, whether
  it's a check mark, whether it's anything"*). Only a ✗ line could be fixed: a
  ✓ had NO way to say "that's wrong", and a ? could only be confirmed, never
  changed — the gesture that matters most while training. Now **"Change" /
  "Pick the item" on EVERY line** opens an inline catalog search (⛔ reusing
  `ReplaceBox` — never a second search implementation) and `setLineItem` swaps
  the cart row, keeps the quantity and TEACHES; **"✓ that's right"** settles a
  ?; the cart row's own "?" pill does the same.
  ⛔ **`lineFix` / `lineOk` track what a PERSON set** — without them a
  corrected line falls back to the agent's own (wrong) product and goes on
  showing ✗ — and both RESET on reload, because a re-run renumbers the lines
  and a stale index would mark the wrong line settled. Retiring the old cart
  row is skipped when another line still resolves to it.
  ⛔ Suggestion CHIPS deliberately do NOT teach (labelled "not taught"): a chip
  is a one-off substitute, and under supersede semantics a chip-taught lesson
  would retire a good one.
  ⛔⛔ **Teaching is centralised in `teachLine`, and a source guard now pins
  that Change is NOT gated on the line being skipped** — that gating IS the
  bug that shipped.
  ⛔ **The TDZ trap it cost:** `doReplace`'s dependency array referenced
  `teachLine`/`resolvedIdForLine` declared BELOW it. A dep array is evaluated
  DURING render, so that is a ReferenceError crashing the whole desk, not a
  lint nit — `tsc` caught it (TS2448). Helpers must precede any callback
  listing them as deps.
- ✅ **The other teach gestures, all instant and all without submitting:** the
  row SWAP (pre-existing) and **fix-from-the-box** (clicking a checklist
  phrase drops it in the quick-add box; the next add from the box teaches with
  the search text as the meant-phrase). **"Re-run the agent"** replays ONE draft
  (`POST /supermarket/drafts/:id/rerun` — ownership 404 before permission 403,
  NEEDS_REVIEW only, stored YL translation reused so audio is never re-billed)
  so he can watch the same order improve; the button renders only when the
  draft GET's new `canManage` is true. The admin batch reprocess and the desk
  re-run share ONE per-draft core (`reprocessOneDraft`).
- ⛔⛔ **THE VOICEMAIL PLAYER 404 WAS THE TENANT SWITCH, NOT AUDIO.** Izzy:
  "when I go inside the order… the voicemail is not playing." An `<audio>`
  element sends NO custom headers, so `x-tenant-context` never reaches
  `/supermarket/drafts/:id/audio` — on the SUPER_ADMIN login `tenantOf()`
  resolved the ADMIN tenant and `ownDraft` 404'd (proven from one nginx line),
  while the store's own reps played fine. Fixed: the player URL carries
  `?tenantId=` (`browserTenantContext()`), which
  `resolveEffectiveTenantBillingContext` reads FIRST and ignores for
  non-supers. **Any new media URL behind a tenant-switched route needs the
  same query param.**
- ✅ **GESHEFT IS SEEDED with Izzy's dictated conventions** (3 rules + 4
  lessons, via `teachPhrase` inside `app-api-1` so the normalizer matches):
  a dozen eggs = ONE 12-pack of large eggs, cheapest in stock ("Eggs Large"
  `6451` $3.99; Eggland "Eggs L" `3213`; bigger packs say so in the name);
  milk with no brand = Golden Flow, **RED milk = whole ("Milk Red" `79645`),
  BLUE milk = 2% ("Milk Blue" `79640`)** — ⛔ he stated blue both ways in one
  message and CONFIRMED blue = 2% when asked; the catalog itself uses the
  color names. Balabusta/Balebusta/Baal Habusta are ONE brand — ⛔ **the
  catalog carries BOTH spellings as distinct brand strings**, so the rule
  tells EXTRACT to write both spellings into the phrase. ⛔ A bare "milk"
  lesson was deliberately NOT seeded — a single-stem lesson would inject a
  learned whole-milk hint into every almond-milk and blue-milk line.
- ✅✅ **PROVEN LIVE ON THE PEARL DRAFT** (`cmtbpxtco8wxxry14nlmslnm7`, the
  exact order on Izzy's screen): re-run through the deployed route → 200
  `brain:gpt-5+yl`, 27 items; **"2× whole milk, red cap" flipped from SKIPPED
  ("No whole milk offered", kefir suggestions) to 2× Milk Red IN CART** — and
  the "red milk" lesson's `timesUsed` gauge ticked to 1, proving the pick rode
  the lesson; eggs flipped from "No eggs offered" (kichel suggestions) to a
  large-egg dozen; the Golden Flow almond milk stopped resolving to Almond
  Breeze. ⛔ **The eggs pick was "Organic Eggs Large White" with a "?", NOT
  the $3.99 "Eggs Large" — because `onHand` reads -75 (register drift) so it
  presents as out of stock and the rule says cheapest IN STOCK.** Not a bug;
  either the register count gets fixed or one confirm/change on the desk
  teaches the answer. `SUPERMARKET_DRAFT_RERUN` audit row verified.
- ✅ **Proven as tests:** 132/132 supermarket api (8 new in
  `agentTraining.test.ts` — the supersede/restore toggle on the faithful
  FakeDb, rules skipping inactive + foreign tenants, a thrown rules-read never
  blocking a draft); portal 372/374 (the two documented pre-existing); api
  typecheck 76 = the exact baseline; portal 0. The three orderPipeline source
  guards were repointed at the refactored structure (`reprocessOneDraft`).
- ⛔⛔ **THE DESK SEARCH COULD NOT FIND MOST OF THE CATALOG (2026-08-27,
  `b76f53ca` — handoff §14b).** `GET /supermarket/catalog/search` was
  `name: { contains: <the whole typed string> }` — ONE substring, NAME ONLY —
  so any phrase whose words span the name and the brand, or are not adjacent
  in the name, matched nothing. Measured live: **"golden flow orange juice"
  → 0** (Golden Flow is the BRAND column), "balabusta rice" → 0, "eggland
  eggs" → 0. ⛔ **The BRAIN had searched name-OR-brand on stemmed tokens
  since `5f318d52`, so the REP's box was strictly dumber than the agent's** —
  backwards, since the rep is there to correct the agent. The rule now lives
  once in **`catalogSearch.ts`**, used by both.
  ⛔⛔ **RECALL COMES FROM THE SQL, PRECISION FROM RANKING — do not skip the
  second half.** `contains` is a bare substring, so the token "red" also
  matches "Cove**red**": "milk red" really did return chocolate-covered
  crackers ABOVE Golden Flow's "Milk Red". `rankCatalogRows` scores
  whole-word hits far above substrings. ⛔ **Relevance outranks stock** — the
  in-stock-first rule is for choosing between COMPARABLE products; across
  relevance groups it buries the exact item just typed. Stock breaks ties
  within a group; nothing is ever hidden.
  ✅ **Brand + size are selected and shown in all three suggestion lists** —
  half this catalog is told apart ONLY by brand and ounces (four sizes of
  "Milk Red"), so a list without them cannot be picked from. Desk limit
  8 → 12; the brain stays at 8 (it pays prompt tokens per candidate).
  ⚠️ Found while testing, NOT a search fault: there is **no "Gold's" brand in
  this catalog at all**, and the register carries typo'd brands — *Goldem
  Taste*, *Golden Tatse*, *Gold Nit* beside *Gold Nut*.
- ⛔⛔ **A MIS-HEARD ACCOUNT NUMBER FINDS THE CLOSEST REAL CUSTOMER, AND NEVER
  BINDS ONE SILENTLY (`e34c673a` — handoff §14c).** `customerPhoneMatch.ts`
  reconciles the SPOKEN number against (1) the number the call/text physically
  came FROM and (2) customers this store has served — our own **SUBMITTED**
  orders only (⛔ an un-submitted draft may carry the very mis-hearing this
  corrects). Damerau-Levenshtein distance **1**, so "783" heard as "738" is
  the single slip it is; ⛔ distance 1 and 10 digits only, or "closest match"
  starts inventing customers.
  ⛔⛔ **AN ACCOUNT CARRIES CARDS ON FILE, so binding the wrong one can charge
  the wrong person.** Only exact agreement is `stated`; a one-digit fix is
  `corrected`, and several equally-close customers is `ambiguous` and picks
  **NOTHING**. Both raise a confirm banner on the desk with the candidates as
  chips, and a human confirming a number **settles the verdict server-side**
  so the banner clears. Wired into BOTH draft paths + the re-run (guard counts
  both). ⛔ `SupermarketOrderDraft` has a bare `threadId` and **NO `thread`
  relation** — the nested select would have thrown into a `.catch()` and
  silently produced no caller ID; it reads `connectChatThread` directly.
  Live: 440 drafts, 208 distinct numbers, top prefixes 845-783/782/492/774 —
  and **0 drafts have ever resolved a `posCustomerId`** (the POS key is still
  scoped "own"), which is exactly why this matches against caller ID and our
  own history instead.
- ⛔⛔ **PHOTOS: THE BARCODE ROUTE DOES NOT WORK HERE, AND THE FIRST
  MEASUREMENT LIED (handoff §14d).** 4,540 of 19,259 active items (23.6%)
  have a photo; 12,962 photo-less items carry a real 12–13 digit barcode, and
  a barcode IS "exact brand, exact ounce, exact item" by construction — so it
  looked like the answer. A hand-picked sample of 10 recognisable brands hit
  **3/10** on Open Food Facts; a **random 60**, probed against Open Food,
  Open Beauty AND Open Products Facts, returned **0 usable images**. These are
  kosher-specialty brands the open databases do not carry.
  ⛔ **Do NOT fall back to free-text web image search** — it cannot satisfy
  "exact brand, exact ounce, exact item", and the 2026-08-26 pass already set
  the standard by SKIPPING 114 ambiguous matches: a wrong photo is worse than
  none, and on an order line it is a picking error.
  ✅ The exact, already-proven route is **their OWN webstore**: the first
  harvest walked the per-CATEGORY endpoint (the flat list 403s) and **their
  default filter HIDES out-of-stock items**, so a re-harvest with that filter
  cleared is the highest-value next pass. ⏳ Not done — needs a browser session.
- ✅ **REGISTER STOCK DRIFT — ANSWERED AND FIXED 2026-08-30 (`e5b2711f`).**
  The open question this bullet used to carry ("should a NEGATIVE count read
  as unknown?") was settled by Izzy's own eggs complaint: negative onHand is
  register drift = UNKNOWN; only an exact ZERO is out of stock
  (`isKnownOutOfStock` in catalogSearch.ts, enforced by source guards at
  every read site). See the dedicated 2026-08-30 search section near the top
  of this file.
- ⏳ **NOT PROVEN: no human has driven it** — nobody has typed a rule on the
  screen, clicked a "?", or pressed "Re-run the agent" in a browser.
  ⛔ **An already-open desk tab/desktop window keeps the OLD bundle** — reload
  (or fully reopen the desktop app) before judging any of it, including the
  voicemail player fix.
