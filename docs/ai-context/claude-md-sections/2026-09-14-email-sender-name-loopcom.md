# Outgoing email sender name is "Loopcom" now, not "Connect" (2026-09-14)

Izzy: *"change the name of outgoing emails from the system to Loopcom. It still says Connect."*

**Where the name comes from:** every email the platform sends (voicemail, invites,
billing, escalations, reminders) goes through the api's `sendEmailJobNow`
(`apps/api/src/server.ts` ~L1163). Its From display name is
`EmailProviderConfig.fromName`. There is ONE enabled row
(`connect-admin-tenant-v1`, GOOGLE_WORKSPACE, `support@connectcomunications.com`),
and every tenant without its own row falls back to it. It said **`Connect`**.

- ✅ **LIVE DB change 2026-09-14:** `fromName` `Connect` → `Loopcom` on that row
  (UPDATE 1, verified by `RETURNING`). It is read per send, so no restart is needed.
  Rollback: set it back to `Connect`. It can also be edited on the portal page `/settings/email`.
- ✅ **Code fallback** (used only when `fromName` is empty) changed from
  `"Connect Communications"` to `"Loopcom"` on both the SendGrid and SMTP paths.
  Commit `770de892`; no test pinned the old string. ✅ **api DEPLOYED 2026-09-14**
  via `deploy-direct.sh api --commit 770de892…` (log `/root/deploy-api-770de892.log`):
  `app-api-1` `.build-commit` = `770de892`, 0 restarts, `/health` 200.
- ⛔ **The ADDRESS is unchanged:** it is still `support@connectcomunications.com`.
  Changing it to an `@loopcom.net` mailbox is a separate step. Gmail SMTP rewrites the From header to
  the logged-in account unless that address is a verified "send as" alias, and the
  sending account's 500/day cap still applies (see the one-mailbox section).
- **Not changed, and why:**
  - PBX `voicemail.conf` has `fromstring=Connect` (read-only box). Per the 09-02 section, no tenant uses the PBX's own voicemail email any more, so it sends nothing.
  - The agent's default `"Connect Agent <agent@…>"` (`apps/agent/src/config.ts`) is not used: `AGENT_SMTP_HOST` is unset in `app-agent-1`.
  - The SMS bridge already sends as `Loopcom Texts <sms@loopcom.net>`.
  - The agent's `brandName: "Connect"` (voicemail email body, `apps/agent/src/server.ts` ~L1141) is body text, not the sender name.
- ⏳ **NOT PROVEN:** nobody has opened an email that went out after the change.
