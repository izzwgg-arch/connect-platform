# ⛔ AGENT HANDOFF — "can we run our own mailboxes without Google?" (2026-08-24) — READ FIRST before proposing a self-hosted mail server, before quoting a per-mailbox cost, or before treating the 500/day cap as a live problem

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only investigation — no code, no deploy, no DNS change, no mailbox created, no
env edit.** Measured live on 2026-08-24 rather than answered from memory.)
Memory: [[own-mailboxes-yes-but-sending-is-the-trap]].
Izzy: *"Can we create our own internal inboxes if we have access to the domain without
Google — system@, voicemails@, support@, office@?"*

- ⛔⛔ **THE FACT THAT SETTLES IT: OUTBOUND PORT 25 IS BLOCKED ON LOOPCOM.** Measured — a
  direct TCP connect from the server to `aspmx.l.google.com:25` is filtered. Contabo
  blocks it by default. **So the box literally cannot deliver mail to another mail server
  today**, and a self-hosted sender is not a config job, it is a support ticket plus a
  reputation warm-up. ⛔ The IP is otherwise **clean** (not on Spamhaus Zen) — do not
  report it as blocklisted.
- ⛔ **The server has NO mail server at all** — no `postfix`/`exim`/`sendmail` binary and
  nothing listening on 25/465/587/993. Any self-hosting starts from zero. (⛔ Not to be
  confused with the **PBX**, which DOES run Postfix — that is the box that sends Gesheft's
  voicemail email.)
- ⛔⛔ **THE FRAMING TO CORRECT, AND IT IS THE WHOLE ANSWER: EXTRA ADDRESSES ARE FREE ON
  GOOGLE.** Aliases (up to 30 per user) and Groups (unlimited, real shared inboxes) cost
  nothing. **A paid seat is only needed when an address needs its OWN LOGIN** — i.e. a
  program signing in over IMAP/SMTP. `sms@loopcom.net` is exactly that, which is why the
  SMS bridge has a real mailbox and an app password. So "we'd pay ~$7 each for
  system@/office@/support@" is **wrong**, and it is the assumption that makes self-hosting
  look attractive.
- ⛔ **THE 500/DAY PANIC IS STALE — MEASURE BEFORE REPEATING IT.** 14 days of `EmailJob`:
  ~40-60 rows/day, but **541 of 655 are `ADMIN_ALERT`**, which are muted at the send door
  and never sent. **Real customer mail is ≈ 8/day.** Nowhere near Google's limit. The
  2026-08-06 blowout was the alert storm; muting it treated the symptom, and the remaining
  risk is structural (one mailbox, one allowance), not volume.
- **The whole platform sends through ONE row**, not env: `EmailProviderConfig`
  `provider: GOOGLE_WORKSPACE`, `settings.googleIntegrationType: "SMTP"`, from
  `support@connectcomunications.com`, `isEnabled: true`. ⛔ `SENDGRID_API_KEY` and every
  `SMTP_*` name read **UNSET** inside `app-api-1` — the credentials are **encrypted in
  that DB row**, so an env grep concludes "mail is not configured" and is wrong.
- ✅⛔ **THE FIX FOR THE ONE-MAILBOX RISK NEEDS NO BUILD, AND THAT IS THE useful finding:**
  the send path already accepts **`z.enum(["SENDGRID", "SMTP", "GOOGLE_WORKSPACE"])`**
  (`server.ts:32043`), so the platform can be pointed at SES / SendGrid / any SMTP host
  through the **existing admin route** — a config change, not code. SES ≈ **$0.10 per
  1,000 emails** (their ~240/month ≈ 2 cents) with no daily cap, and **the AWS account
  already exists** (Polly runs on it).
- **The recommendation given, in order:** (1) make `system@` / `voicemails@` / `office@` /
  `support@` as Google **aliases or Groups** — free, today, no infrastructure; (2) move
  platform **SENDING** to SES, which is what actually removes the shared-allowance risk on
  invoices and password resets; (3) self-host **receiving only**, and only if they later
  want many independent logins. ⛔ **Never self-host the sending of invoices, pay links,
  password resets or 2FA codes** — the failure is silent (junked, not bounced) and lands
  on a paying customer.
- ⏳ **STILL UNVERIFIED AND NOW LOAD-BEARING ON A FINANCIAL DOCUMENT: does the
  `billing@loopcom.net` MAILBOX exist?** The domain is verified, which proves nothing
  about the user, the invoice now tells customers to reply there, and **Google bounces
  mail to a user that does not exist.** One check in the Admin console settles it.
