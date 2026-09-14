# ⛔⛔ CLAUDE.md ITSELF CONTAINS A NUL BYTE AND HAS BEEN COMMITTING AS CRLF SINCE `d39cad7f` (2026-08-24) — READ BEFORE "fixing" it, and before wondering why `grep -n CLAUDE.md` says "Binary file matches"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Found while doing the routine end-of-task CLAUDE.md update, 2026-08-24.
**Deliberately NOT repaired — it needs a quiet tree and Izzy's word (below).**

- ⛔⛔ **Three warning bullets in this file are each about the heredoc escape
  trap, and each one FELL INTO IT.** A `\0`, a `\b` and a `\u202e` were written
  through a shell heredoc and landed as the **real** bytes: a NUL (in the
  *"Test data may legitimately contain a NUL — write it"* bullet), a BACKSPACE (in
  the SMS-bridge *"became a literal BACKSPACE"* bullet) and a real
  **right-to-left override** (in the desk-phone *"Backslash escapes do NOT
  survive this shell's heredocs"* bullet, whose own newline/CR escapes also
  became real characters). The sentences currently render as garbage.
- ⛔ **The NUL is why `grep -n CLAUDE.md` answers `Binary file CLAUDE.md
  matches` and returns no line numbers** — grep and ripgrep scan the whole buffer,
  so a NUL at byte 29,684 makes the file binary to them. **git disagrees**: its
  binary sniff window is the first 8,000 bytes, so `git diff` still renders it as
  text. Two heuristics, two answers.
- ⛔⛔ **AND THE CONSEQUENCE NOBODY WOULD LOOK FOR: git stopped normalising line
  endings.** Measured from the blobs — `5f2b071d` (the commit before the NUL)
  stored **0 CRLF / 13,870 LF**; `d39cad7f` (the commit that introduced it) stored
  **13,771 CRLF**; every CLAUDE.md commit since stores CRLF. With
  `core.autocrlf=true`, a file git considers binary is exempt from conversion.
- ⛔⛔ **SO REMOVING THE NUL IS NOT A THREE-CHARACTER FIX — it flips the file
  back to text and git immediately wants to renormalise all 14,049 lines: a
  28,099-line diff.** That was measured, then reverted, precisely because **a
  whole-file line-ending diff cannot be reviewed**, and this repo's rule is to
  read the staged diff before every commit — which is the only thing that catches
  another session's in-flight CLAUDE.md work being swept in.
- ✅ **The repair itself is ready and safe:** replace the NUL with a literal
  backslash-zero, the BACKSPACE with a literal backslash-b, the RLO with a
  literal `\u202e`, and the real newline/CR inside that third bullet's backticks
  with their two-character escapes. ⛔ **Write it through the editor, never a
  heredoc** — this session's first attempt used a heredoc and the shell ate the
  double backslashes, writing the same bad bytes straight back.
- ⏳ **Izzy's decision, and it is only about WHEN:** run the repair when nobody
  else has CLAUDE.md in flight and take the one-time normalisation commit on its
  own (which restores the pre-`d39cad7f` state and makes every future CLAUDE.md
  diff reviewable again), or pin `/CLAUDE.md -text` in `.gitattributes` to keep
  the current CRLF blobs and avoid the rewrite. **Doing nothing keeps the file
  ungreppable and keeps committing CRLF.**
