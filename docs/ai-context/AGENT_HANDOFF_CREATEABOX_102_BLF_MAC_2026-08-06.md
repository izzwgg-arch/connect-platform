# AGENT HANDOFF — Create A Box ext 102: BLF edits went to a file nothing downloads (2026-08-06)

Izzy: "I updated the BLFs inside VitalPBX yesterday and it didn't update on the phone. It
was around the same time we had the problems with the network." Both halves of that
sentence turned out to be wrong leads, and the real cause is a trap that will bite again
on any tenant.

**Status: FIXED and verified live** under Izzy's explicit one-time PBX write mandate,
scoped to this one extension. Nothing else on the PBX was touched.

---

## 1. The one-paragraph version

VitalPBX provisioning does **not** look a phone up when it asks for settings. It
pre-renders a file named `<mac>.cfg` **at the moment you press Save in the panel**, and
nginx then hands out whatever filename the phone requests. The device record for Create A
Box ext 102 carried MAC `80:5E:C0:B3:B2:D0`; the Yealink T53 actually on Sender Weiss's
desk is `80:5E:0C:60:99:08`. So every save rewrote a file nothing ever downloads, while
the phone kept downloading its own file — last written **July 19** — with a clean HTTP
200 every time. Right account, right password, zero BLF keys, frozen for seven weeks.

## 2. ⛔ Two premises that sound airtight and are both false

These cost most of the session, and they will be raised again.

**"If the phone is registered, the MAC has to be in the system."** No — the MAC has
nothing to do with registration. Proof, from the live box:

```
[T7_102]
auth = authT7_102
identify_by = username,auth_username
```

`grep -c` for a MAC pattern in the whole tenant SIP config = **0**. Across the entire
phone-system schema (`ombutel` + `asterisk`) the only `mac` column anywhere is
`ombu_static_leases` (DHCP reservations). `ombu_devices`, the table that defines a SIP
device, has **no MAC column at all**. MAC exists only in the separate `provisioning`
database, whose sole job is choosing which file to render. The phone had valid
credentials baked into the July 19 file and stores them locally, so it registers forever.

**"The network outage broke it."** The phone pulled config **six times** on 2026-08-05 —
12:27:16, 12:28:19, 12:41:37, 12:42:41, 12:44:57, 12:45:58 — all HTTP 200. The tunnel
outage (`AGENT_HANDOFF_CREATEABOX_T7_OUTAGE_2026-08-05.md`) began at **12:57**. The
fetches succeeded and finished eleven minutes before it started.

## 3. The evidence that settles it — file mtimes

`/var/lib/vitalpbx/provisioning/provisioning_templates/59943f7a1616b24e/`
(that token is the tenant path hash, same string as the T7 AstDB family).

| file | mtime | contents |
|---|---|---|
| `805e0cbd135a.cfg` — ext 101, MAC on record is correct | **Aug 5 12:26:15** | its 5 BLFs ✅ |
| `805ec0b3b2d0.cfg` — the MAC written on the "102" record | **Aug 5 12:41:20** | all 6 of 102's keys, correct |
| `805e0c609908.cfg` — **the phone actually on the desk** | **Jul 19 22:46** | account right, `grep -c "\.type = 16"` = **0** |

Yesterday's sequence, from `/var/log/nginx/access.log.1`: he saved 101 at 12:26:15 and
101's phone fetched at 12:26:44 — **that one worked**, which is exactly why 102 looked
broken rather than the feature looking broken. He saved 102 at 12:41:20, then resynced
102's phone four times, and all four downloads were the untouched July 19 copy.

`805e0c609908` exists in **no database** — verified against full `mysqldump`s of
`ombutel`, `provisioning`, `asterisk`, `astboard` and `sonata_*` in every MAC separator
format. Only the disk file existed, which is the last trace of a time when the record did
carry that MAC. `805ec0b3b2d0` has **never** requested a config in 14 days of logs.

## 4. What was changed (2026-08-06 13:55 ET)

1. `provisioning.devices` id 15 (tenant 7, description "102", model 153 = T53, template 53
   "Sender"): MAC `80:5E:C0:B3:B2:D0` → **`80:5E:0C:60:99:08`**. This is the durable half —
   future panel saves now render to the filename the phone asks for.
