# B Visible — "a delivery driver called and the phone never rang" (2026-09-01)

**Read-only investigation. No code, no deploy, no migration, no PBX write, no data
change.** Every fact below is read from the live Asterisk log, the rendered
dialplan, `ombutel` and `asterisk.cdr` on the PBX, and Connect's own database.

Izzy, 2026-09-01: *"This was a delivery person that called and got the voicemail.
What happened on this call? Why didn't the phone ring?"*

Tenant **B Visible** (`cmnlgryp8001lp9pajhatv3t9`, PBX tenant **T9**), DID
**(845) 238-0478**, extension **101 "Front Desk"**.

---

## 1. The answer in one line

**The phone never rang because the caller pressed `3`, and option 3 is a
recording ("Company Directory"), not a person.** Nothing on that path dials a
phone. He then pressed nothing for three menu cycles, so the IVR ran out of
retries and dropped him into Front Desk voicemail.

## 2. The call, to the second

Call `1788272846.53082`, from `/var/log/asterisk/full` (times are the PBX's local
EDT; UTC = +4).

| Time (ET) | What happened |
|---|---|
| 10:27:26 | Inbound on trunk 54 -> route "Main" -> time condition TC-5 |
| 10:27:26 | **TC-5 MATCHED** (`08:30-18:00,mon-thu`) -> open menu `IVR-25` "Main" |
| 10:27:26 | Greeting starts (`6c8349cc...`, ~21.5 s) |
| 10:27:44 | Caller presses **3** (18 s into the greeting) |
| 10:27:44 | Option 3 -> `T9_app-announcement,announcement-19` = **"Company Directory"**, plays 22 s |
| 10:28:06 | Announcement ends -> **returns to the main menu**, greeting replays in full |
| 10:28:28 | Greeting ends -> `WaitExten(10)` |
| 10:28:38 | Nothing pressed -> plays **`option-is-invalid`** -> greeting replays |
| 10:29:12 | Nothing pressed -> `option-is-invalid` -> greeting replays |
| 10:29:46 | Nothing pressed, 3rd strike -> `sorry-youre-having-problems` + `vm-goodbye` |
| 10:29:48 | -> `sub-extensions-vm,VM-101` -> `VoiceMail(101@b_visible-voicemail)` |
| 10:29:53 | Beep, recording starts |
| 10:30:17 | Caller hung up. 21-second message -> the email Izzy received. |

**147 seconds elapsed between the call arriving and the beep.**

- **No `Dial()` was ever executed on this call, and that is proven twice** — the
  log contains none, and both call records list only the inbound trunk channel
  (`PJSIP/344022_Smooth2-00006a58`) with no extension channel. Asterisk's own CDR
  row reads `src 7705573001 -> dst VM-101 ANSWERED 171`.

## 3. The Front Desk phone was healthy — checked, not assumed

`T9_101` was registered and `Avail` throughout (contact
`sip:T9_101@47.17.126.158:49609`, RTT ~364 ms), and **at 10:57 the same morning
another caller reached ext 101 and talked for 3 m 31 s**. Nothing was wrong with
the phone, the registration or the network.

## 4. The menu, read from the rendered dialplan (the authority)

- Decoding `ombu_destinations` by `module_id`/`index` gives WRONG answers here —
  the documented trap. These come from `dialplan show IVR-25`.

| Key | Destination | Rings a phone? |
|---|---|---|
| **0** | `T9_cos-all,101` — Front Desk | YES |
| **1** | `T9_cos-all,101` — Front Desk | YES |
| 2 | time condition TC-15 | depends |
| **3** | **`announcement-19` "Company Directory"** | **NO** |
| 101 | ring group 800 "BV 101" | YES |
| 102 | ring group 801 "BV 102" | YES |
| 103 | ext 103 Nechamya Weiss | YES |
| 104 | ring group 802 "BV 104" | YES |
| 105 | ext 105 Moshe Klein | YES |
| 106 | ext 106 Gershon Felberboim | YES |
| 0478 | `T9_app-disa,DISA-1` (dial-out) | n/a |
| no answer x3 | `sub-extensions-vm,VM-101` | NO — voicemail |

`freedial: no`, so only those exact shortcuts work — a caller cannot dial an
arbitrary extension. `timeout: 10`, `timeout_tries: 3`, digit timeout 2 s.

**Pressing 0 or 1 would have rung the Front Desk immediately.** He pressed 3.

## 5. This is NOT a one-off — option 3 is a dead end that loses callers

