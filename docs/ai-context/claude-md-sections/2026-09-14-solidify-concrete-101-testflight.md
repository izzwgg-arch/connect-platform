# 2026-09-14 · Solidify Concrete ext 101 (Shlomo) added to TestFlight

Full handoff: `docs/ai-context/AGENT_HANDOFF_SOLIDIFY_CONCRETE_TESTFLIGHT_2026-09-14.md`

- Izzy asked for "solidified concrete 101". The Connect tenant is named **Solidify Concrete** (`cmnlgryjz0006p9pa60892fi9`). Ext 101 is "Shlomo", user **sstern@solidifyconcrete.com** (USER, INVITED, never logged in).
- ✅ Added to TestFlight group "Loopcom Testers" (`fe508ee6…`): POST `/v1/betaTesters` → 201, and Apple shows the state as **INVITED** right away, so Apple sent the TestFlight email. Builds 59/58/56 are VALID and attached.
- The portal `USER_INVITE` (the create-password email) had already been SENT to him earlier the same day (19:16 UTC), so it was NOT sent again.
- firstName "Shlomo" came from the extension. **lastName was left blank on purpose.** "Stern" is only a guess from the address, and a betaTester's name can't be changed without deleting and re-adding, which fires a second invite.
- ✅ **Ext 102 "Office"** too (same day): **office@solidifyconcrete.com** added → 201, **INVITED**. No name set, because "Office" isn't a person. This address is also the billing email and owns ext 103 (Toby Horowitz). Its portal USER_INVITE was already SENT at 19:17 UTC, so it wasn't re-sent. Re-send script: `asc-invite-scoffice.mjs`.
- ⏳ NOT PROVEN: he hasn't accepted or installed yet. If he says no email arrived: `node /root/.appstoreconnect/asc-invite-sstern.mjs` on loopcom. If his Apple Account uses a different email, add that address as its own tester.
