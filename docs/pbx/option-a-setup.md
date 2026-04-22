# Connect Option A — One-Time VitalPBX Setup

**Audience:** VitalPBX host administrator. Perform **once per PBX instance**.
After this setup, onboarding a new Connect tenant is a single Inbound Route
edit per tenant — **no further dialplan changes are needed**.

**What Option A is (one-line summary):** Connect owns the IVR schedule, holiday
list, manual override, and active routing state. VitalPBX hosts one tiny
shared custom context that reads tenant-scoped runtime values from AstDB and
sends the call to a pre-existing destination. There is no per-publish dialplan
rewriting, no PBX DB writes, no SSH, and no UI edits after this setup.

---

## Prerequisites

- VitalPBX 4.x (or any Asterisk 18+ with `chan_pjsip`).
- **AMI access** already configured (Connect uses it for CDR/Originate today —
  confirm that `AMI_USER`/`AMI_PASS` work from the Connect telephony service).
  - The AMI account needs the following privilege classes: `system, call, command, originate, reporting`.
    `DBPut`/`DBGet` both live under `system`. No new privileges are added by Option A.
- The Connect telephony service can reach the PBX AMI socket (TCP 5038).
- The VitalPBX instance is linked to a Connect tenant (row in `TenantPbxLink`,
  `status != "ERROR"`).

---

## Step 1 — Install the shared custom contexts (once per PBX)

1. SSH to the VitalPBX host as root.
2. Open (or create) `/etc/asterisk/extensions__60_custom.conf`.
3. Paste the contents of **[`option-a-custom-context.conf`](./option-a-custom-context.conf)**
   at the bottom of the file. **Do not modify** the context names
   `[connect-tenant-router]` or `[connect-default-fallback]` — Connect depends
   on those exact names.
4. Reload the dialplan **without touching anything else**:

   ```bash
   asterisk -rx "dialplan reload"
   ```

5. Verify the contexts are loaded:

   ```bash
   asterisk -rx "dialplan show connect-tenant-router"
   asterisk -rx "dialplan show connect-default-fallback"
   ```

Both commands should list the extensions. If `dialplan reload` reports any
error, revert your edit — **nothing else in VitalPBX is affected** because
Option A only adds two new contexts.

---

## Step 2 — Name your Connect tenant on the PBX side (once per tenant)

Connect derives a URL-safe slug from `Tenant.name` at publish time
(`acme corp` → `acme_corp`). That slug is what the dialplan uses. **You do
not need to create anything on the PBX — the slug is passed at call time via
a channel variable set in Step 3.** This section is just for your records.

To find a tenant's slug as Connect sees it: in Connect, open Portal →
**PBX → IVR Routing**, select the tenant, then click **Publish**. The
toast shows `Publish succeeded for slug=<slug>`.

---

## Step 3 — Point the tenant's Inbound Routes at the shared router (once per Inbound Route)

In the VitalPBX admin UI (**PBX Admin → External → Inbound Routes**):

1. Open an Inbound Route (DID) that should be Connect-controlled.
2. Set **Destination → Custom Destination** to:

   ```
   connect-tenant-router,${CALLERID(dnid)},1
   ```

3. In the **Set Variables** field (VitalPBX ≥ 4.3 exposes this; on older
   builds use a pre-processing script):

   ```
   __TENANT_SLUG=<the tenant's slug>
   ```

   The leading `__` is important — it means "inherit to all child channels".
   If your VitalPBX build doesn't expose this field directly, add a one-line
   prefix context in custom dialplan that sets the variable and then Goto's
   `connect-tenant-router`, e.g.:

   ```
   [inbound-tenant-acme]
   exten => _X!,1,Set(__TENANT_SLUG=acme)
    same =>     n,Goto(connect-tenant-router,${EXTEN},1)
   ```

   …and point the Inbound Route at `inbound-tenant-acme`.

4. Save and Apply Config (if VitalPBX asks).

**That's it.** Every subsequent publish from Connect updates AstDB only. The
Inbound Route configuration never needs to change again.

---

## Step 4 — Verify destinations exist (once per tenant, per destination)

Before the tenant admin configures their Route Profiles in Connect, make sure
each destination they plan to use already exists in VitalPBX:

- **Business hours IVR** — a normal VitalPBX IVR (Applications → IVR). Its
  internal context looks like `ivr-<id>,s,1`.
