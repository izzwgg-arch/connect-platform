# AGENT HANDOFF — chat voice notes: playback cut off, and the audio was ruined by our own denoiser (2026-08-16)

**Commits:** `e2b4699b` (playback) + `f0911881` (audio quality), merge `eae7a0e8`,
on `feat/ivr-migration-takeover`.
**Deployed and container-verified:** portal (both) + api (audio chain).
**Trigger:** Izzy sent a DM voice note from the SUPER_ADMIN account to Trust
Bookkeeping 101 (`vigdor@trustbookkeepingny.com`), and reported two separate
things — *"I started replaying it, and it stopped after a few seconds"*, then
*"very, very unclear … sounds like I'm far, far away on the water, I'm like in
a dungeon."* They are two independent bugs with two independent causes.

The note itself: message `cmsrlrs840tzjqz134qlqxmrg`, attachment
`voice-note-1786630652620.m4a`, 800,874 bytes, 63.9 s, thread
`cmsrlpwzj0tj2qz1315cmgigx`.

---

## 0. ⛔ Read this before you trust any timestamp in this document

**The server clock was ~3 days behind during this session and was corrected to
the true time (2026-08-16) partway through.** Everything stamped while it was
wrong reads **2026-08-13**, including this voice note's `createdAt`
(`2026-08-13T14:17:50.500Z`) — a message Izzy had sent minutes before asking
about it — plus the nginx access-log lines for its playback, the deploy-queue
job rows created early in the session, and `docker inspect .State.StartedAt`
for containers started then.

Proven, not inferred: a Prisma error early in the session echoed the container's
own `new Date()` as `2026-08-12T14:20:51Z` (a 24h window), and a deploy job
created in-session carries `created_at` epoch `1786632839354` = Aug 13 13:33 UTC,
while the host later reported epoch `1786903514` = Aug 16 18:05 UTC. Same box,
~270,675 s (3.13 days) apart.

`chronyc tracking` afterwards is healthy — system time **68 microseconds** fast
of NTP, RMS offset 0.145 ms, source `free.saclay.org`, and `NTPSynchronized=yes`.
So the clock is right **now**.

**⛔ It was NOT chrony that fixed it, and this can happen again.** Checked
afterwards, and every guest-side explanation is ruled out:

- **No reboot** — `uptime -s` is 2026-04-26, up 16 weeks straight.
- **The journal is PERSISTENT** (`/var/log/journal` exists, history reaches back
  to 2026-02-26) and contains **no time-change record at all**.
- **chrony never stepped it** — no `chrony` unit messages that day, no restart,
  and `/var/log/chrony/` is empty.
- **chrony structurally could not have** — `/etc/chrony/chrony.conf` sets
  **`makestep 1 3`**, i.e. it may step the clock only during its **first 3
  updates after starting**; after that it only *slews*, and slewing cannot close
  a 3-day gap in any practical time.

The stored evidence is not a misreading: the deploy-queue rows for this session's
jobs still read `created_at` **1786632839354** and **1786640619474** (Aug 13
13:33 and 15:43 UTC) — two hours apart, matching the real gap between those two
deploys — while every job created afterwards by other sessions reads
**1786891477+** (Aug 16). The clock tracked elapsed time correctly the whole
time; it was simply offset by ~3 days and then jumped forward.

A guest clock that steps with **no reboot, no chrony action and no journal entry**
points at a **hypervisor-side correction** (VPS live-migration / resume, kvm-clock)
— invisible from inside the VM. ⛔ **So the guest cannot prevent or log a repeat,
and `makestep 1 3` means chrony will not rescue it either.** If timestamps look
wrong again, check `date` against a known-good source first and do not waste time
in the journal — it will be silent.

⛔ **NOT INVESTIGATED, and it is Izzy's call:** how long the skew lasted, and what
carries wrong timestamps because of it. Anything time-derived in that window is
suspect — invoice/billing dating, `DidSwitchSchedule` firing, port watchdog
spacing, rate-limit and login-throttle windows, signed-URL `exp`, CDR times,
audit rows. Signed URLs minted before the jump expired instantly at the step
(harmless — clients refetch). **Do not "correct" any stored timestamp without
his word.**

⛔ **The lesson: `date` on the box is not a fact you can assume.** When a stored
timestamp disagrees with what a human just told you they did, check the clock
before rewriting your theory of the bug — a wrong clock will make you doubt the
user and hunt an imaginary defect.

---

## 1. Bug one — the voice note stopped a few seconds in

