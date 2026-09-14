# ⛔⛔ AGENT HANDOFF — the voice changer: a recording comes back in a different voice, and the audio NEVER becomes text (2026-08-18) — READ FIRST before touching `apps/api/src/voice/elevenLabs*`, before adding any speech feature for Yiddish, or before "improving" this with speech recognition

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`58be00f7` + `95f9e9d4` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED
and container-verified at `95f9e9d4`. ⏳ No clip has ever been converted — nobody
has pressed the button.** No migration, no PBX write, no env change, no
permission-snapshot change.) Memory: [[voice-changer-is-built-and-gated]],
[[no-voice-provider-speaks-yiddish]].

- ⛔⛔ **THE RULE THIS EXISTS TO PROTECT: nothing in this path may ever
  transcribe or translate.** ElevenLabs' "speech to speech" is audio in, audio
  out — it re-voices the sounds and never learns what was said. **That is the
  only reason it works on Yiddish**, because no provider on earth can transcribe
  or speak Yiddish (proven live: ElevenLabs' 74-language `eleven_v3` has `he` and
  no `yi`; the two conversion models list neither; **Polly has 109 voices across
  41 languages and neither Hebrew nor Yiddish**). A future "improvement" that
  routes this through speech recognition + text-to-speech would read as a quality
  upgrade in a diff and would **silently break every language this platform
  actually serves.** A guard test reads the SOURCE of both files, **comments
  stripped**, and fails on `speech-to-text` / `whisper` / `transcri*` /
  `translat*`. ⛔ Strip the comments — the doc blocks say "nothing here
  transcribes", so a naive substring match fails on correct code.
- ✅ **What exists.** `convertSpeech()` beside `synthesiseSpeech()` in
  `voice/elevenLabs.ts`; `POST /voice/ivr/prompts/convert` (multipart) and
  `GET /voice/elevenlabs/voice-changer/status` in `voice/elevenLabsRoutes.ts`.
  Same key, same 8 kHz-first ladder, same error classification, same
  `pcmToWav` → store → catalog → push-to-PBX tail as text-to-speech — a converted
  greeting and a generated one are the same thing by the time Asterisk sees them.
  Models: `eleven_multilingual_sts_v2` (default, 29 languages) and
  `eleven_english_sts_v2`. ⛔ **No model does both jobs** — a TTS model id is
  refused here and vice versa; read `can_do_voice_conversion` on `/v1/models`,
  never the model's name.
