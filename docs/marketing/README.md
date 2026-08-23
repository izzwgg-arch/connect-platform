# Marketing — working documents

**Status: draft, under review.** These are being trialled before anything is
distributed. Nothing here is approved copy.

| File | What it is |
|---|---|
| [SERVICES-INVENTORY.md](SERVICES-INVENTORY.md) | What the platform actually does, derived from this codebase. The reference the other documents are checked against. |
| [SERVICES-PROMPT.md](SERVICES-PROMPT.md) | The services block to hand to a copy or site generator, with brand and voice rules. |
| [AD-PROMPTS.md](AD-PROMPTS.md) | Prompt kit for generating ad visuals — brand context, per-scene prompts, negative prompt. |
| [AD-SCRIPT-15S.md](AD-SCRIPT-15S.md) | Three timed 15-second scripts with on-screen text and production notes. |

## Read the inventory first

`SERVICES-INVENTORY.md` was produced by auditing this repository, not by
summarising existing marketing. Its Part 3 lists claims currently in circulation
that the code does not support. The short version:

- **WhatsApp Business** — outbound is simulated in every configuration; no API
  client exists. Inbound webhook capture works.
- **Yiddish voicemail and call transcription** — the implementation lives in
  `apps/agent/`, which holds two of roughly forty-five files and cannot compile.
  It may be deployed outside this repo; that needs confirming.
- **An assistant that does everything** — no auto-reply, no call answering, no
  tool-calling anywhere in the codebase.
- **Custom recordings in multiple voices** — there is no text-to-speech in the
  product. Greetings are uploaded, or recorded by calling in.

Those four are written in the present tense in `SERVICES-PROMPT.md` at the
owner's direction, ahead of deployment. That is a deliberate decision, recorded
here so it is not mistaken for an oversight.

## Operational notes, unrelated to marketing

Surfaced by the same audit and worth separate attention:

- `JWT_SECRET` falls back to the literal string `change-me` if unset, in both the
  API and the realtime service, along with three other token secrets.
- No STOP/opt-out handling on the main SMS inbox — it exists only in the delivery
  module. 10DLC opt-in is collected at registration but never enforced at send.
- Five migrations are untracked and add columns the Prisma schema does not
  declare; `prisma migrate` will report drift.

## Unresolved

- **Domain.** Four are in circulation: `loopcom.com`, `loopcom.ai`, `loopcom.io`,
  and `connectcomunications.com` (what the product ships, 250 references).
- **Registered address.** The brand pack lists a Richmond, California address
  against 845 New York numbers.
- **Per-number and per-SMS rates** for the pricing line.
