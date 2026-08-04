# VitalPBX panel contract — creating ring groups and queues

Captured from Izzy's own browser session on 2026-08-03 by recording the panel's
requests. **Nothing here was invented or inferred** — every field name and value
is what the panel actually sent.

Why the panel and not an API: `VitalPbxClient.listRingGroups/createRingGroup/…`
all throw `NOT_SUPPORTED` (the endpoints don't exist in VitalPBX 4), and while
queues do have a REST create, `apply_changes` is broken on this build — it
reports success without regenerating config. So both go through the panel
robot, same as onboarding (`/opt/connect-robot/`).

Session basics are unchanged from the onboarding contract: `POST /index.php`,
login sets `sid`, tenant chosen with the `vpbx_tenant` cookie, `csfr_token`
(40 hex) scraped once from any rendered form and reused.

⚠️ **Saves are `multipart/form-data`, NOT url-encoded.** A recorder that only
understands url-encoded bodies stores `"[object FormData]"` and loses the whole
payload — that happened on the first attempt and cost a re-record.

---

## Ring group

Module `menu20`. Form: `class=ring_group, method=getContent, mode=add`.

### Create — `class=ring_group, method=put, mode=add`

| field | captured value | meaning |
|---|---|---|
| `extension` | `802` | the group's number (Izzy's rule: 800s, first free) |
| `description` | `Sales` | display name |
| `list[]` | `["194","398","397"]` | **members, as extension_ids, IN DRAG ORDER** |
| `strategy` | `ringall` | or `one_by_one` (both values confirmed in `ombu_ring_groups`) |
| `ringtime` | `0` | 0 = system default |
| `prefix` | `Sales` | prepended to caller ID so staff see which line |
| `class_of_service_id` | `1` | |
| `music_group_id` | `` | empty = default |
| `announ_id` | `` | announcement before ringing |
| `answered_elsewhere` | `` | unchecked |
| `answerchannel` | `yes` | |
| `no_release` | `yes` | |
| `mod_dest` | `25` | last destination CATEGORY (25 = `vm_direct`) |
| `destination` | `194` | last destination target id (here: extension_id 194's voicemail) |

### Edit — same plus `ring_group_id`, `destination_id`, `destination_custom`

⚠️ **Checkbox serialisation differs between add and edit.** On `add`,
`answerchannel`/`no_release` are `"yes"`; on `edit` they are `"1"`, and
`answered_elsewhere` is `""` on add but `"1"` on edit. Replay the **add**
format when creating. As always with this panel, an unchecked box is simply
absent — sending it in any form checks it.

⚠️ **`list[]` collapses to a scalar when there is exactly one member**
(`"list[]": "397"`), not a one-element array. The robot must send it as a
repeated field regardless of count.

**This settles member ordering.** The DB table `ombu_ring_group_members` has no
sort column, but it doesn't need one: the panel sends the full ordered array and
rewrites the membership. The robot replays `list[]` in the user's order.

### Last destination
The picker is two dropdowns; the second is populated by
`class=ring_group, method=getDestinationChildOptions, mode=view`.
`mod_dest` is the row id in `ombu_destinations_category`. The three Izzy wants
offered: extension (`category 1`), voicemail (`category 25` = `vm_direct`),
IVR (`category 16` = `ivr`).

---

## Queue

Module `menu21`. Save: `class=queues, method=put, mode=add`. **42 settings**
plus repeating member rows.

### Members
```
queue_members[N][member_id]      ""            (blank on create)
queue_members_N_extension_id     194           NOTE: underscores, not [brackets]
queue_members[N][penalty]        ""
queue_members[N][type]           static
```
A `{{row-count-placeholder}}` row is sent alongside the real ones — the browser
sends it, so include it (same as the trunk form in the onboarding contract).
Note the extension_id key uses **underscores** while its siblings use brackets;
that asymmetry is real and must be reproduced exactly.

### Captured values (create)
`extension=903`, `description=Sales`, `strategy=ringall`, `prefix=Sales`,
`timeout=15`, `retry=5`, `wrapuptime=0`, `queue_timeout=0`, `maxlen=0`,
`music_group_id=1`, `joinempty=yes`, `leavewhenempty=no`, `autofill=yes`,
`autopause=no`, `answerchannel=yes`, `announce_round_seconds=0`,
`periodic_announcement_id=1`, `relative_periodic_announce=yes`,
`announce_position=no`, `mod_dest=25`, `destination=397`.
Empty on create: `join_announcement_id`, `announcement_id`, `servicelevel`,
`alertinfo`, `queue_callback_id`, `periodic_announce_frequency`,
`announce_position_limit`, `announce_frequency`, `min_announce_frequency`,
`penaltymemberslimit`, `memberdelay`, `weight`, `cron_profile_id`, `ivr_id`,
`queue_vip_list_id`, `mod_hangup_dest`, `hangup_dest`, `hangup_dest_custom`.

### Proposed split for the customer-facing form
Izzy's instruction: mainstream options up front, complicated ones under
Advanced, **both** explained in plain language.

**Everyday** — `description`, `extension` (auto), `prefix`, members + order,
`strategy`, `timeout`, `retry`, `music_group_id`, `join_announcement_id`,
`periodic_announcement_id` + `periodic_announce_frequency` +
`relative_periodic_announce`, `announce_position` + `announce_frequency`,
`queue_callback_id`, `queue_timeout`, `mod_dest`/`destination`, on/off.

**Advanced** — `maxlen`, `joinempty`, `leavewhenempty`, `wrapuptime`,
`autopause`, `memberdelay`, `weight`, `servicelevel`, `alertinfo`,
`queue_vip_list_id`, `announce_position_limit`, `min_announce_frequency`,
`announce_round_seconds`, `autofill`, `penaltymemberslimit`,
`mod_hangup_dest`/`hangup_dest`.

**Not exposed** — `class_of_service_id`, `cron_profile_id`, `ivr_id`,
`answerchannel`, `member_id`, `type` (always `static` for a customer-built
queue).

---

## Gaps still open

1. **`one_by_one` was never actually captured** — every recorded save used
   `ringall`. The literal value is known from `ombu_ring_groups.strategy`
   (`one_by_one` / `ringall`), so this is low risk, but the first robot run
   should create a `one_by_one` group and verify it in the DB.
2. **Queue strategies beyond `ringall` were not captured.** Check the panel's
   dropdown values before offering them.
3. **Callback (`queue_callback_id`)** points at a row in `ombu_queues_callback`,
   which is configured on its own screen. That screen was not recorded — needed
   before the callback toggle can be built.
4. **Announcement over music is probably impossible.** Asterisk's periodic
   announce pauses hold music, plays, resumes. `relative_periodic_announce`
   controls *timing* (relative to the announcement's end vs its start), not
   mixing. Getting a voice over music needs a pre-mixed recording.

## Rules for the robot
- Replay the **add** field set for creates, including the placeholder row.
- Never send unchecked checkboxes.
- Send `list[]` / member rows in the user's chosen order — that IS the order.
- Detect hidden failures: the panel answers `state:"success"` with
  `action:"dialog"` and errors inside the modal HTML.
- **Never fire `generateConfigurations`** (Apply Changes). That is Izzy's click.