- ⛔⛔ **BILLED PER MINUTE OF AUDIO, NOT PER CHARACTER — `MAX_TTS_CHARS` has no
  equivalent and file size is not a proxy** (a 5-minute MP3 is smaller than a
  30-second WAV). The cost guard is **ffprobe reading the duration BEFORE the
  provider is called** (`MAX_CONVERT_SECONDS` 180, deliberately under
  ElevenLabs' own 5 min so the refusal is ours and in plain English), and ⛔ **a
  file whose length cannot be read is REFUSED, not forwarded on trust** — that
  would be billing blind. Its own rate limit (6/min) and concurrency gate (2),
  separate from the synthesis ones. A test pins that the probe precedes the call.
- ⛔ **`can_use_voice_changer` is in NEITHER default bucket, not even
  TENANT_ADMIN** — the `can_use_amazon_polly` pattern exactly, granted one custom
  role at a time. **SUPER_ADMIN gets it via the all-keys bucket, so NO snapshot
  migration.** Every route needs BOTH gates: `can_manage_ivr_prompts` says a
  person may make recordings at all, this says they may make them THIS way.
  ⛔ **`hasVoiceChangerPermission` is an authoritative key check with no role
  fallback** — a tenant admin does not get it for being a tenant admin.
- ⛔ **Someone without it must see NOTHING** (Izzy, 2026-08-18: *"if somebody
  doesn't have permission, they don't see that option at all"*). The status route
  answers **200 `allowed: false`, never 403** — the Studio asks on every open, and
  a console full of 403s for the ordinary case buries real failures. A visible
  control that refuses on click reads as a broken product, not as a permission.
- ⛔ **Two provider traps, both guarded:** never set `Content-Type` on the
  FormData (fetch generates the multipart boundary and puts it in that header;
  overriding it yields a generic 400 that reads like a bad request), and
  **`voice_settings` goes as ONE JSON string**, not separate form fields — as
  fields it is silently ignored and every tuning dial does nothing.
- **Tone is adjustable, rhythm is not.** `stability` / `similarity_boost` /
  `style` change expressiveness and how hard the target voice's character shows.
  There is **no speed or rhythm control on this endpoint** and none is exposed —
  the pacing comes from the customer's own performance, which is the feature.
  ⚠️ ElevenLabs' general voice settings carry a `speed`; whether it is honoured
  here is **unverified**, and Polly's generative engine has already burned us by
  accepting a speed setting and silently discarding it. Test it by comparing
  output bytes before exposing it.
- ⛔ **Committed with a PRIVATE INDEX** — `server.ts` carried three hunks from
  another live session and the real index held their staged deletions, so a
  pathspec commit would have swept both in. `git show HEAD:…server.ts` → apply
  only my two hunks → `hash-object` → `GIT_INDEX_FILE` + `read-tree HEAD` +
  `update-index` + `write-tree` + `commit-tree`. Verified `git diff --stat HEAD
  $TREE` showed **8 files and server.ts +7 lines** before committing.
- ✅ **THE SCREEN: `ivr-studio/ConvertRecording.tsx`**, opened by a **"Change my
  voice"** button in the key editor. Record from the microphone or choose a file,
  pick the target voice, and one action converts, saves and pushes to the PBX.
  ⛔ **A SEPARATE DIALOG FROM `MakeRecording.tsx` ON PURPOSE** — that one is built
  around TYPING (templates, character counter, monthly allowance, a preview you
  can re-roll for free) and this takes a FILE; folding them together would branch
  nearly every field in an 850-line component and put the working greeting flow at
  risk. They share one `onRecordingCreated` handler, so where a new row lands
  (library / key / menu greeting) never depends on which dialog made it, and the
  now-exported `MakeRecordingStyles` rather than a second copy of the CSS.
  ⛔ **No free preview** — converting is what costs money, so preview-then-save
  would bill twice; the result is played back from the saved row instead, so what
  they hear is exactly what the phone system now has.
- ⛔ **The button is rendered ONLY when the status route said `allowed: true`.**
  The page asks once on load; a 404 (older api) or any error is read as **no
  option**, never as a button that fails when pressed. `onConvertRecording` is
  `undefined` for everyone else, so `KeyEditor` draws nothing at all.
- ⛔⛔ **`MediaRecorder` WITH NO `mimeType` PRODUCES A DEAD GREY PLAYER — first
  bug Izzy hit, within minutes.** The default is WebM, whose blobs carry **no
  duration in the header**, so the browser reports the clip as infinitely long
  and draws unpressable controls. It reads exactly as *"it doesn't record
  anything"*. ⛔ **`ChatComposer.tsx` in this repo already solved this** by
  preferring **`audio/mp4`** (real duration, and on ElevenLabs' accepted list) —
  I wrote a second recorder instead of grepping for the existing one. **Check
  for a proven implementation before writing a new one.** Fixed alongside, all
  presenting as the same symptom: an empty recording used to set a preview and
  enable Convert (surfacing only as a provider error *after* a charge),
  `onerror` was unhandled, and `stop()` on an already-inactive recorder throws
  and leaves the button stuck on "Stop". The captured size is now stated as
  TEXT, so "did that work?" has an answer even when the player cannot draw.
- ⛔⛔⛔ **THE ACTUAL ROOT CAUSE OF EVERY "it does nothing" SYMPTOM WAS THE CSP:
  `blob:` IS NOT COVERED BY `'self'`, AND THE PORTAL HAD NO `media-src` AT ALL.**
  Media therefore fell back to `default-src 'self'`, so **every**
  `URL.createObjectURL` audio source on the whole portal was blocked by the
  browser — the voice samples, the voice changer's recording preview, its
  converted-result playback, and (pre-existing) `MakeRecording`'s own preview.
  Proven in a real browser at the real origin 2026-08-19: a **hand-built valid
  8 kHz WAV blob** failed at `readyState 0`, `MediaError code 4`, `play()` →
  `NotSupportedError`. ✅ Fixed by adding **`media-src 'self' blob: data:`** to
  `/etc/nginx/connectcomms/security-headers.conf` (⛔ that file is `include`d by
  BOTH vhosts, so one edit covers `app.connectcomunications.com` and
  `app.loopcom.net`; backup
  `/root/security-headers-backup-20260819-020058-mediasrc.conf`, `nginx -t` then
  reload). After the reload the same clip reports **`duration 3.85s`,
  `paused false`, playhead +1.43 s in 1.5 s of wall clock** — audio genuinely
  playing, measured, not inferred.
  ⛔ **The two fixes before this one — the WebM container and the `text/plain`
  header — were real defects but were NOT what the customer was hitting.** Both
  were diagnosed from reading code, both were reported as "fixed", and both were
  wrong about the cause. **Open a browser and measure before claiming a media
  bug is fixed.**
  ⛔ **The subtle trap: I already knew the CSP blocks EXTERNAL media — the sample
  route is proxied for exactly that reason — and still missed that a blob we
  create ourselves is equally not `'self'`.**
  ⛔ **A CSP reload race will lie to you:** the `curl` immediately after
  `systemctl reload nginx` still returned the OLD header; the second one, seconds
  later, was correct. Re-check before concluding the edit did not take.
- ⛔⛔ **AND THE PROVIDER'S CONTENT-TYPE MUST NOT BE TRUSTED — ElevenLabs' CDN
  serves those samples as `text/plain`.** Proven live: 200, **31,364 bytes, ID3
  magic — an MP3 labelled as text**. Forwarding that header verbatim hands the
  browser audio bytes marked as text and `<audio>` silently declines to decode
  them, with no error and no failed request anywhere. Anything not `audio/*` is
  forced to `audio/mpeg`, and the client builds its blob with an explicit audio
  type as well, so neither side alone can reintroduce it. A test pins both.
  ⛔ **THE PATTERN WORTH CARRYING: all three of this feature's bugs presented as
  "the button does nothing" — a WebM blob with no duration, a CSP-blocked src,
  and a mislabelled MIME type. When a media control does nothing, suspect the
  CONTAINER, the CSP and the CONTENT-TYPE before reading any logic.** And probe
  the route with a real token before theorising: one curl showed the bytes were
  already correct and the header was not.
- ⛔⛔ **VOICE SAMPLES MUST BE PROXIED, NEVER LINKED — the portal's CSP is
  `default-src 'self'`.** An `<audio>` pointed at ElevenLabs' CDN is blocked by
  the browser as a **silent console violation**: the play button simply does
  nothing, with no network error to find. `GET
  /voice/elevenlabs/voices/:voiceId/sample` serves the provider's own hosted
  clip from our origin. ⛔ **Auditioning is FREE** — it is a static file, not a
  synthesis — and a test fails if anyone ever routes it through
  `synthesiseSpeech`, which would bill for every one of the 38 voices a customer
  tries. ⛔ Buffered and **returned**, never an un-returned stream send.
- ⏳ **NOT PROVEN: no clip has ever been converted and nobody has pressed the
  button.** Proven as 13 api + 5 shared tests, both registered, **every source
  guard reading 0 against `HEAD`**; api typecheck **75 = the exact baseline**,
  none in an edited file; voice suite 124/124, shared 360/360; portal typecheck
  **0** and 179/181 (the two documented pre-existing failures); and both
  containers grepped after deploy. **The acceptance test is one Yiddish
  recording.** ⛔ An already-open Studio tab or desktop window keeps the OLD
  bundle until it is reloaded.
- ⏳ **Open:** ⛔ `docs/ai-context/TESTS_RUN.md` was **not** updated — another
  session has it staged with large changes and fighting over it would risk their
  work. ⚠️ Whether ElevenLabs honours a `speed` in `voice_settings` here is still
  unverified; Polly's generative engine already burned us by accepting one and
  discarding it, so compare output bytes before exposing any such control.
