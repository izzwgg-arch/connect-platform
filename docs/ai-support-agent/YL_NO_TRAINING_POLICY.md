# Yiddish Labs — Transcription/Translation Only, No Training (Policy & Evidence)

**Status:** enforced in code + audited. **Owner:** Izzy. **Last updated:** 2026-07-21.

## Policy

Yiddish Labs (YL) is used **only** as a live, real-time service — speech-to-text
transcription and Yiddish↔English translation shown to users at the moment of a
conversation. **No Yiddish Labs output is ever used to train, fine-tune, or
otherwise build any model.** This matches Yiddish Labs' terms, which forbid
training on their system.

Our own models are trained **exclusively** on:
- our own audio (customer call recordings, the Yiddish news hotline, the
  comedy/stories archive) captured on our own infrastructure, and
- transcripts that are either produced by **non‑YL** engines (our own ivrit.ai /
  `yi-whisper` RunPod endpoint, OpenAI) **and/or human‑corrected by us**.

## How this is enforced (three independent layers)

The training corpus lives in the `AgentTranscript` table. Every row records its
`model` (provenance). Yiddish Labs rows carry `model = "yiddishlabs"`.

1. **At capture** (`CorpusService.capture`) — any transcript whose provenance is
   Yiddish Labs is written with `trainingEligible = false`, regardless of what
   the caller requested. (`isTrainingForbidden()` in `apps/agent/src/corpus/corpus.ts`.)
2. **At approval** (`CorpusService.approve`) — approving a transcript for the
   corpus can normally flip `trainingEligible = true`. For a Yiddish Labs row this
   is **refused**: it is marked reviewed but stays `trainingEligible = false`, and
   an immutable audit event `corpus.yl_excluded_from_training` is written.
3. **At export** (`CorpusService.exportTrainingManifest`) — the manifest that
   feeds any fine-tune run explicitly excludes `model IN (yiddishlabs, …)`, so
   even a mislabeled or force-flagged row can never reach a training job.

These layers are covered by unit tests in
`apps/agent/src/corpus/compliance.test.ts` (6 tests, all passing).

## Evidence you can produce on demand

- **Compliance report** (owner-only): `GET /agent/compliance/no-training`
  returns, among other counts, `yiddishLabsTrainingEligible` — which is
  **always 0** — and `trainingEligibleByModel`, showing that every training row
  came from a non‑YL engine or a human correction. `exportExcludesYiddishLabs`
  is `true`.
- **Audit log** (append-only, hashed — `AgentAuditLog`): every YL call is logged
  (`yiddishlabs.webhook_completed`, `mic.transcribed` with `engine`), and every
  refusal to train on YL data is logged (`corpus.yl_excluded_from_training`).
  This is a time-stamped, tamper-evident record that YL was used for serving only.
- **Provenance on every sample:** `AgentTranscript.model` names the engine that
  produced each transcript, so the entire corpus is attributable.

## What "training" means here (scope)

- The **transcription model** (Whisper / ivrit.ai `yi-whisper`) is the only thing
  we fine-tune, and only on the sources listed above — never YL output.
- The **reasoning LLM** (Claude) is not retrained; it is steered with prompts and
  our own (non‑YL) context.
- The **translation cache** stores YL translations for fast re-serving only; it is
  a serving cache, not a training input, and is not part of any export.

## Reproducing the evidence

1. Call `GET /agent/compliance/no-training` (owner JWT). Confirm
   `yiddishLabsTrainingEligible: 0`.
2. Export the audit log rows for events `corpus.yl_excluded_from_training` and
   `yiddishlabs.*` for the period in question.
3. Run the export (`exportTrainingManifest`) and confirm no row's audio/text
   traces to a `yiddishlabs` transcript.