From `ombu_ivr_stats` (IVR-25, 3,542 recorded key presses) joined to
`asterisk.cdr` (retention 2025-07-27 -> today):

- **167 presses of option 3 across 157 distinct calls.**
- **88 of those 157 calls (56%) then pressed nothing at all** — exactly this
  caller's shape.
- Of those 88, the final destination per call is:
  **43 hung up at the Company Directory recording (avg 38 s)**, 17 hung up back
  at the main menu (`s`, avg 54 s), 4 at `#`, 2 invalid, 2 -> VM-102, and
  **exactly 1 -> VM-101 at 171 s — which IS this delivery driver.**

- **So ~60 callers have pressed 3 and then vanished with no trace at all** — no
  voicemail, no missed call, nothing anyone could follow up. This driver is the
  *only* one in the whole retained history who stayed on the line long enough to
  leave a message. **The voicemail is the exception, not the pattern.**

### The wider picture on that line (last 30 days, inbound, one row per call)

| Outcome | Calls |
|---|---|
| Reached ext 101 Front Desk | 208 |
| **Ended at the menu, nobody reached, no message (`s`)** | **200** |
| Reached ext 106 | 71 |
| Voicemail 104 | 47 |
| Voicemail 101 | 40 |
| Reached ext 103 | 31 |
| Reached ext 105 | 25 |
| Voicemail 102 | 8 |
| timeout `t` / invalid `i` / announcements | 17 |

- **Do not read all 200 as lost customers** — 68 of them lasted under 15 s,
  which is the robocall/wrong-number shape. But **63 lasted 35 s or more**, i.e.
  they heard the 21-second greeting at least twice and still gave up.

## 6. Three defects worth fixing (none touched — B Visible's own IVR config)

1. **The Company Directory dead-ends.** After the 22-second recording it returns
   to the main greeting rather than ringing the Front Desk. 56% of the people who
   press 3 never press anything again.
2. **The timeout plays the wrong prompt.** A caller who pressed *nothing* is told
   **"that option is invalid"** (`option-is-invalid` on the `t` extension), three
   times. It reads as the system blaming them for something they did not do.
3. **The path to a human is long.** Greeting is ~21.5 s; the full cycle before
   voicemail is 2 m 22 s. Same class as the Gesheft 24-second-greeting finding.

## 7. THE ONE GAP — nobody has listened to the recordings

I have **not** heard either file, so I cannot say whether the greeting steers a
delivery driver toward option 3, nor whether the Company Directory tells people
to dial an extension afterwards. Both are ~22 s. Izzy can settle it in 45 seconds:

- Greeting: `/var/lib/vitalpbx/static/2b9df1ace9927067/recordings/6c8349cc7260ae62e3b1396831a8398f.wav`
- Company Directory: `/var/lib/vitalpbx/static/2b9df1ace9927067/recordings/44f683a84163b3523afe57c2e008bc8c.wav`

**That answer decides the fix.** If the greeting offers 3 to someone at the door,
option 3 should ring the Front Desk instead of playing a directory.

## 8. Method notes for the next investigation of this shape

- **`/var/log/asterisk/full` holds TODAY ONLY** (no `full.1`). This call was
  today, which is the only reason a second-by-second trace exists. Tomorrow it
  would have been unrecoverable.
- **Grep the CHANNEL name (`00006a58`), not the linkedid** — the linkedid
  appears twice in the whole file; the channel appears hundreds of times.
- **`disposition: "answered"` means the IVR answered**, never that a human did.
  Every one of these lost calls reads ANSWERED.
- **`dst='VM-101'` is NOT tenant-scoped** — every tenant has an extension 101,
  so an unscoped count returned **1,374** where B Visible's real figure is **40**.
  Always add `tenant='b_visible'` **and** `uniqueid=linkedid` (one row per call).
- **`ombu_ivr_stats` has no timestamp column** — it can only be dated by
  joining to `asterisk.cdr` on `unique_id = linkedid`.
- **That join is EXPENSIVE and the PBX does live SQL reads on the call path**
  (`EXTENSION-SETTING` at call time). One such query ran 160 s before it was
  killed with `KILL QUERY`. **Bound these queries by date, or pre-fetch the id
  list and use an `IN` list against the `cdr_linkedid_index`.**
- The time-condition trace is easy to misread: `Goto (TG-6,s,7)` **is** the
  `[match]` label. It matched; business hours were correct.
- The heredoc trap bit again writing this file — write docs through the editor.
