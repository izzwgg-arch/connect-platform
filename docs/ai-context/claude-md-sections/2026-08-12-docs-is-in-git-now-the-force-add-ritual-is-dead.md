# `docs/` is IN GIT now (2026-08-12) — the force-add ritual is dead; only `docs/pbx-brain/` stays ignored

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Commit `2bf61c03`. For months `.gitignore` had `docs/` wholesale, so **41 of 91
files under `docs/ai-context/` — several of them "READ FIRST" targets named in
this very file — existed only on one machine**, one `git clean -xfd` from
deletion. Every doc that WAS in git got there by individual `git add -f`, which
is exactly how the gap grew unnoticed.

- **Why it was ignored:** `docs/pbx-brain/` holds a **1.2 GB PBX snapshot**
  (475 MB tarball + extracted VitalPBX dump) that bloated EAS build uploads.
  That dir is still ignored; EAS is independently protected by `.easignore`,
  which excludes ALL of `docs/` — so do not "fix" the .gitignore rule back.
- **A new doc now lands with a plain `git add`.** If `git add docs/...` ever
  complains about an ignore rule again, something regressed — check
  `.gitignore` for a resurrected `docs/` line before force-adding.
- **Both safety passes ran against the committed tree and came back clean**
  (structured tokens, private keys, cred-bearing URLs, assigned secret values,
  the AMI-password shape, long-hex triage → only placeholders, git SHAs and
  checksums; `.connect-ssh/` still ignored, zero surprise untracked files).
  ⛔ `docs/pbx/*.sh` + `*.conf` are pinned LF in `.gitattributes` — they get
  scp'd to the Linux PBX and a Windows CRLF checkout breaks them (same trap as
  `/scripts/pbx/**`). The unpinned `.mjs`/`.sql` there are shebang-free and
  CRLF-safe on purpose; pin any NEW shell/conf file you add under docs/pbx.