- **After-hours voicemail / announcement / queue** — ring group, voicemail
  box, time condition, etc. Each has a VitalPBX internal context path.
- **Holiday announcement** — usually a Custom Announcement or an IVR.
- **Emergency / override** — any destination the tenant wants for manual
  override activation.

The Route Profile's `pbxDestination` field in Connect **must** match the
`context,exten,priority` of an existing VitalPBX object. Connect does not
create these — it only references them.

> **Safety note:** If a Route Profile points at a context that doesn't exist,
> the call falls through to `connect-default-fallback` (gracefully announces
> and hangs up). It will **not** crash the dialplan.

---

## Step 5 — First publish

1. In Connect Portal → **PBX → IVR Routing → Route Profiles**, create the
   tenant's Business Hours, After Hours, Holiday, and (optionally) Manual
   Override / Emergency profiles. Each profile's `pbxDestination` is the
   `context,exten,priority` from Step 4.
2. Go to the **Schedule** tab, set the tenant timezone and weekly business
   hours, and link the three schedule-profile dropdowns to the profiles
   from step 1.
3. Click **Publish** (top-right of the page).

Connect will:
- Compute the current mode for the tenant's timezone (business / afterhours /
  holiday / override).
- Snapshot the **current** AstDB values (so Rollback can restore them).
- Write all six keys under `connect/t_<slug>` via AMI `DBPut`.
- Log an `IvrPublishRecord` row.

Place a test call to the DID — you should hear whichever destination matches
the computed mode. On the PBX, watch it route:

```bash
asterisk -rx "core show channels verbose"
asterisk -rx "database show connect/t_<slug>"
```

The `database show` output should look like:

```
/connect/t_acme/mode              : business
/connect/t_acme/dest_business     : ivr-14,s,1
/connect/t_acme/dest_afterhours   : voicemail,8888,1
/connect/t_acme/dest_holiday      : announcement-7,s,1
/connect/t_acme/dest_override     :
/connect/t_acme/override_expires  : 0
```

---

## Ongoing operations (post-setup)

- **Adding a new tenant:** Step 3 and Step 4 only. Dialplan is untouched.
- **Changing business hours / holidays:** Connect UI only. Connect worker
  auto-republishes hourly (or on-demand via the Publish button).
- **Emergency closure / manual override:** Connect UI → Override tab → Activate.
  One AMI DBPut, effective on the next inbound call.
- **Rollback:** Connect UI → Publish History → Rollback on any record. Uses
  the real pre-publish snapshot (captured by the `/telephony/internal/astdb-read-family`
  endpoint at publish time).

---

## What Option A does **not** change

- No VitalPBX UI objects are created, deleted, or modified by Connect at any
  time — before, during, or after publish.
- No SSH sessions, file edits, or CLI commands are run by Connect.
- No per-call HTTP round-trips. Exactly two `DB()` reads per call.
- Unrelated inbound routes, outbound routes, IVRs, queues, and trunks are
  never touched.
- Connect does not attempt to read AstDB families outside
  `connect/t_<slug>`. The family-scope guard in the telephony service
  rejects any write or read attempt that isn't tenant-scoped.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Call goes straight to fallback | `mode` key not in AstDB | Publish from Connect once. |
| Call hangs up at fallback even after publish | `__TENANT_SLUG` not set on the channel | Double-check Step 3. Run `core show channels verbose` during a test call. |
| Publish fails with `ami_not_connected` | Telephony service lost AMI | Check AMI creds + telephony service logs. |
| Publish succeeds but behavior doesn't change | Destination points at non-existent context | Verify the `context,exten,priority` with `dialplan show <context>`. |
| Rollback returns `no_snapshot_available` | Target record predates snapshot capture | Make a fresh publish, then rollback is available for that record onwards. |

---

## Limitations (until the full freeform IVR builder ships)

- Option A controls **routing**, not IVR menu trees. If a tenant wants to add
  a new IVR digit menu, they still do that in VitalPBX, then reference it
  from a Route Profile.
- Holiday rules are a flat `YYYY-MM-DD` list. Recurring holidays ("last Monday
  of May") are not yet modeled.
- One `connect-tenant-router` serves all tenants. If you need per-tenant
  dialplan hooks (e.g. tenant-specific pre-answer macros), create a thin
  tenant-specific prefix context per Step 3's alternative and chain to the
  shared router.