2. Rewrote `805e0c609908.cfg` from the correct Aug-5 render so the fix took effect
   immediately without waiting for a panel save.
   ⛔ Use `cat src > dest`, **not `cp`** — the provisioning dir carries POSIX ACLs (note the
   `+` in `ls -la`) and the files are `www-data:www-data 664`; overwriting in place keeps
   the destination's inode, owner, mode and ACL. Verified after the write.
   Safe because a full diff of the two files showed **only** the six linekey blocks plus
   `local_time.summer_time`, with a byte-identical account block (same sha1 over
   `user_name`/`auth_name`/`password`/`sip_server`/`register_name`). Diff before copying —
   a differing password would have knocked the phone offline.
3. `asterisk -rx "pjsip send notify yealink-check-cfg endpoint T7_102"` — check-sync with
   `reboot=false`. ⛔ Not the panel's reboot button; see
   `desk-phone-reassign-needs-check-sync` in the auto-memory dir for why a reboot is not a
   re-provision. Confirmed one contact on the AOR first, so exactly one handset was hit
   (the app is a separate endpoint, `T7_102_1`).

**Backups:** `/root/blf-102-backup-20260806/` — both `.cfg`/`.boot` pairs as they were,
plus the pre-change DB row. `805ec0b3b2d0.cfg` is now an orphan file; harmless.

## 5. Verification (this is the part to copy for future prov work)

- Phone fetched **1 second** after the NOTIFY, and the served size changed
  **138162 → 138270** — the new file, not the frozen one. A size change is the cheapest
  proof a phone took a config.
- Still registered throughout: `T7_102` contact Avail, RTT ~259 ms.
- `pjsip show subscriptions inbound` → **5 BLF subscriptions** from T7_102, resources
  **101, 103, 105, 106, 107**, from LAN IP 192.168.8.160. Those subscriptions only exist
  because the phone read the new file and asked the PBX to report presence. The 6th key
  (Mrs. Mushkowits, 8453630398) is a speed dial and correctly subscribes to nothing.
- ⛔ `linekey.2.value` renders as `103 ` **with a trailing space** (the stored key JSON has
  `"value":"103 "`). It was flagged mid-session as a likely dead key and that was **wrong**
  — Yealink trims it and 103 subscribed normally. Left as Izzy wrote it. Do not "fix" it.

## 6. The reusable diagnostic

For **any** "I changed it in VitalPBX and the phone didn't change":

```
grep phoneprov /var/log/nginx/access.log          # + zgrep the .gz for 14 days
```

Every settings download is logged with the phone's **own MAC in its User-Agent**
(`Yealink SIP-T53 96.86.0.113 80:5e:0c:60:99:08`). Compare that MAC against the one on the
record, then `stat` the matching `<mac>.cfg`:

- Phone fetched, but its file's **mtime predates your edit** → wrong MAC on the record.
  This case.
- **No fetch at all** from the customer's IP → the phone never asked; fire the check-sync
  NOTIFY. That is the sister failure, documented in
  `desk-phone-reassign-needs-check-sync` — same symptom, opposite cause.
- A hit from **127.0.0.1 with user agent "VitalPBX"** is only the panel rendering a page,
  and proves nothing about the phone. (My own verification `curl` also lands as 127.0.0.1 —
  don't mistake it for the handset later.)

## 7. Environment notes

- PBX reads work fine over ssh from the local Git Bash tool with the repo key
  `.connect-ssh/connect2_server2_ed25519`, port 22, `root@209.145.60.79`.
- ⛔ **Do not suppress stderr on probes.** An early `mysqldump ... 2>/dev/null | grep` was
  the exact trap the T7 outage handoff warns about — a failed dump would have read as
  "the MAC isn't in the database". It was re-run with stderr visible and an explicit
  exit-code and byte-count check before the conclusion was trusted, and only then held up.
- The rendered config indents its key lines (`    linekey.1.label = …`), so
  `grep "^linekey"` finds nothing and reads as "no BLFs anywhere". Grep the label text or
  `\.type = 16` instead.

## 8. Left alone on purpose

- An older duplicate "102" record: id 23, Grandstream GXP2170 `c0:74:ad:8c:60:5f` — the
  phone that used to be at that desk. It is why the panel shows 102 twice. Cosmetic.
- **Ext 104 and 106 are not registered.** 101/102/103/105/107 are Avail. Flagged to Izzy,
  not investigated — outside the mandate.
- The `AGENT_HANDOFF_CREATEABOX_T7_OUTAGE_2026-08-05.md` §4 staged registration-expiry fix
  is **now confirmed applied**: all seven T7 aors read `default_expiration 120 /
  maximum_expiration 120`. That doc's "first actions" item 1 is done.
