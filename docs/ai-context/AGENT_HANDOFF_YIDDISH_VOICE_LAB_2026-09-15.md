# Yiddish Voice Lab: design for the long-term Yiddish voice dataset (2026-09-15)

**Status: DESIGN ONLY, awaiting Izzy's approval. Nothing is built, migrated or deployed.**
Mockups: `docs/mockups/yiddish-voice-lab/voice-lab.html`, published as https://claude.ai/artifact/Kxy7NSV8CPw41B7se2NcLp (14 screens, every one labelled "MOCKUP — not built"). The only Yiddish in it is four verbatim Yiddish Labs outputs, and the page checks at runtime that each quoted word is an exact substring of them.

## 0. What was true before this design (checked, not assumed)

- **The system Izzy called "the Yiddish Labs → OpenAI Voice testing system we just built" does not exist.**
  It is not on any branch, worktree or stash, and not in any Claude or Codex session transcript.
  Searching `apps/` for `audio/speech`, `gpt-4o-mini-tts` or `tts-1` finds nothing.
- The closest existing pieces:
  - `apps/agent/src/voice/studio.ts` is a stub. `render()` returns `render_call_not_wired_pending_key`.
  - Talk to Laybel (`0790ca71`) speaks with the browser's own voice, not OpenAI, and is not deployed.
  - Real audio generation lives in the api: `elevenLabsRoutes.ts`, `pollyRoutes.ts` and `generatedPromptStore.ts`.
- ⛔⛔ **Yiddish Labs output may never train or fine-tune a model.**
  - Recorded in `docs/ai-support-agent/YL_NO_TRAINING_POLICY.md`, which cites Yiddish Labs' terms.
  - Enforced in `apps/agent/src/corpus/corpus.ts:26-37` (`TRAINING_FORBIDDEN_MODELS`) at capture, approval and export.
  - Every sample in this system starts from Yiddish Labs text, so that text is **serving-only** and is excluded from every training export.
- ⛔ **The model never writes Yiddish.** Yiddish text comes only from Yiddish Labs or a human.
- **OpenAI speech facts (documentation, Sept 2026):**
  - Models: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`.
  - Voices: 13 (tts-1 has 9).
  - `instructions` works on mini-tts only and is free text.
  - `speed` is 0.25–4. Whether mini-tts honours it is unverified; measure the output.
  - Input limit 4,096 characters.
  - Hebrew is a listed language; **Yiddish is not**.
  - **No SSML, no phonemes, no lexicons, no speech fine-tuning.**
  - Custom voices are sales-gated and need a consent recording in about 16 languages, none of them Hebrew or Yiddish.
  - End users must be told the voice is AI-generated.

## 1. The layers (each one stored separately and never overwritten)

```
tester input ──► Yiddish Labs (translate / process)  ──► SOURCE TEXT      (verbatim, immutable)
                                                          │
                 Loopcom Speech Layer                     ▼
                 (dictionary version + context rules ─► PREPARED TEXT    + one audit step per rule applied
                  + style profile version)                │
                                                          ▼
                 Provider adapter (openai today) ──────► REQUEST          (exact body minus auth)
                                                          │
                                                          ▼
                                                        AUDIO ─► ratings, corrections, prosody marks,
                                                                 A/B verdicts, golden/rejected, regression
