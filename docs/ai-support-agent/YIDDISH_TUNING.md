# Yiddish Tuning Flywheel — turning your call volume into your own model

_2026-07-19. Owner: Izzy. The goal: transcribe heimishe NY-Yiddish calls accurately, and use that
accumulating, human-corrected data to progressively tune a model that gets the slang, dialect, and
accent better than anything off the shelf — because nobody else has this corpus._

## The honest reality (why this is the right bet)

- **No off-the-shelf API nails heimishe Yiddish.** General Yiddish STT (Everett.ai, Whisper-based
  services, ElevenLabs Hebrew, Speechmatics) reaches decent WER on *literary/standard* Yiddish, but
  Hasidic NY Yiddish — with loshn-koydesh vocabulary, Yinglish code-switching, and a distinct accent —
  is a low-resource dialect that generic models get wrong on exactly the words that matter.
- **Fine-tuning closes the gap dramatically.** Published low-resource results show targeted fine-tuning
  cuts word-error rate from ~48–90% (zero-shot) down to ~12–45%, and adding a domain language model on
  top gives another double-digit improvement. Your data is the ingredient that makes that happen.
- **Your calls are the moat.** Thousands of real Yiddish calls/day = the largest heimishe-Yiddish speech
  corpus in existence, in *your* accent, *your* slang, *your* business vocabulary. That is the asset.

## The flywheel (how it compounds)

```
 call recording ──► best-available STT (Everett/Whisper) ──► transcript + confidence + audio ref
        │                                                              │
        │                                       low-confidence / flagged │
        │                                                              ▼
        │                                              human correction (team / native speaker)
        │                                                              │
        │                                          corrected (audio, text) PAIR  ◄── the gold
        ▼                                                              │
   dialect glossary ── biases decoding on known slang/terms           ▼
   (boosts every transcript immediately)              accumulating training corpus
                                                                       │
                                        every N thousand pairs ──► fine-tune (Whisper LoRA) +
                                                                   domain language model
                                                                       │
                                                                       ▼
                                              our own Yiddish model → better STT → less correction
                                                                       │
                                                                       └──────── loop tightens ───────►
```

Each turn of the loop means less human correction, better accent/slang capture, and a model that
increasingly *is* the business's voice — the "own tuning" on top of any base API.

## Data sources — everything links into ONE corpus

The dataset isn't just live calls. Multiple feeds pour into the same labeled corpus, each tagged with a
`source` so we know its provenance and quality:

1. **Live calls, 24/7 (`live_call`).** The agent runs continuously; every recorded call is transcribed
   and captured. Thousands/day → the bulk of the accent + real-conversation data. Let it run around the
   clock and the corpus grows on its own.
2. **The Yiddish news/reviews hotline (`news_hotline`).** A whole library of heimishe content — news,
   reviews, spoken NY Yiddish with English mixed in (Yinglish code-switching). This is *ideal* training
   data: clean-ish audio, rich vocabulary, the exact dialect. We ingest it in bulk (call in / pull the
   recordings), transcribe, and it massively enriches the corpus beyond what calls alone give — more
   vocabulary, more topics, more speakers.
3. **Bulk archive — thousands of hours on a hard drive (`bulk_import`).** The owner has an enormous
   library: comedy, kids' stories, spoken content — thousands of hours of natural, expressive, heimishe
   speech. We mount the drive and point the **Archive Ingestor** at it: it walks every audio file 24/7,
   transcribes, and captures into the corpus, tagged by collection (`comedy`, `kids_stories`, …) and
   progress-tracked so it resumes where it left off and never re-does a file. This is the richest source
   for **accent, prosody, and natural delivery** — exactly what a human-sounding model needs. It runs
   unattended; the more it listens, the better it gets.
4. **Corrections (`correction`).** Human-fixed transcripts — the highest-value, "gold" pairs.

All four feed the same `AgentTranscript` corpus and the same glossary. The news hotline especially teaches
the model the **code-switching** — that a sentence is mostly Yiddish with English words dropped in
("appointment", "insurance", "the office") — which is the single hardest thing for a generic model.

## Architecture (built now — the capture + correction + glossary layer)

1. **Corpus capture.** Every transcription stores: audio reference, raw transcript, detected language,
   provider/model, **confidence**, and a `trainingEligible` flag (consent + retention respected). This
   turns the existing `AgentTranscript` table into a growing labeled dataset — additive fields only.
2. **Dialect glossary.** A curated list of heimishe terms, slang, loshn-koydesh words, names, and common
   Yinglish spellings. It (a) biases STT decoding via the provider's phrase/keyword-boost hooks so those
   words transcribe right *immediately*, and (b) seeds the domain language model for fine-tuning. Grows
   as the team spots misses.
3. **Correction loop.** Low-confidence or flagged transcripts route to a review queue; a native speaker
   fixes them. Each correction becomes a gold (audio, correct-text) pair AND, when it reveals a new
   slang/term, a glossary entry. Corrections are the highest-value data.
4. **Export for tuning.** A job exports the corrected pairs (Whisper-format manifest) for a periodic
   fine-tune (Whisper-Turbo + LoRA, 8-bit — the resource-efficient path) plus an n-gram/LLM domain
   language model. The tuned model plugs back in behind the same Transcriber interface.
5. **Accent/TTS side — the human-sounding voice.** The archive (comedy, stories — expressive, natural
   delivery) plus corrected call data, with speaker labels, is the training material for cloned voices.
   The owner clones a few specific people (voice talent mentioned in the content), and those voices —
   fine-tuned on this heimishe corpus — become the agent's TTS voices, so it *speaks* NY Yiddish that
   sounds like a real person, not a robot. The Archive Ingestor tags speaker segments so clean, single-
   speaker audio can be pulled per voice for the clone. Voice Studio (already built) manages the library
   and rendering; the ElevenLabs custom-voice training uses these curated clips.

## Privacy & consent (non-negotiable)

- Calls are tenant-isolated; `trainingEligible` defaults **off** and is enabled only where consent +
  retention policy allow. Corrected data used for tuning is scoped and access-controlled.
- The corpus is the business's own asset — not shared across tenants, not sent anywhere the owner hasn't
  approved.

## Provider posture

- **Now:** Everett.ai (Yiddish) / Whisper (English + code-switch) behind the existing Transcriber
  interface, with glossary phrase-boosting applied. Guarded until the API key is present.
- **Next:** once enough corrected pairs accumulate, swap in the fine-tuned model behind the same
  interface — zero downstream changes. That's the "our own tuning" milestone.

## What Izzy provides

- Everett.ai API key (Yiddish STT) → starts real transcription + corpus capture.
- A native speaker (or the team) to run the correction queue — this is what makes the model *yours*.
- Later: ElevenLabs account for the custom NY-Yiddish TTS voice.
