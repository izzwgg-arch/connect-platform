# Loopcom Yiddish Learning Engine (+ Yiddish24 as Source #1): architecture draft (2026-09-15)

**Status: PHASE ZERO. Architecture and mockups only. Nothing built, migrated, crawled, downloaded or deployed.**
Mockups: `docs/mockups/yiddish-learning-engine/learning-engine.html` → https://claude.ai/artifact/K78Se8hWqGUyHL1NAQoudP (18 screens: 10 engine + 8 Yiddish24, every one labelled "MOCKUP — not built"; Voice Lab appears as this section's evaluation module).
Izzy asked for "mockups first, then build"; this file is the architecture half.

- §1 (data inventory, real production counts) and §2 (Yiddish24 live inspection) are **pending**. They are being gathered read-only and get appended here.
- Supersedes and absorbs `AGENT_HANDOFF_YIDDISH_VOICE_LAB_2026-09-15.md`. The Voice Lab becomes the **evaluation module** of this engine, not a separate system. Its tables in §4 of that doc are reused, not duplicated.

## 0. The three governance facts that shape everything (decided before any design)

1. ⛔⛔ **Yiddish Labs output never trains a model.** Source: `docs/ai-support-agent/YL_NO_TRAINING_POLICY.md`, `corpus.ts` `TRAINING_FORBIDDEN_MODELS`.
   - YL text may inform lexical and semantic understanding in serving: dictionary candidates, context and meaning.
   - It is excluded from every training export, and so is anything derived from it alone.
   - The engine records this per record (`trainingUse`), never by convention.
2. ⛔⛔ **Customer voicemails, calls and chats are private tenant data.** The standing rule is: never train on customer voicemails, which are private, unconsented and 8 kHz.
   - The engine may **count** them. Nothing from them enters the corpus as text or audio until Izzy decides the basis:
     - consent,
     - aggregate-only statistics,
     - or opt-in per tenant.
   - Default governance class `CUSTOMER_PRIVATE` = excluded from corpus content, benchmarks, exports and review-queue display.
   - ⏳ Izzy decision required.
3. ⛔ **External audio (Yiddish24) is not automatically licensed for storage or training.**
   - Every derived record carries source provenance and `trainingExportEligibility` = UNKNOWN until the terms are recorded.
   - Storing audio is itself a rights question.
   - Default: store derived features plus time references, and keep media only when rights allow.
   - The pilot needs Izzy's explicit go after the terms findings (§2).

## 1. Data inventory (production, read-only, 2026-09-15 ~22:40Z)

Method: SELECT-only in read-only sessions, `du`/`find` counts. No transcript text was printed.

