# Connect Chat — Image / Voice-note / MMS test matrix

End-to-end checklist for validating the chat-media + VoIP.ms MMS overhaul
(plan: `chat-media-mms-overhaul`). Run this whenever any of the following
change:

- `apps/api/src/connectChatRoutes.ts`
- `apps/api/src/chatMediaProbe.ts`
- `apps/worker/src/connectChatSmsJob.ts`
- `apps/worker/src/mmsAudioConvert.ts`
- `packages/shared/src/chatAttachmentStorage.ts`
- `packages/shared/src/chatSignedUrl.ts`
- `apps/mobile/src/screens/tabs/ChatTab.tsx` (Composer / bubble)
- `apps/portal/components/chat/*`

The checklist mixes mobile and portal cases and covers the success path,
the carrier-reject -> link-fallback path, and validation rejections.

---

## 0. Pre-flight

- [ ] `prisma migrate deploy` has run (the
  `20260505000000_chat_attachment_media_metadata` migration must be
  applied; otherwise `mediaKind`, `durationMs`, `width`, `height` will not
  persist and bubbles will degrade to "best-fit").
- [ ] `ffmpeg` and `ffprobe` resolve inside both the API container
  (`docker exec connect-api ffmpeg -version`) and the worker container
  (`docker exec connect-worker ffmpeg -version`). The MMS audio converter
  and image / audio metadata probe both fail open if these are missing,
  but you'll lose the small-file MMS path.
- [ ] At least one tenant DID is `active=true`, `smsCapable=true`, and
  `mmsCapable=true` in `TenantSmsNumber`. Confirm in the DB or via the
  portal's SMS Numbers page.
- [ ] `GlobalVoipMsConfig.apiUsername` / `apiPassword` are populated and
  have been validated by `validateVoipMsCredentials` recently (logs:
  `voipms_credentials_validated`).