### What was wrong

Chat polls `GET /chat/threads/:threadId/messages` **every 7 seconds**
(`MiniChat.tsx` and `app/(platform)/chat/page.tsx` both do), and the route mints
a **fresh HMAC-signed `downloadUrl` for every attachment on every fetch**
(`connectChatRoutes.ts` — `buildChatSignedDownloadUrl(base, a.storageKey, 900)`,
new `exp` and `sig` each time). Both surfaces fed that string straight into
`<audio src>`.

A changed `src` is, to the browser, a **different file**: it aborts playback and
reloads. So playback died on the first poll after pressing play, every time.
Images were re-downloading and flashing for the same reason.

### The proof

- The stored file is **fine** — `ffprobe` reads 63.9 s and a full decode of the
  m4a completes with no errors. Nothing was wrong with the recording or storage.
- nginx logged that one file downloaded **13 times in ~90 seconds** from a single
  browser, each request carrying a different `exp`/`sig`. That is the poll, not
  the user.

### The fix

`stabilizeAttachmentUrl` / `stabilizeMessageAttachmentUrls` in
`apps/portal/components/chat/chatPresentation.ts`: pin the first URL seen per
attachment id and keep returning it until within **120 s of expiry** (so it can
never go stale mid-use), keeping the `src` byte-identical across polls. Bounded
cache (500 entries, FIFO) because a desktop chat window stays open for days; the
original array is returned unchanged when nothing changed, so React identities
stay stable and nothing re-mounts.

Applied at **both** message-fetch sites. `VoiceNotePlayer` in
`AttachmentPreview.tsx` additionally refuses to adopt a new URL while audio is
actually playing.

- ⛔ **The mobile app already had this fix** (`stabilizeAttachmentUrl` in
  `apps/mobile/src/screens/tabs/ChatTab.tsx`) — that is why phones played these
  fine and only the web/desktop side was broken. **Keep the two in step.**
- ⛔ **Apply the pin at EVERY new message-fetch site.** The defect was a
  **caller**, not the helper, so a helper-only unit test passes straight through
  it — `messagePresentation.test.ts` therefore reads BOTH surfaces' **source**
  and fails if either drops the call.
- ⛔ **Verify a portal deploy of this by grepping the built bundle for the regex
  literal `(?:exp|e)=`.** Minification strips comments and renames consts, so
  grepping for `stabilizeMessageAttachmentUrls` or `STABLE_URL_RENEW_WITHIN_SECONDS`
  returns **0** and reads exactly like a failed deploy. Verified present in
  `.next/server/chunks` and `.next/static/chunks`, and in the chunk served over
  public HTTPS.

---

## 2. Bug two — "far, far away on the water … in a dungeon"

### What was wrong: one number

