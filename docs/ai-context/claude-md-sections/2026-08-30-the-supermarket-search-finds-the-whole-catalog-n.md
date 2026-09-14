# ⛔⛔ AGENT HANDOFF — the supermarket search finds the WHOLE catalog now, and negative stock stopped steering picks (2026-08-30) — READ FIRST before touching catalogSearch.ts, before reading `onHand` anywhere in supermarket code, or for "the dropdown doesn't find X" / "the agent picked the wrong variant"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §15**
(`e5b2711f` on `feat/ivr-migration-takeover` — api + portal. Deploy state at the
end of this section.) Izzy, 2026-08-30: "bread" showed no actual bread, "rye
bread" didn't come up, and the agent added ORGANIC eggs — *"it should pick the
cheapest one … He's got to use common sense."*
Memory: [[supermarket-search-pool-and-stock-rule]].

- ⛔⛔ **THE RECALL BUG: both the desk search and the brain's candidate search
  fetched `take: 12` / `take: 8` PER TIER, ordered by NAME, and stopped at the
  display limit — so ranking only ever saw an alphabetical dozen.** Measured
  live: "bread" matches **175** rows and the dropdown was twelve bread BAGS and
  CRUMBS; the brain's whole "eggs" candidate pool was egg KICHEL and egg SALAD,
  so **the $3.99 dozen never reached the model and no prompt rule could fix a
  pick whose right answer was absent.** Now ONE shared `searchCatalogPool`
  (240-row pool → `rankCatalogRows` → cut). ⛔ **Never reintroduce a per-tier
  take at the display limit — ranking cannot rescue a truncated pool.**
- ⛔⛔ **ONLY `onHand === 0` IS OUT OF STOCK (`isKnownOutOfStock`) — a NEGATIVE
  count is register drift, i.e. UNKNOWN.** "Eggs Large" at **-75** presented as
  out of stock, and the house rule says "cheapest IN STOCK" — that is exactly
  how organic won. This closes §14's recorded open question, **by Izzy's own
  instruction**. Applied at every site (ranking, labels, the brain's
  `inStock:false`, the draft-GET `outOfStock`, three portal pills); source
  guards forbid `onHand <= 0` coming back.
- **Ranking**: the word ITSELF beats a word prefix beats a substring ("eggs" is
  "Eggs Large", not "Eggplant", not "V-**egg**-ie Chips"); a HEAD-NOUN hit
  ("Rye Bread" IS bread, +6) outweighs starts-with ("Bread Bags", 8→4); the
  CHEAPEST row wins ties. **The desk pins TAUGHT phrases** — active
  `SupermarketPhraseLesson` rows on **EXACT normalized-phrase equality only**
  (a "bread" lesson must never hijack a "bread crumbs" search).
- ⛔⛔ **A SINGLE-STEM LESSON FIRES ONLY ON A SINGLE-STEM LINE now**
  (`matchLessonsToLines`) — the change that makes teaching a bare word SAFE.
  Under the old subset rule a "bread" lesson would have injected the rye loaf
  as a strongly-preferred candidate into every "bread crumbs" line — the exact
  pollution that kept the bare "milk" lesson from being seeded on 2026-08-27.
- **RESOLVE prompt carries the common sense in words**: the words name the TYPE
  ("bread" = a loaf, never crumbs/bags/breaded chicken); no brand/variety/grade
  named ⇒ the PLAIN REGULAR version, cheapest in-stock — **never organic /
  sugar-free / spelt / gluten-free unless asked**.
- ✅ **Proven by simulating the deployed algorithm before/after on the live
  catalog**: "bread" now returns twelve actual loaves (Rye Bread Korn's, in
  stock, first), "rye bread" all six ryes, "eggs" real cartons with Eggland
  $4.99 on top (the exact price Izzy quoted) and organic nowhere. 162/162 api +
  9/9 portal tests; **all 9 new source guards fail replayed against HEAD** (one
  was caught vacuous by the replay and tightened). Typechecks at baselines.
- ⏳ **NOT PROVEN: nobody has typed into the deployed dropdown and no draft has
  been re-run on the new pools.** Acceptance: desk search "bread" / "eggs",
  then re-run an eggs draft — the pick must be the cheapest regular dozen.
