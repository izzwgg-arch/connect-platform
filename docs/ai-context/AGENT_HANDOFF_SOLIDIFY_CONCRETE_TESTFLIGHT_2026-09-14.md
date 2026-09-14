# AGENT HANDOFF — Solidify Concrete ext 101 added to TestFlight (2026-09-14)

Izzy, 2026-09-14: *"solidified concrete 101. Add him to test flight and send the email."*

## What was done (live, production ASC; no code, no deploy)

| | |
|---|---|
| Connect tenant | `cmnlgryjz0006p9pa60892fi9` **"Solidify Concrete"** (Izzy said "solidified"; this is the only match for solid%/concrete%) |
| Extension | 101 "Shlomo" `cmnmd7mzg000tp9b06gllyox5` → owner user `cmnmjhhf30015p96hgzoldhrx` |
| User | **sstern@solidifyconcrete.com**, role USER, status INVITED, lastLoginAt null |
| TestFlight | added to "Loopcom Testers" `fe508ee6-4a3f-49dd-bf53-858839fa2f06`, POST `/v1/betaTesters` **201**, state **INVITED** straight away |
| Builds attached | 59, 58, 56: all VALID, not expired |
| Scripts (loopcom) | `/root/.appstoreconnect/asc-add-sstern.mjs`, `asc-invite-sstern.mjs` (sed copies of the Hanna scripts) |

## "Send the email", and why nothing else was sent

- The TestFlight invite email is sent **by Apple** when a tester is added to the external group. There is no separate send. The INVITED state (unlike Hanna's NOT_INVITED lag) confirms Apple sent it.
- The Loopcom portal invite (`USER_INVITE`, create-password link) had already gone out: EmailJob `cmu1mi9rm00xgmq12ka9iae0t` was SENT 2026-09-14 19:16:03 UTC by an earlier action the same day. office@solidifyconcrete.com got one at 19:17. It was not sent again, to avoid a duplicate.

## Honest gaps

- ⏳ He has not accepted or installed the app. If he says the email never came, re-run `node /root/.appstoreconnect/asc-invite-sstern.mjs`. It only re-invites while the state is NOT_INVITED or INVITED.
- lastName is **null on purpose**. "Stern" would be a guess from the address, and betaTesters have no PATCH (renaming = delete + re-add = second invite).
- If his iPhone's Apple Account uses a different email, the invite redeem may still work through the link. If it doesn't, add that address as its own tester (see the Eli handoff §TestFlight).