`apps/api/src/chatVoiceNoteDenoise.ts` runs an ffmpeg chain over **every voice
note at upload time**, and the *stored original is replaced* by the processed
copy (so in-app playback, the sender's own playback and the MMS copy all get it).

The chain passed **`afftdn=nr=10:nf=-25`**.

`nf` is the **noise floor** — "everything below this level is noise, remove it".
Confirmed from the binary itself:

```
noise_floor <float>  set the noise floor (from -80 to -20) (default -50)
```

So **-25 is nearly the most destructive value the filter accepts**, against a
default of -50. Ordinary speech averages about **-20 dB**. The denoiser was being
told to treat the voice itself as noise, and it stripped the body and tails off
every word. That is precisely the hollow, watery, underwater sound.

### The measurements (from the real note, not a guess)

| Measure | Value | Why it matters |
|---|---|---|
| Integrated loudness | **-18.4 LUFS** | undershot the chain's own -16 target — quiet |
| Loudness range (LRA) | **11.0 LU** | huge for speech; soft syllables sit ~11 dB back = "distance" |
| LRA low | **-27.2 LUFS** | quiet passages are very quiet |
| mean / max volume | -20.1 dB / -1.3 dB | ~19 dB crest — nothing is compressing it |
| Sample rate | **96 kHz** | pointless for mono speech; an odd decode path |

The 96 kHz happened because the encode never pinned `-ar`, so the output simply
inherited whatever the browser captured at.

### The fix

Chain is now exported as `VOICE_NOTE_FILTER_CHAIN` (so it is assertable — the
destructive setting was one number buried in an arg array), in order, clean →
shape → level:

```
highpass=f=90                                          rumble / handling noise
afftdn=nr=12:nf=-50                                    hiss removal at the SAFE default floor
equalizer=f=300:t=q:w=1.0:g=-2                         removes boxy "mud"
equalizer=f=2600:t=q:w=1.2:g=3                         presence — what makes speech intelligible
acompressor=threshold=-20dB:ratio=3:attack=10:release=180:makeup=2
                                                       lifts quiet syllables so they stop sounding distant
loudnorm=I=-16:TP=-1.5:LRA=7                           consistent level, tighter than the old LRA=11
```

plus **`-ar 48000`** pinned, still `aac` / `96k` / mono.

**Validated in the api container against a synthetic quiet-speech-plus-hiss
probe** before shipping (a filter typo would make `denoiseVoiceNote` return
`null`, silently disabling processing altogether): both chains ran, and the new
one cut the crest factor **8.1 dB → 5.3 dB** — that is the compression pulling
soft speech forward.

### Capture side

`ChatComposer.tsx` recorded with a bare **`getUserMedia({ audio: true })`** — no
constraints at all, leaving automatic gain, noise suppression and echo
cancellation to whatever Chrome or the Electron shell defaulted to. Now requested
explicitly (`echoCancellation`, `noiseSuppression`, **`autoGainControl`** — the
one that makes a voice sound close rather than across the room), plus
`channelCount: 1` / `sampleRate: 48000` hints matching the server encode. Both
are hints; a browser that ignores them still records fine.

### ⛔ What this does NOT do

- **It cannot repair existing voice notes.** The upload path replaces the
  original with the processed copy, so the raw audio of anything already sent is
  **gone**. Only new notes benefit.
- **Mobile capture settings are untouched** — those need an app build, which is
  Izzy's call. The server-side half improves phone-recorded notes anyway, since
  the chain runs on upload regardless of client.

---

## 3. Guards added

- `apps/api/src/chatVoiceNoteDenoise.test.ts` (5 cases) asserts the **audible
  properties**, not the literal string: `nf` can never again rise above ffmpeg's
  -50 default (and must stay inside -80..-20), compression must be present, a
  2–4 kHz presence lift with positive gain must be present, `LRA` stays ≤ 8, and
  `-ar` stays pinned. Run with
  `node --experimental-test-module-mocks --import tsx --test src/chatVoiceNoteDenoise.test.ts`.
- `apps/portal/components/chat/messagePresentation.test.ts` gained the URL-pinning
  cases **and** the both-surfaces source assertion.
- ⛔ **That portal test file existed for months and had NEVER RUN** — the portal
  `test` script names each file explicitly and it was not in the list. It had
  drifted red (it still expected the SMS inbox badge text from before `f4fae3f4`
  deliberately shortened it to "Shared"/"Personal"). Registered in
  `apps/portal/package.json` and the stale assertion corrected. **A new portal
  test does nothing until you add it to that list.**

---

## 4. Verification state

**Proven:**
- Portal typecheck clean; `apps/api` typecheck adds **zero** errors (92
  pre-existing in that package, none in the changed files).
- New chain present in the running `app-api-1`: `afftdn=nr=12:nf=-50`,
  `equalizer=f=2600…`, `acompressor…`, `loudnorm…LRA=7`, `-ar 48000`.
  ⛔ A grep for `nf=-25` still returns **1 hit — line 13, inside the explanatory
  comment**, not the live chain. Check the line, not the count.
- `autoGainControl` present in the running `app-portal-1` client bundle.
- URL-pinning regex present in the portal bundle served over public HTTPS.

**⏳ NOT PROVEN — the acceptance test:**
1. **Restart the desktop app** (an open window keeps the old bundle; browser tabs
   just need a reload) so the new capture constraints are actually in use.
2. Record a **fresh** voice note and play it back — it should neither cut out nor
   sound distant.
3. Confirm the stored file: `ffprobe` should report **48000** Hz, and
   `ffmpeg -af ebur128` should read about **-16 LUFS with LRA ≈ 7** (the bad one
   read -18.4 / 11.0).

Nobody has yet recorded or listened to a note on the new build. Two renders of
the original note (as-stored vs. a repair pass) were sent to Izzy for comparison;
he has not reported back on which he prefers.

**Recipient state at the time of the fix:** `vigdor@trustbookkeepingny.com` has
**no MobileDevice rows** (so he would have been on web/desktop and would have hit
the same cutoff) and `lastReadAt` was **null** — he had not opened the thread, so
the playback fix landed before he ever tried.