- [ ] You have a real cell number to send MMS to (the worker actually
  hits VoIP.ms; loopback isn't a substitute).

---

## 1. DM (internal) — image bubbles

| # | Action | Expected |
|---|--------|----------|
| 1.1 | In the mobile Composer, paperclip -> Photos, pick **1 image**, send. | Bubble renders the image inline (rounded 2xl, max ~70% width, original aspect ratio with no flash-of-incorrect-size). |
| 1.2 | Pick **2 images**, send. | 2-up grid, equal halves. |
| 1.3 | Pick **3 images**, send. | 1 large + 2 stacked small (Telegram/Instagram style). |
| 1.4 | Pick **4 images**, send. | 2x2 grid. |
| 1.5 | Tap any image bubble. | Opens full-screen viewer; pinch-zoom works. |
| 1.6 | While an image is uploading, watch the bubble. | "Sending" overlay (activity indicator). |
| 1.7 | Disconnect Wi-Fi during upload, send anyway. | Bubble flips to "Failed"; tapping the alert icon retries. |
| 1.8 | Open the same DM in the portal. | Same images render inline (no `Open MMS media` link), tap opens lightbox. |

## 2. DM (internal) — voice notes

| # | Action | Expected |
|---|--------|----------|
| 2.1 | Press-and-hold the mic button on the mobile Composer for ~3 s, release. | Recording bar shows pulsing red dot + `0:0X` counter; on release a `VoiceNoteBubble` appears with play/pause + duration. |
| 2.2 | Tap play on the bubble. | Audio plays end-to-end; progress bar advances. |
| 2.3 | Press-and-hold mic, slide finger up/left past ~80 px, release. | Recording is discarded silently; no message is created. |
| 2.4 | Tap-and-immediately-release mic (under 600 ms). | Recording is discarded with no error. |
| 2.5 | Open the same DM in the portal. | The voice-note plays via the portal's custom player (play/pause + duration). |
| 2.6 | Record a voice note from the portal Composer (mic button) and send. | Renders as voice-note bubble in both portal and mobile; mobile can play it. |

## 3. SMS (external) — image MMS

| # | Action | Expected |
|---|--------|----------|
| 3.1 | Open an SMS thread to a real cell number. Paperclip -> Photos -> pick a small JPEG (~200 KB). Send. | API returns 200; worker logs `mms_send_requested` then `voipms_response { ok: true }`; recipient receives the image as an MMS. |
| 3.2 | Send a PNG ~1 MB. | Same as 3.1 — true MMS, no link in body. |
| 3.3 | Try to send an image **>2 MB**. | API returns `400 { error: "MEDIA_TOO_LARGE", limitBytes, gotBytes }`. Mobile composer surfaces a clear error toast. No worker job enqueued. |
| 3.4 | Send to a DID with `mmsCapable=false`. | Worker logs `mms_not_available`, falls back to `chat_link_fallback_sent`; recipient receives an SMS with a short signed link. |
| 3.5 | Send to a DID that is **not** in the tenant's `TenantSmsNumber` list. | API returns `400 { error: "DID_NOT_ASSIGNED" }`. |
| 3.6 | Send to a malformed `to` number (e.g. `abc`). | API returns `400 { error: "INVALID_DESTINATION" }`. |

## 4. SMS (external) — voice-note MMS

| # | Action | Expected |
|---|--------|----------|
| 4.1 | Record a 5-second voice note in an SMS thread (mobile press-and-hold mic). | Worker logs `mms_send_requested`, then `voipms_audio_converted { from: 'audio/mp4', toBytes: <≈ 16-30 KB> }`, then `voipms_response { ok: true }`. Recipient cell receives a playable MMS audio. |
| 4.2 | Record a 30-second voice note. | Same as 4.1; converted file is comfortably under 590 KB at 24 kbps. |
| 4.3 | Record a 5-minute voice note (long-press the mic). | Worker first tries 24 kbps -> retries at 16 kbps; if still over budget, throws `MmsAudioTooLargeError`; falls back to `chat_link_fallback_sent` with a signed link to the *original* high-quality file. |
| 4.4 | Submit a voice note from the portal (`audio/webm` recording). | Worker re-encodes to `audio/mp4` AAC mono 16 kHz; same MMS path as 4.1. |
| 4.5 | Force VoIP.ms to reject MMS (e.g. temporarily blank `mediaUrl` in the worker payload — staging only). | Worker logs `mms_send_failed`; falls back to SMS+link with the original recording URL. |

## 5. Validation rejections (UI surface)

| # | Action | Expected |
|---|--------|----------|
| 5.1 | Send an audio file > 5 MB pre-conversion. | `400 MEDIA_TOO_LARGE`. |
| 5.2 | Send to an SMS thread whose DID has `active=false`. | `400 DID_INACTIVE`. |
| 5.3 | Send to an SMS thread whose DID has `smsCapable=false`. | `400 DID_NOT_SMS_CAPABLE`. |
| 5.4 | Send when `GlobalVoipMsConfig` is empty. | API still enqueues, but the worker logs `voipms_not_configured` and the message ends up `deliveryStatus="failed"` with `metadata.providerError.code = "voipms_not_configured"`. |

## 6. Logging contract (no secrets ever)

Tail the API + worker logs while running the matrix. Every event below
must appear; **none** of them may contain `apiPassword`, `api_password`,
the raw VoIP.ms response body, or the `sig` query-string of a signed URL.

API:

- `chat_attachment_uploaded` { tenantId, threadId, mimeType, sizeBytes, mediaKind, durationMs?, width?, height? }
- `chat_attachment_validation_failed` { reason, tenantId, threadId, ... }
- `chat_message_send_requested` { tenantId, threadId, messageId, type, attCount }
- `chat_message_validation_failed` { reason, tenantId, threadId, ... }

Worker:

- `mms_send_requested` { threadId, messageId, attCount }
- `voipms_audio_converted` { from, toMime, toBytes, bitrateKbps }
- `voipms_audio_convert_failed` { from, err }
- `voipms_payload_prepared` { mediaCount, mediaUrls (with `sig` redacted) }
- `voipms_response` { ok, providerMessageId? }
- `mms_send_failed` { err, falling_back: true }
- `chat_link_fallback_sent` { mediaCount, deliveryStatus: "sent_link_fallback" }

## 7. Cleanup (after a real-carrier MMS test)

- [ ] Delete the test thread (mobile -> long-press conversation -> Delete).
- [ ] Confirm the converted attachment row in `ConnectChatMessageAttachment`
  was created (one per audio MMS) and is independent from the original
  attachment row (different `id`, same `messageId`).