```

**How pronunciation is controlled today with OpenAI:**
- **Respelling:** a reviewer-entered spoken form replaces the span in PREPARED TEXT only.
- **Instruction hints:** "say X like Y" is added to `instructions`.
- Each dictionary entry and each config version chooses which lever it uses.
- IPA is always stored alongside, for providers that can use it later (ElevenLabs v3 or flash phonemes, Azure SSML, a trained model).

## 2. Data model (additive migration `YYYYMMDDHHMMSS_yiddish_voice_lab`, platform-scoped, never tenant rows)

Fields are named so that nothing is locked to OpenAI.

| Table | Purpose | Key fields |
|---|---|---|
| `VoiceLabSourceText` | What Yiddish Labs (or a human) wrote | `text`, `sha256`, `origin` YIDDISH_LABS / HUMAN_AUTHORED / HUMAN_TRANSCRIBED, `testerInput`, `ylAction`, `ylCreditsConsumed`, `trainingUse` SERVING_ONLY / ELIGIBLE (**forced SERVING_ONLY when origin is YL**), `consentRecordId?` |
| `VoiceLabTextTransform` + `VoiceLabTransformStep` | What the speech layer did | `preparedText`, `requestText`; one step per rule: `ordinal`, `ruleType`, `lexiconEntryRevisionId?`, `contextRuleId?`, `spanStart/End`, `before`, `after` |
| `VoiceLabStyleProfile` | Natural Yiddish, Tech Support, Hasidic — Experimental… | `slug`, `name`, `isCustom`, `isExperimental` |
| `VoiceLabConfigVersion` | **Immutable** once used | `profileId`, `version`, `status` DRAFT / EXPERIMENTAL / PRODUCTION / RETIRED, `provider`, `model`, `voice`, `instructions`, `speed?`, `responseFormat`, `providerParams` (documented parameters only), `lexiconVersionId`, `rulesetVersion`, `internalStyleMeta` (**labelled not sent**), `parentVersionId`, `proposalId?`, `approvedById/At` |
| `VoiceLabAudioAsset` | Audio file record | `storageKey`, `sha256`, `bytes`, `format`, `durationMs`, `kind` GENERATED / HUMAN_REFERENCE, `retentionClass`, `expiresAt?`, `deletedAt`, `deleteReason` |
| `VoiceLabSample` | One generation | `sourceTextId`, `transformId`, `configVersionId`, `requestParams` (sanitised), `audioAssetId`, `latencyMs`, `httpStatus`, `providerRequestId`, `error`, `appVersion`, `purpose` MANUAL / AB / REGRESSION, `curation` NONE / GOLDEN / REJECTED, `curatedById/At`, `createdById` |
| `VoiceLabRating` + `VoiceLabCategoryScore` | One-tap overall rating plus optional categories | overall EXCELLENT / GOOD / NEEDS_WORK / BAD; category (14 values) × EXCELLENT / GOOD / NEEDS_WORK / WRONG, `note` |
| `VoiceLabRejectionReason` | Why a sample was rejected | reason enum (wrong pronunciation, accent, robotic rhythm, stress, English mangled, too fast, mood, other) + `note` |
| `VoiceLabComparison` | A/B tests | `sourceTextId`, `dimension` VOICE / INSTRUCTIONS / MODEL / CONFIG, `sampleAId`, `sampleBId`, `leftSampleId` (randomised), `blind`, `verdict` A / B / SAME / BOTH_BAD, `raterId` |
| `VoiceLabWordCorrection` | A problem word inside one sample | `sampleId`, `spanStart/End`, `surface`, `heardAs`, `preferredSpoken`, `phonetic`, `transliteration`, `ipa`, `explanation`, `dialectNotes`, `referenceAudioId?`, `status` UNVERIFIED / VERIFIED / REJECTED, `promotedEntryId?` |
| `VoiceLabProsodyMark` | Rhythm and cadence marks | `sampleId`, `spanStart/End`, `audioStartMs/EndMs?`, `kind` (TOO_FAST, TOO_SLOW, PAUSE_LONGER, PAUSE_SHORTER, STRESS, NO_STRESS, RAISE_TONE, LOWER_TONE, MORE_CONVERSATIONAL, MORE_SERIOUS, WARMER, MORE_CONFIDENT, LESS_ROBOTIC, MORE_ENERGETIC, MORE_RELAXED), `note` |
| `VoiceLabLexiconEntry` + `VoiceLabLexiconEntryRevision` | The dictionary; every edit makes a new revision | `writtenForm`, `normalizedForm`, `languageOrigin` YI / HE_ORIGIN / EN / NAME / PLACE / BUSINESS / ACRONYM / NUMBER, `category`, `dialect`, `ipa`, `transliteration`, `notes`, `verified`, `confidence` |
| `VoiceLabLexiconRealization` | How one provider says an entry | `revisionId`, `provider`, `model?`, `method` RESPELLING / INSTRUCTION_HINT / ALIAS / PHONEME, `value` |
| `VoiceLabContextRule` | **Contextual, never a global string replace** | `revisionId`, `leftPattern?`, `rightPattern?`, `languageTag?`, `domain?` (business / tech / phone / names), `priority`, `enabled` |
| `VoiceLabLexiconVersion` + `…VersionEntry` | Pinned snapshot a config uses | `version`, `hash`, the list of entry revisions |
| `VoiceLabSpeaker`, `VoiceLabConsentRecord`, `VoiceLabReferenceAudio` | **Future capability** | consent `scope` (evaluation / training / voice creation), `commercialRights`, `signedDocAssetId`, `revokedAt`; **reference audio requires a consent record** |
| `VoiceLabRegressionSuite` / `Case` / `Run` / `Result` | Rerun the same texts on every change | case tags (conversation, telephone, tech, names, numbers, money, addresses, mixing, Hebrew-origin, questions, emotion); run = suite × config version × baseline run |
| `VoiceLabOptimizationProposal` | Suggested improvements | `basis` (the evidence with n per claim), `draftConfigVersionId`, `status` PROPOSED / TESTING / ACCEPTED / DISMISSED, `reviewedById`; **never promotes on its own** |
| `VoiceLabExport` | Export runs | `format` NEUTRAL_JSONL (provider exporters later), `filters`, `includeAudio`, `excludedServingOnly` count, `manifestAssetId` |
| `VoiceLabRetentionPolicy` | How long audio is kept | `retentionClass` → `days` or null (forever) |

## 3. Rules the code must enforce (each gets a guard test)

1. `origin = YIDDISH_LABS` forces `SERVING_ONLY`, at write time and at export time, following the three-layer pattern in `corpus.ts`.
2. Retention deletes **audio files only**. Text, transforms, requests, ratings, corrections and marks are kept forever.
   - GOLDEN, reference audio, and REJECTED with a correction or rejection reason are kept forever.
   - Ordinary generations default to 90 days (configurable).
   - Every deletion is logged.
3. A config version can't change once a sample points at it. Moving to production needs a named human approver.
4. The provider adapter sends only documented parameters. Anything else lives in `internalStyleMeta` and is labelled "not sent".
5. Customer calls, voicemails and chats are never a source. A future call-collection feature is separate, off by default, and consent-gated.
6. Auth is the SUPER_ADMIN JWT, never agent `requireOwner`, which also lets TENANT_ADMIN in.
7. No secret ever lands in `requestParams`, logs or exports.
8. Analytics always print n and refuse to call a winner below a minimum sample size.

## 4. Where it lives (follows existing patterns)

- **api:** `apps/api/src/voice/yiddishVoiceLab/`, next to the ElevenLabs and Polly routes. It rides the deploy queue, not a manual agent rebuild.
  - The OpenAI key comes from `AgentSecret.openai_api_key`, decrypted with `@connect/security`.
  - Yiddish text is fetched through the agent's Yiddish Labs client via the internal-secret route, so the translation cache and credit handling stay in one place.
  - ⛔ Don't use `saveGeneratedPrompt`. It pushes to the PBX and creates tenant rows.
- **Audio:** a new named volume `voice-lab-audio` at `/var/lib/connect/voice-lab`, mounted on api and api_candidate. (Lesson from `docker-compose.app.yml:120-123`: an unset storage directory silently wiped files on every deploy.)
- **Portal:** `/admin/voice-lab`, nav id `admin.voice_lab`, key `can_view_admin_voice_lab`, placed in `OWNER_ONLY_FIXED_NAV_ITEMS`.
  - The nav entry, the shared catalog, and both permission editors' toggles land in the same commit (fourth rule).
- **Audit:** `AgentAuditLog`, which is platform-wide. The api `AuditLog` requires a tenant.

## 5. Phases (proposed)

1. **Collection:**
   - Generate, three-layer view, one-tap and detailed ratings, golden/rejected with reasons.
   - Word corrections, prosody marks, the dictionary with context rules and versions.
   - Style profiles with immutable versions, the training data browser, A/B tests, neutral JSONL export.
2. **Evaluation:** regression suites and runs, analytics with n, the retention job.
3. **Optimizer:** proposals turned into draft configs to test, with human promotion.
4. **Future capability, readiness only:**
   - Provider exporters (ElevenLabs PLS lexicon, Azure, OpenAI custom voice, open-source fine-tune).
   - Consented human reference audio.
   - Any trained voice.
   - None of these may be presented as working until the provider really supports it.

## 6. Open questions for Izzy (block the build, not this design)

1. **Yiddish Labs terms.** Our reading is that evaluation, A/B tests, regression and prompt/instruction tuning on Yiddish Labs text are serving and evaluation uses, not training a model. Fine-tuning or voice-training exports would exclude Yiddish Labs text entirely. **Recommend asking Yiddish Labs in writing before phase 4.**
   - The dictionary itself is built from reviewers' corrections, so it is ours.
2. **Where training-eligible text comes from:**
   - Human-typed Yiddish.
   - Transcripts of consented human recordings from our own non-YL engine plus human correction.
   - A paid native writer.
3. **Is OpenAI the right first provider?** Yiddish isn't a listed language, and the only pronunciation levers are respelling and instructions. The sample test (§7) is the first ear check.

## 7. Sample test

**Ran 2026-09-15 ~22:14Z**, one-off, from inside `app-api-1`.
- Setup:
  - The key came from `AgentSecret.openai_api_key` and was never printed.
  - The temp script was removed and verified absent afterwards.
  - The first attempt hit another session's live api deploy (`7d93d23a`), which replaced the container mid-exec. Nothing was left behind; the run was retried after that deploy finished healthy.
- Texts: two **cached Yiddish Labs outputs** from `AgentTranslation`, so no credits were spent and the model wrote no Yiddish:
  - s1 = "Yes, I understand Yiddish…"
  - s2 = the Malky Berger voicemail (a name, a weekday, and the Hebrew-origin יישר כח).
- Settings: `gpt-4o-mini-tts`, voice `cedar`, mp3. Two variants:
  - "plain": no instructions.
  - "guided": asked to read as a native Hasidic Yiddish speaker, pronouncing Hebrew-origin words the Ashkenazi way.
- Results, all HTTP 200:

  | Sample | Size | Time |
  |---|---|---|
  | s1 plain | 109,824 B | 1,784 ms |
  | s1 guided | 125,568 B | 2,052 ms |
  | s2 plain | 167,424 B | 2,638 ms |
  | s2 guided | 183,168 B | 2,125 ms |

  - Guided audio is about 10–14% longer, so instructions do change the output: slower pace or more pauses. What changed beyond length was not measured.
- Files were sent to Izzy (scratchpad `voice-sample/`) and are **not** stored in the repo.
- ⏳ **Izzy's ear verdict is pending.** Nobody here can judge Hasidic pronunciation, and nothing about quality should be claimed until he listens.
- Cost is negligible (under $0.01 at documented pricing).
