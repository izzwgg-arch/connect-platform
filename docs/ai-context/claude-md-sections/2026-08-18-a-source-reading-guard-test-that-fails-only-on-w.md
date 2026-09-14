# ⛔ AGENT HANDOFF — a source-reading guard test that fails ONLY on Windows is a CRLF artifact, not a regression (2026-08-18) — READ FIRST before "fixing" production code because `userDisplayName.callsites`, `supportReport` or any `readFileSync(...)`-based test went red on this machine

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: `docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md`
§0c follow-up + `docs/ai-context/TESTS_RUN.md` (2026-08-18 entry). Memory:
[[source-reading-tests-must-normalise-crlf]]. **Test-only + docs change; no
production code, no deploy, no container involved.** ✅ committed + pushed to
`feat/ivr-migration-takeover`.

- **What it was.** `apps/api/src/userDisplayName.callsites.test.ts` sliced
  `server.ts` on a literal `"\n}\n"`. Izzy's global `core.autocrlf=true` checks
  `.ts` out as CRLF, so `indexOf` returned `-1`, the "function body" became the
  2-char string `"fu"`, and the assertion failed with `actual: 'fu'` — reading
  exactly like `displayNameForUser` had regressed. It had not: the same slice
  against unmodified `HEAD` re-encoded to CRLF fails identically; the LF form
  passes. Linux CI never sees it.
- **Fixed 2026-08-18** by normalising at the read site —
  `readFileSync(p, "utf8").replace(/\r\n/g, "\n")` — in
  `apps/api/src/userDisplayName.callsites.test.ts`,
  `apps/api/src/supportReport.test.ts` (`/return null;\n\s*\/\//` had the same
  hole) and `apps/portal/lib/voicemailPreloadBound.test.ts` (the inverse: its
  `doesNotMatch(/…;\n  const skip…/)` guard could never match on CRLF, so it
  passed while guarding nothing). `displayNameForUser` and all production code
  untouched. Proven both ways: the ORIGINAL test against a CRLF mirror of
  `server.ts` reproduces `actual: 'fu'`; the fixed tests pass on the same
  mirror (17/17 api, 6/6 portal) and on the LF checkout.
- **What survives CRLF, so it was left alone:** `/[\s\S]*?\n\}/` (used in
  `adminRouteTenantScope`, `teamBuilder.queue`, `urlSigningSecret`,
  `voicemailPreloadBound:64`) — `"\r\n}"` still contains `"\n}"`;
  `sidebarSmoothness`'s `indexOf("\n}")`; `split("\n")` followed by
  `trim()`/`includes()` (`voiceDiagEventTypes`, `sipRouteDefault`,
  `internalSecret`); `\s*\n?\s*` in regexes; `fcmDirectWiring` already uses
  `/\r?\n/`. **What breaks:** any literal `\n` with non-whitespace on BOTH
  sides, and `"\n}\n"`.
- ⛔ **Rule for new source-reading tests:** wrap the read with the CRLF
  normalise. When such a test fails only on Windows, run
  `git ls-files --eol <file>` BEFORE touching the code under test.
- **`npm test` baseline in `apps/api` is now the 7 × `syncPbxTenantDirectoryFromRows`
  failures only** (2369 tests). ⏳ One caveat: on a CPU-loaded full run
  `voice/elevenLabsRoutes.stress.test.ts` "a 10-wide concurrent burst" can fail
  with `expected 1-4 successes, got 10` — the burst serialises under load
  (3.5 s for a test built on a 50 ms hold) so the gate never sees overlap. It
  passes 3/3 in isolation and the file is untouched; it is a load flake, not a
  regression, and not yet hardened.