| Source | Size / count | Audio? | Text? | Provenance | Governance |
|---|---|---|---|---|---|
| `Voicemail` Yiddish transcripts (`transcriptLanguage` yi / yi-en, engine `stt-yi`) | **3,510 rows ≈ 35.8 h**, 23 tenants; Jul 1,100 · Aug 1,637 · Sep (½) 773 | 1,839 rows (21.9 h) with local WAV; the rest only on the shrinking PBX spool | yes | YL-first, ivrit fallback in a bare catch; **provider NOT recoverable per row** | CUSTOMER_PRIVATE; **no-train** (can't prove not YL); no consent field |
| Voicemail audio volume `app_voicemail-audio` | 1.4 GB, 2,470 wav (Aug+) | 8 kHz telephony (INFERRED) | – | – | CUSTOMER_PRIVATE; no retention job deletes it |
| `SupermarketOrderDraft` (1 tenant) | 1,863 drafts; 603 Hebrew-script transcripts of voicemails, 411 with English translation | joins to local voicemail audio | yes | YL sync transcription + YL translate | CUSTOMER_PRIVATE; no-train; **a second, independent transcript of the same audio** (evaluation value) |
| `ConnectCdr.recordingPath` / PBX monitor spool | 74,176 recordings ≈ **1,707 h**, 185 GB, 111,481 wav | yes (PBX, read-only) | **none** | – | CUSTOMER_PRIVATE; no recording-consent field; Yiddish share unknown |
| PBX voicemail spool | 3.3 GB, 10,520 wav | yes | – | – | CUSTOMER_PRIVATE |
| `AgentTranslation` | 434 translate-yiddish (379 pinned UI/template) + 59 translate-english | – | yes | YL | no-train; UI glossary seed |
| Assistant chat `AgentConversation`/`AgentMessage` | 29 `yi` conversations, 151 Hebrew-script messages | 0 | yes | YL bridge | CUSTOMER_PRIVATE; no-train |
| `ConnectChatMessage` | 42 Hebrew-script messages; 82 audio attachments (language unknown) | some | some | human | CUSTOMER_PRIVATE |
| `SupermarketPhraseLesson` | 11 human lessons | – | yes | human | tenant business data; tiny |
| `AgentTranscript` (purpose-built corpus, `CorpusService`) | **1 row** | 0 | 1 | – | schema already has `trainingEligible`, `reviewStatus`, `correctedText`, YL no-train enforcement. **Reuse it, it was just never fed** |
| `AgentDialectTerm` | **0** | – | – | – | glossary empty |
| Archive / news-hotline ingestor (`corpus/archive.ts`) | **0** (`AGENT_ARCHIVE_ROOT` unset) | – | – | – | walker, progress and drain code exist, unused |
| `TenantPbxPrompt` | 146 prompts, 0 Yiddish | – | – | – | not a Yiddish source |
| `AgentAuditLog` | 108,518 rows; 57 voicemails re-transcribed but **old text is not kept** (chars only) | – | – | – | – |
| Voice Lab | design only, 0 tables | – | – | – | – |

**Infrastructure findings:**
- **Search:** Postgres 15 has only `plpgsql`. **pgvector is not available in the image**, so semantic search needs an image change, which is a platform-wide decision. `pg_trgm` and `unaccent` are available but not installed. Universal search is query-time, not an index.
- **Jobs:** reuse the Postgres job-row pattern (`EmailJob`: status, attempts, `nextRunAt`) and/or BullMQ on the existing Redis. The agent's archive drain and progress are keyed in `AgentMemory`.
- **Compute:** 18 vCPU, 94 GiB RAM, 487 GB disk free, **no GPU**. The same box runs production calls, LiveKit, rtpengine and Postgres, so bulk audio analysis and alignment belong **off-box** (a separate worker) and must not run on the call server.
- **Governance gaps:** no voicemail or recording consent flag, no per-tenant training opt-in, no recording retention policy, no per-row STT provider. `Tenant.yiddishEnabled` is true for only 2 of 52 tenants, yet 23 tenants produce Yiddish voicemail.
- **Skew:** one tenant supplies ~68% of Yiddish voicemail and all supermarket data. Learning from internal data alone would learn one business's callers.

**What this means for the design:**
1. Almost all existing Yiddish data is customer-private AND YL-tainted. Usable now without new decisions: counts, aggregate acoustic statistics (only if Izzy allows aggregate use), and YL text for serving-side lexical candidates. **Not usable for training exports.**
2. The engine must record `sttProvider` per transcript from day one, and change `yiddishPass` to stamp the provider (an agent change, manual rebuild).
3. The purpose-built corpus tables (`AgentTranscript`, `AgentDialectTerm`, archive drain) should be extended, not replaced.
4. Clean training-eligible data has to come from new, consented sources: Voice Lab human corrections, consented speakers, and licensed external audio.

## 2. Yiddish24 live inspection (read-only, 2026-09-15, ~30 polite GETs, no media downloaded)

- **Stack:** custom PHP/jQuery (credited to quickwittech.com), behind Cloudflare and AWS ELB, server-rendered pages of about 1 MB. There is no WordPress, no `/wp-json`, no sitemap, and **no RSS or podcast feed** (all 404).
- **Structure:**
  - Main categories `/mainCategory/{id}`: 1 News, 4 Interviews, 19 Analysis, 2 Misc, 3 Health, 5 Business, 8 Video, 7 Music, 6 Torah.
  - About **136 series** at `/cat/{catId}/`. Episode shells `/live/{catId}/{postId}` load through a POST to `/ajax/page.php`.
  - Pagination is 10 per page via POST `/ajax/cat_pagination.php` (undocumented).
- **Metadata on the page:**
  - post id; series name as base64 of URL-encoded Hebrew; title; host as a subtitle.
  - **Hebrew-calendar date only** (the Gregorian date is sometimes recoverable from the MP3 filename timestamp); duration.
  - No description (news clips have one line), no tags, no canonical URL, no JSON-LD, **no transcripts**.
- **Catalog size (estimate):** "Latest updates" has 3,476 pages ≈ **34,760 items**, many of them short news clips. The video podcast section has ≈3,600. Music is ≈8% of series by count. Live Icecast channels (music.y24.app) are separate from the on-demand archive.
- ⛔⛔ **Media access:**
  - Direct MP3s sit on `cloudfront.yiddish24.com` (~92 kbps; 48 MB for 1:09:40). The URL is in plain HTML, with no signature or DRM.
  - **The audio host returns 403 without `Referer: https://www.yiddish24.com/`.** That is a hotlink restriction.
  - **An off-site fetcher sending a forged Referer would be bypassing an access control.** Izzy's own brief forbids that ("do not intentionally bypass access controls or site restrictions"), and it is not done.
- **Rights:**
  - No terms-of-use page exists (all variants 404). The footer reads "Copyright 2026 Yiddish24. All Rights Reserved."
  - The app privacy policy is generic and says nothing about copying or AI.
  - robots.txt carries only Cloudflare's commented content-signal preamble, with no directives and no ai-train signal.
  - Contacts: Info@yiddish24.com (Play listing) and yiddish24@gmail.com (privacy page).
- **Rights verdict:**
  - (a) Automated analysis: UNKNOWN.
  - (b) Storing audio: NOT PERMITTED without permission.
  - (c) Training: UNKNOWN, with no grant anywhere. Treat as not allowed.
- **Adapter approach (ranked):**
  1. **Ask the owner** for written permission plus a feed or export. This is the only route to audio, and it settles rights.
  2. Metadata-only catalog from public HTML listings at a polite rate. No audio, `trainingExportEligibility` = EXCLUDED until a grant exists.
  3. Browser agent: not needed, since the data is already in the HTML.
- **Brittleness:** the Referer check could tighten; POST endpoints are undocumented; base64 series names; Hebrew-only dates; JS-shell episode pages. Adapter parsers need golden-file tests plus site-change alerts.
- **Consequence for the pilot:** the "10–30 episode end-to-end pilot" (Izzy §31) **cannot process audio until Yiddish24 grants permission**. What can run without it is a metadata-catalog pilot: categories, series, durations, speech vs music share by category. ⏳ Izzy decides whether to email Info@yiddish24.com. The email is a draft only; sending it is Izzy's.

### 2b. Draft permission request to Yiddish24 (NOT SENT — Izzy reviews and sends himself)

> **To:** Info@yiddish24.com
> **Subject:** Permission request: using Yiddish24 audio for Yiddish speech research
>
> Hello,
>
> I run Loopcom, a phone-system company serving the heimish community in New York. We are building
> text-to-speech that sounds like real contemporary Yiddish, and your archive is the best example of
> how people actually speak.
>
> We would like to ask permission to:
> 1. Analyze your on-demand audio automatically: speech rhythm, pronunciation and vocabulary.
> 2. Store the audio privately on our servers for that analysis. It is never republished or shared.
> 3. Optionally, use it to train our own Yiddish voice models.
>
> If you are open to it, a feed or export of your episodes (audio link, title, series, date) would
> spare your site any load from us. We are happy to discuss terms, attribution, or a license fee,
> and to follow any limits you set.
>
> Thank you,
> Izzy
> Loopcom LLC

## 3. Layers (provider-independent)

```
Sources (internal tables · Voice Lab · external adapters, e.g. Yiddish24)
  ↓  adapters emit normalized SourceItem records only; no source logic leaks downstream
Loopcom Yiddish Corpus  (references originals; never copies-and-overwrites)
  ↓
Learning Engine  (ingest → segment → analyze → novelty → selective transcription → align → observe → aggregate → propose)
  ↓
Speech Intelligence Layer  (versioned dictionary · context rules · style/prosody profiles)
  ↓
TTS adapter  (OpenAI today · future provider/local)  ⇄  Voice Lab evaluation (benchmarks · A/B · ratings)
```

## 4. Entity model (normalized; originals referenced, never mutated)

| Entity | Role | Key fields |
|---|---|---|
| `YCSource` | A registered source | `kind` INTERNAL_TABLE / VOICE_LAB / EXTERNAL_ADAPTER, `adapterKey`, `governanceClass` PLATFORM / CUSTOMER_PRIVATE / EXTERNAL, `rightsStatus`, `trainingExportEligibility` UNKNOWN / ALLOWED / RESTRICTED / EXCLUDED, `termsUrl`, `termsCheckedAt`, `enabled` |
| `YCSourceItem` | One discovered thing (episode, voicemail row, translation row) | `sourceId`, `externalId` / `originRef` (table + pk, or canonical URL), `metadata` (only what the source provides), `fingerprint`, `duplicateOfId?`, `state` (§7), `priority`, `discoveredAt`, `processingVersion` |
| `YCAudioAsset` | Audio reference | `itemId`, `storage` REFERENCE_ONLY / STORED, `uri`, `sha256?`, `acousticFingerprint`, `durationMs`, `sampleRate`, `channels`, `qualityScore`, `retention` |
| `YCSegment` | A time span of an asset | `assetId`, `startMs`, `endMs`, `class` SPEECH / MUSIC / AD / INTRO / SILENCE / MIXED / UNKNOWN, `classConfidence`, `speakerClusterId?`, `snr`, `speechRate?` |
| `YCTranscript` | Text for a segment or item. **Several may exist per audio; all kept.** | `segmentId?` / `itemId`, `engine` (YL / ivrit / openai / human), `text`, `language`, `confidence`, `isConsensus`, `consensusOf[]`, `originRef` (points at the original row, never a copy that replaces it) |
| `YCTranslation` | Meaning link | `sourceText`, `targetText`, `direction`, `engine`, `originRef` (e.g. `AgentTranslation.id`), `trainingUse` |
| `YCUtterance` | Smallest aligned unit | `segmentId`, `transcriptId`, `startMs`, `endMs`, `tokens[]` with word timings, `alignmentConfidence`, `languageSpans` (yi / he-origin / en) |
| `YCSpeakerCluster` | Anonymous speaker | `label` ("Speaker Cluster 001"), `embeddingRef`, `sourceMetadataName?` (only if the source states it), `itemsCount`, `minutes` |
| `YCLexeme` | Written form (graph node) | `writtenForm`, `normalized`, `origin` YI / HE / EN / NAME / PLACE / BUSINESS / TECH / PHONE / ACRONYM / NUMBER, `frequency`, `relatedIds[]` |
| `YCPronunciationObservation` | **"We heard this."** | `lexemeId`, `utteranceId`, `realization` (IPA or neutral phonetic), `speakerClusterId`, `sourceId`, `context`, `confidence`, `evidenceKind` ACOUSTIC_ALIGNED / HUMAN / TTS_CORRECTION |
| `YCPronunciationRule` | **"We apply this."** Versioned. | `lexemeId`, `realization`, `contextRuleId?`, `status` (§8), `evidenceScore`, `supportSummary` (counts by source / speaker / program / date span), `approvedBy?`, `dictionaryVersionId` |
| `YCProsodyObservation` / `YCStyleObservation` | Rhythm, pause, stress, intonation, mood | `segmentId` / `utteranceId`, `feature`, `value`, `unit`, `confidence` |
| `YCFinding` | Proposed knowledge ("questions rise at the end", "conversational rate 5.8 syl/s vs TTS 4.1") | `kind`, `statement`, `evidence`, `status` PROPOSED / TESTING / ACCEPTED / REJECTED, `affectsProfileVersionId?` |
| `YCReviewItem` | Human queue | `subjectType` / `subjectId`, `reason`, `impactScore`, `resolvesCount` (active learning), `decision` APPROVE / REJECT / EDIT / VARIANT / DEFER, `decidedBy` |
| `YCProcessingJob` | Durable queue | `itemId`, `stage`, `state`, `attempts`, `nextRunAt`, `leaseUntil`, `costCents`, `error`, `version` |
| `YCBudget` | Daily/hourly limits | `scope` (global / source), `apiCentsPerDay`, `transcriptionMinutesPerDay`, `storageBytesMax`, `concurrency`, `mode` AUDIO_ONLY / SELECTIVE / FULL, `paused` |
| `YCMetricSnapshot` | Progress over time | `date`, `metric`, `value`, `sourceId?` |
| Voice Lab tables | Evaluation (generation, ratings, A/B, regression, config versions) | as designed in the Voice Lab handoff; `YCPronunciationRule` feeds `VoiceLabLexiconEntry` revisions via a promotion, never directly |

## 5. Evidence and confidence model (observations → rules)

- Score a candidate realization from **independent** support, not raw counts:
  - distinct speaker clusters (strongest);
  - distinct recordings / programs;
  - date span;
  - distinct sources (internal + YL lexical + Yiddish24 agreement is weighted highest);
  - alignment and transcription confidence of each observation;
  - human confirmations, which dominate.
- Repeats from one speaker saturate quickly, so one person's habit can't become "the accent".
- Conflicting realizations are tracked as **variants with shares**. A single global spelling is never forced.
- Proposed form: a Beta-style posterior per variant, weighted by independence. The exact thresholds get calibrated after the pilot on real data, **never hardcoded up front**.
- Separate scores per source class, so any source can be excluded later without recomputing everything else ("internal only", "Yiddish24 only", "both").
- **An observation is never a rule.** A rule needs its score above a threshold AND human approval when it is high-impact (frequent word, name, business term, or anything changing a production profile).

## 6. Pipeline stages (incremental and resumable; state per item and version)

```
discover → fingerprint/dedupe → queue → fetch-or-reference audio → segment (VAD/music/silence)
→ acoustic features (rate, pauses, pitch/energy contours) → speaker clustering → novelty score
→ [selective] transcription (reuse existing transcripts first; YL/ivrit only when value > cost)
→ alignment (confidence-scored; ambiguous = flagged, not forced) → observations
→ incremental aggregation (counters/sketches, no full recompute) → findings/rule proposals → review queue
```

- **Existing data first:** internal translations, transcripts, Voice Lab ratings and corrections are indexed before any external crawl. An already-transcribed item is never re-sent to YL.
- **Selective transcription priority:**
  - repeated phrase candidates;
  - novel acoustic or lexical patterns;
  - conflicts with current knowledge;
  - clear audio;
  - underrepresented speaker or style;
  - material the current TTS fails on;
  - benchmark candidates.
  - All within the daily budget.
- **Local-first analysis** for segmentation, VAD, fingerprints, dedupe, features and clustering. Paid APIs only where they add value. Feasibility depends on server compute (§1).

## 7. Queue states

- Item: DISCOVERED → QUEUED → PROCESSING → AUDIO_ANALYZED → NEEDS_TRANSCRIPTION → TRANSCRIBED → ALIGNED → INDEXED → LEARNED.
- Side states: NEEDS_REVIEW, FAILED (with retry/backoff), SKIPPED, DUPLICATE.
- Source-level (Yiddish24): DISCOVERED / QUEUED / ANALYZED / PARTIAL / FULL / SKIPPED / DUPLICATE / FAILED / NEEDS_RETRY.
- Jobs use DB-row leases, not in-memory loops, so they survive restarts. Reuse the platform's existing job pattern (§1).

## 8. Promotion (no uncontrolled self-modification)

- Rules, dictionaries, profiles and evaluation sets move through CANDIDATE → TESTING → APPROVED → PRODUCTION → RETIRED.
- Moving to PRODUCTION requires: a benchmark run against the baseline, A/B evidence, and a named human approver.
- Learning algorithms themselves are versioned (`processingVersion`), so historical results stay reproducible.

## 9. Quality tiers (calibrate after the inventory)

| Tier | Contents |
|---|---|
| A | Human-verified audio + transcript + translation, clean recording, rights OK |
| B | Audio + reliable transcript (consensus or high confidence) |
| C | Text + translation (e.g. YL pairs; serving-only) |
| D | Raw audio, features only |
| E | Unverified / ambiguous / low quality |

Junk (music-dominant, noisy, corrupt, unintelligible, duplicate, known synthetic) is down-ranked or rejected.

## 10. Progress metrics (no fabricated "accuracy")

- Corpus hours by tier and source.
- Transcript/translation/pair counts.
- Speaker clusters.
- Unique lexemes, and high-confidence rules vs open conflicts.
- Novelty rate and redundancy (diminishing-returns curve per source and per hour processed).
- Benchmark ratings vs Baseline v1.
- A/B win rate.
- Correction rate.
- Alignment and transcription confidence distributions.
- Cost per new high-confidence rule.

## 11. Screens to mock up (phase zero)

**Engine screens:**
1. Learning Dashboard.
2. Corpus Explorer.
3. Word/Phrase Detail (knowledge graph, variants, audio occurrences, rules).
4. Audio/Transcript Alignment Viewer.
5. Review Queue (active learning).
6. Voice Benchmark (Baseline v1 vs candidate).
7. Learning Progress Analytics (1 h / 10 h / 24 h / week / month, diminishing returns).
8. External Source Manager.
9. Training Dataset Export (governance-filtered).
10. Governance & Budgets (sources, rights, customer-data wall, spend caps).

**Yiddish24 screens, inside the same shell:**

11. Source Dashboard.
12. Episode Browser.
13. Episode Learning Detail (timeline with speech/music/speaker regions).
14. Processing Queue.
15. Category Priorities.
16. Continuous Learning Controls.
17. Discoveries.
18. Progress Over Time.

## 12. Open decisions for Izzy (block the build, not the mockups)

1. Customer voicemail and call transcripts: excluded / aggregate-only statistics / per-tenant opt-in with consent?
2. Yiddish24: after the terms findings, approve a 10–30 episode pilot? Storing audio vs features-only? Ask the site owner for permission to train?
3. Yiddish Labs: confirm serving-only use in the engine (lexical candidates, meaning) and exclusion from training exports.
4. Compute: local analysis on the Connect server vs a separate worker box (depends on §1 numbers).
