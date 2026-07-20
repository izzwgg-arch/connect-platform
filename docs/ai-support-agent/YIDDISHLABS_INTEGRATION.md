# Yiddish Labs Integration — auto-detect + transcribe + converse (DESIGN, pre-build)

_2026-07-20. Owner: Izzy. Provider: **Yiddish Labs** (app.yiddishlabs.com) — advanced Yiddish↔English
transcription + text processing. This is the design + mockups; nothing is built until you approve._

## What you asked for

1. **Auto language detection** — the system detects whether the caller/recording is **Yiddish or English**
   (also Hebrew / loshn-koydesh) and handles it correctly, with no manual setting.
2. **Call-recording transcription** — every recording transcribed accurately in the right language.
3. **Live back-and-forth in Yiddish** — the agent converses with clients in full Yiddish (or English),
   matching whatever language they speak.

## The API we're integrating (from their live docs)

**Auth:** `X-API-KEY: yl_live_...` header. **Base:** `https://app.yiddishlabs.com/api/v1`.

**Transcription**
- `POST /transcriptions` — async job (any length). Returns `{id, status:"queued"}`; result via **webhook** or polling.
- `POST /transcriptions/sync` — **waits** for the result when audio ≤ 5 min (perfect for short calls); longer → async.
- `GET /transcriptions/:id` — poll status/result.
- Form fields: `file` (mp3/wav/m4a/ogg/flac), `name`, **`context`** (bias terms — we feed our dialect glossary here!),
  `webhook_url`, `language` (**`auto`** | yi | en | he | lk), `rapid` (fast mode), `timestamps`.
- Completed payload: `text`, **`summary`**, **`keywords`**, `word_count`, `duration_seconds`, `credits_cost`.
- **Webhook** `transcription.completed` posts the full result to a URL we host.

**Text Processing API** — translation (Yiddish↔English) + text ops, used to bridge Yiddish speech to the
English-reasoning LLM and back (details bound at build time).

**Language codes:** `auto` (detect), `yi` (Yiddish), `en` (English), `he` (Hebrew), `lk` (loshn-koydesh).
`auto` is the key — it does the Yiddish-vs-English detection you want, natively.

**Billing:** credit-based, per audio-second (`credits_cost` = duration). Concurrency limited by plan.

## How it plugs into what's already built

The agent already has a `Transcriber` interface, a `CorpusService`, and a bilingual conversation engine.
Yiddish Labs becomes the **Yiddish/auto STT provider** behind that same interface — no downstream rewiring.

### A) Call-recording transcription (auto-detect)
```
new call recording ──► YiddishLabs POST /transcriptions (language=auto, context=glossary, webhook_url=ours)
                                   │
                        webhook: transcription.completed
                                   ▼
        detect language from result ──► CorpusService.capture(source="live_call",
                                          language=yi|en|yi-en, text, summary, keywords, confidence)
                                   │
                          feeds the tuning flywheel + searchable transcripts
```
- Short calls (≤5 min) can use `/sync` for an instant result; longer calls use async + webhook (no polling load).
- The **`context`** field is fed our dialect glossary so heimishe terms transcribe right from day one.
- Language comes back detected; we tag `yi` / `en` / `yi-en` (code-switch) and store summary + keywords too.

### B) Live conversation — auto-detect + respond in-language
```
caller speaks ──► STT (auto) ──► detect yi/en ──► if yi: translate→EN (Text Processing) ──► LLM reasons
                                                                                              │
 caller hears  ◄── TTS (voice) ◄── if caller=yi: translate EN→YI (Text Processing) ◄── LLM reply (EN)
```
- The agent **always replies in the caller's language.** Yiddish in → Yiddish out; English in → English out;
  mixed → mixed, matching them.
- Two build options for the "understand + generate Yiddish" step, evaluated at build:
  1. **Translate-bridge** (ship first): Yiddish Labs translates YI→EN for the LLM, and EN→YI for the reply.
     Reliable, uses the provider's strength, works now.
  2. **Native Yiddish LLM** (later): Claude/GPT handle Yiddish directly where quality is proven, skipping
     translation for lower latency. We A/B them.
- For **live phone** (Phase 6) this rides the realtime voice loop; for **chat/voice-note** it works now.

### C) The flywheel connection
Every Yiddish Labs transcript (calls + the archive + hotline) flows into the corpus we already built, so
this simultaneously (1) powers real-time understanding and (2) accumulates the corpus for our own tuning.

## Security & cost controls (built in)

- **Key handling:** `YIDDISHLABS_API_KEY` lives ONLY in the server env (you place it). Never in code/logs.
  **Rotate the key you pasted in chat** — treat it as exposed.
- **Webhook verification:** we host `/agent/webhooks/yiddishlabs`, verify it's really them (shared secret /
  signature / IP allowlist, same pattern as the existing PBX webhook), before trusting a payload.
- **Cost guard:** credit-based billing → we add a per-day credit cap + the existing rate limiter so a flood
  of long calls can't run up a surprise bill. Rapid mode for cost/speed where accuracy allows.
- **Consent:** transcripts stay tenant-isolated; `trainingEligible` gated as today.

## What Izzy provides

- The (rotated) Yiddish Labs API key → into server env.
- A public webhook URL allowlisted (we host the endpoint; nginx routes it like the PBX webhook).
- Confirmation of the translate-bridge vs native-LLM preference for v1 (recommendation: translate-bridge first).

## Mockups

See `YIDDISHLABS_MOCKUPS.html` — five screens: auto-detected call transcription, live Yiddish conversation,
the translate bridge, admin config (key/credits/rapid), and the transcription queue feeding the flywheel.
