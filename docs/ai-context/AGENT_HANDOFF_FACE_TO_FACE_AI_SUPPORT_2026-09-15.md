# AGENT HANDOFF — Face-to-face AI Support: mockup and recommendation (2026-09-15)

## Live screen test and layout correction — 2026-09-16

- Owner explicitly required screen takeover and proof before any claim of working. Persisted this as a standing CLAUDE rule. Green tests/token/deployment alone are not call proof.
- Started the real production call in Chrome. UI reached Connected, the approved portrait arrived, microphone transcription reached the existing Assistant and replies appeared in its transcript. Screenshot exposed a real defect: the avatar was clipped to a thin strip. DOM measurement confirmed call panel height **21.6 px**, scrollHeight **259 px**, parent `.fa-msgs` flex column. Ended the test with the actual End call control; did not leave microphone capture running while fixing it.
- Minimal fix `40c3ba2a0f7041e1fdcb95b8955305b7a06c7bfc`: call panel flex `0 0 auto`, 16:9 contained video (no portrait crop), scroll panel into view on mount, suppress transcript auto-scroll only during video mode. Same Assistant, media transport, credentials, customer rollout and other chat modes unchanged.
- Verification: 17/17 Assistant tests including new layout guard; full isolated portal typecheck passed. Idle-queue check, portal dry run and scripted blue/green rollout completed; production build generated 221 pages. Log `/var/log/connect-deploys/direct-portal-20260916T103607Z.log`.
- Deployment race: final log said `done fb563e27`, NOT the requested SHA. Did not blindly retry or reset the shared clone. Running portal `/app/.build-commit` equals `40c3ba2a0f7041e1fdcb95b8955305b7a06c7bfc`, and its built layout chunk contains `flex:0 0 auto`, `aspect-ratio:16/9`, `object-fit:contain`. Concurrent clone changes to fb563e27 were four unrelated API Yiddish files. Stable upstream reads `server 127.0.0.1:3000;`; public /ready 200. Log SHA is unreliable under this observed concurrent-clone race; container and browser evidence establish this layout shipped.
- Post-fix production Chrome test showed the real approved portrait and Connected status. Panel height now **287.8 px**; rendered video **310.4 x 174.6 px**, versus the broken 21.6 px panel. Screenshot displayed to owner. Call subsequently disconnected with generic provider/SDK connection-closed text before a spoken test reply; console exposed no useful reason. Do not attribute it to quota, duration or network without evidence.
- Owner reported inability to start a subsequent video call. Ended the failed call, reopened Talk to Laybel, clicked Start video call: a second real session connected and displayed the portrait/greeting speaking state. This proves restart in the controlled Chrome tab, not resolution of the owner's exact separate experience. No post-fix spoken test utterance/reply or audible playback confirmed yet. **END-TO-END ACCEPTANCE STILL OPEN**, customer rollout disabled. Require actual spoken question, recognized transcript, relevant reply, audible playback and repeat-start proof; never substitute screenshots or token success for the missing audio leg.

## Provider configuration completed — 2026-09-16

- Owner asked to insert the API key and then explicitly approved creating a restricted key. Anam account had **no keys**, confirmed in its signed-in API Keys UI. Created `Loopcom Laybel` with **Create session tokens only**; Full access OFF, all ten resource read/write permissions None. No existing key was rotated or deleted.
- Captured the one-time secret in browser-session memory, transferred directly to the Loopcom password field, and saved through the owner-only encrypted settings route. Key was never printed, committed, written to a local file, or placed in command arguments. Temporary secret variables cleared after successful save.
- Uploaded approved `concept-a.png` (no tie, infinity lapel pin) and completed Anam custom-avatar creation as **Laybel**, model cara-4. Uses the account's one included avatar slot; UI showed 0/30 minutes. No paid upgrade or subscription purchase performed.
- Verified custom avatar ID `dab6a872-ecf4-4e5b-9488-24f182d6e8d4`; owner-preview voice **Cooper - Friendly Mate**, ID `90c1fb05-4fc0-11f1-84b0-52bacf74fa75`. This voice is a provisional warm male voice, not user-auditioned or Yiddish-proven. The old build URL is an Olivia persona, NOT an avatar ID. Its draft now uses the custom avatar; it was not publicly published, and Loopcom still overrides the brain with CUSTOMER_CLIENT_V1.
- Live verification through production API: status 200, configured=true, available=true, apiKeySet=true, enabled=false; session POST **200 with session token issued**. No secret/token printed. maxSessionSeconds currently 300; token mint acceptance does not prove the plan permits a full 300-second call.
- Browser confirmed Saved, then reload + reopen confirmed Start video call enabled. Left owner preview open in Chrome (`https://app.loopcom.net/dashboard`, tab 1520626758). No microphone capture, WebRTC call, rendered live animation, audible reply or real conversation was tested in this activation turn. Customer rollout remains disabled; retention, actual plan duration, Yiddish quality, and SignalWire comparison remain unresolved.
- Browser recovery: inventory timed out, but direct `cua.createBrowserTab("chrome", "https://lab.anam.ai", ...)` succeeded. Upload image opens a rights-confirmation dialog before the file chooser; bind the chooser to Agree and continue. `clipboard.readText()` returned empty despite copy working; browser ControlOrMeta+V into the actual ID input worked. Password manager autofilled email into the avatar field; explicitly filled the verified UUID and API key immediately before saving. Never treat clipboard length alone as evidence that Copy failed.

The older missing-key/avatar statements below describe the pre-activation state and are superseded by this section. This is key/configuration/token proof, not live conversation proof.

## Verified production rollout — 2026-09-16 UTC

- Owner approved the lockfile repair and Windows SSH exception. Repaired lockfile has only 18 additive Anam/buffer lines; frozen/offline pnpm 10.30.2 validation passed. No unrelated shared-worktree edits shipped.
- API and portal deployed through scripted blue/green direct releases at **b6d3310ec3177ddb02de3d16c1853c6a66afe4d6**, after dry runs and idle queue checks. Release branch: `codex/laybel-live-video-20260916`; rebased onto current remote before atomic non-force push.
- Logs: `/var/log/connect-deploys/direct-api-20260916T021501Z.log` and `/var/log/connect-deploys/direct-portal-20260916T022210Z.log` both ended `done b6d3310e`. Both running containers' `/app/.build-commit` matched the full SHA. API contains `CUSTOMER_CLIENT_V1`; portal built chunks contain `/support/laybel/session`, `Owner video setup`, and `streamToVideoElement`.
- Stable nginx upstreams verified at API `127.0.0.1:3001` and portal `127.0.0.1:3000`. Public `https://app.loopcom.net/ready` returned 200. External internal-route tenant-map probe returned 403. No infrastructure/env/PBX changes or direct migrations.
- Focused tests: API/PBX 14/14, Assistant/consent/turns 16/16. Full isolated portal typecheck and production build passed; 217 static pages generated.
- Live API negative checks: anonymous status 401; owner status 200 with no-store and no API key; configured/available both false; unconfigured session 503; client config override 400; customer settings write 403. No configuration writes or paid provider sessions performed by these probes.
- **Not activated/live-proven:** production has existing SignalWire credentials but no Anam/Laybel secret or environment settings. Need Anam key plus verified approved avatar ID and voice ID; Anam Lab build ID is not assumed to be avatar ID. Owner setup is deployed under Assistant > Talk to Laybel > Owner video setup. Customer rollout stays disabled. Browser control timed out; no portrait upload, microphone/playback/animation or real conversation proof. SignalWire comparison adapter remains unimplemented. Verify plan duration, recording/retention and Yiddish quality before customer activation.

The earlier local-only deployment/lockfile blockers below are historical and superseded by this verified rollout. Provider configuration and end-to-end call proof remain unresolved.

## Earlier implementation notes — live video explicitly requested

### Approved continuation — 2026-09-16, release preparation

- Owner explicitly approved repairing the installer lockfile churn and using Windows SSH for this task. Windows SSH reached `vmi3101417`; queue was idle. This exception is scoped to this release, not a rewrite of the canonical SSH rule.
- Repaired the shared lockfile and applied only 18 additive lines (Anam SDK 4.27.0 and buffer 6.0.3). A malformed intermediate proposal was rejected before writing; the corrected patch preserved all existing dependencies. Isolated checkout frozen/offline validation passed with pnpm 10.30.2.
- Release worktree: `scratchpad/laybel-release`, branch `codex/laybel-live-video-20260916`, based on current remote `617154b8`. Does not include unrelated shared-tree edits. API/PBX focused suite 14/14 and Assistant suite 16/16 rerun successfully on the release source.
- Production configuration read returned only `signalwire_credentials`; no Anam/Laybel AgentSecret or ANAM_/LAYBEL_ environment keys exist. Browser inventory/access timed out again; do not claim avatar/key/voice setup or live media proof.
- Customer video remains disabled by default. No portrait upload, recording-retention verification or live Anam/SignalWire call has occurred. Deployment status will be recorded below after the scripted release.

The owner's later instructions explicitly require real animated video of the approved Concept A portrait, the existing Assistant brain, a SignalWire comparison, production deployment and live proof. The earlier push-to-talk-only interpretation below is historical and was incorrect as a final scope. Desktop Commander is not a dependency for shipping this feature.

### Local code added this turn

- `apps/api/src/laybel/laybelRoutes.ts`, registered in `server.ts`: encrypted `AgentSecret` configuration (`laybel_avatar_config`), write-only provider key, owner settings, authenticated status/session routes, strict rejection of client persona/tenant overrides, server-selected `CUSTOMER_CLIENT_V1` custom LLM, bounded 60–600-second sessions, 15-second upstream timeout, 3 requests/user/minute, sanitized provider errors. Rollout defaults disabled; owner may preview. No schema migration or PBX access.
- `apps/portal/components/LaybelVideoCall.tsx`: explicitly consented microphone-only Anam SDK stream, no user camera, actual remote video element, live speech history back into the existing Assistant `send`, spoken existing replies, interruption, mute/speaker/end/retry and voice-only fallback. Cleans media tracks/SDK connection on late permission, timeout, end, unmount, pagehide and human takeover. Call fails honestly if provider settings are missing.
- `LaybelSetup.tsx`: owner-only setup UI with write-only API-key input and approved-avatar/voice IDs. Saving preserves existing rollout state; it does not enable customers automatically.
- `apps/portal/lib/laybelTurns.ts`: serial, deduplicated tool-bearing turns; no automatic action retries, no late speech after stop/interruption, stop on human takeover.
- `FloatingAssistant.tsx`: same panel and same authenticated chat brain, adds video surface only after Talk to Laybel; voice-only fallback remains. Stops media when minimizing/new chat/identity switch/leaving visible chat. Normal Coworker window does not gain the video option. No separate provider LLM or tool registry.

### Verification and release blockers

- Focused API/security suite: 14/14 passing (8 Laybel, 6 PBX safeguard).
- Final Assistant suite: **16/16 passing**, including consent/cleanup source guards and duplicate/serial/interruption/end/takeover controller tests.
- Full portal typecheck completed successfully with explicit `--types node,react,react-dom`. Final focused portal (including setup and Next declarations) and API typechecks also **passed** using ignored scratchpad configs that extend the repository configs. Default ambient discovery failed on missing root `@types/emscripten/index.d.ts`; an initial standalone API command lacked workspace aliases and reported the unbuilt security declaration, resolved by extending the actual base config. The sandbox blocks tsx `os.userInfo`; authorized elevated execution passes.
- No provider API key or approved avatar/voice IDs have been verified. Existing Anam Lab build tab: `/build/3bf340c5-4686-401b-88ea-c4caa5d7eeb1` (this is not assumed to be an avatar ID). Browser inventory works but selecting this tab repeatedly times out. No new paid plan or charge was authorized/executed.
- Anam receives mic audio and spoken replies; the UI discloses this before capture. Account-level recording/retention is NOT established by the ephemeral persona. Verify retention and Yiddish quality before enabling customer rollout. Original camera/screen/live-human-media requirements and the SignalWire adapter are not implemented in this turn.
- Docker Linux deployment runtime was not running. Local `docker desktop start` launched Docker processes but its command and subsequent engine version check never completed; only these two waiting CLI commands were interrupted. No Docker data was removed and no server changes/deployment occurred. Do not claim deployed or working end-to-end from unit tests.
- `pnpm --filter @connect/portal add @anam-ai/js-sdk@4.27.0 --lockfile-only` ran with pnpm 11.1.1 against a pnpm 10.30.2 installation and caused extensive unrelated lockfile churn. Bulk inverse patch was rejected by auto-review; user restoration approval was requested. Do not ship that broad lockfile diff. SDK is pinned at 4.27.0 in portal package.json; isolated SDK inspection copy exists under ignored `scratchpad/laybel-sdk/`.
- Shared tree contains many other sessions' changes, including server.ts, and stale staged versions of FloatingAssistant. Compare to HEAD and isolate only this task's hunks for any commit. Nothing from this turn has been committed/pushed/deployed.

### Official provider references checked

- https://anam.ai/docs/javascript-sdk/examples/custom-llm
- https://anam.ai/docs/api-reference/sessions/create-session-token
- https://anam.ai/docs/personas/session/duration
- https://anam.ai/docs/personas/avatars/custom-avatars
- https://anam.ai/docs/security/privacy

## Historical status — push-to-talk-only implementation, superseded by explicit video request

**The earlier avatar/video direction is superseded.** The owner clarified that the AI must look exactly like the existing Loopcom Assistant. The only requested addition is a **“Talk to Laybel”** option, where Laybel is the name for the same Assistant when speaking by voice. That option is now implemented in `apps/portal/components/FloatingAssistant.tsx` and is pending the normal portal rollout. No database migration, PBX interaction, provider account, separate model, knowledge base, tool registry, customer-context service, retention change, avatar, video feature, LiveKit room, WebSocket, or new backend route was added.

The owner specifically required the existing Loopcom AI Assistant to remain the intelligence/orchestration layer. Laybel is only the voice-mode name for that existing Assistant; this work honors that constraint.

## Implemented behavior

- The existing dark Assistant panel and its normal suggestions remain intact. `Talk to Laybel` is the first suggestion row and opens only a compact in-panel voice state; it does not navigate or create another agent.
- The user explicitly starts voice mode and then uses the existing microphone control. Capture requests microphone access only at that point, with echo cancellation, noise suppression, auto gain, mono, and 48 kHz preferences.
- The completed take uses the pre-existing authenticated `/agent/chat/transcribe` path. Its text is submitted through the existing Assistant `send` helper and `/agent/chat/message` path with `channel: "voice"`; this preserves the same conversation id, tenant/page context, response rendering, tools, transcript, and escalation behavior as typed chat.
- The existing visible transcript remains authoritative. When browser native speech synthesis is available, the same returned Assistant text is read aloud locally. If speech synthesis is unavailable or fails, Laybel stays usable through the normal transcript and typed composer—there is no new TTS service or customer-audio storage path.
- Starting a new push-to-talk take cancels any current speech. Ending Laybel cancels speech and marks an active capture cancelled before its recorder stops, so a just-ended take is not sent after the user presses End.

## Verification for implementation

- `apps/portal/components/floatingAssistantOpening.test.ts` passed **11/11** via `tsx --test`, including the new source guard that asserts the label, same-Assistant voice channel, existing send path, browser-local speech call, and absence of LiveKit/WebSocket/voice-agent additions.
- `git diff --check` passed for the implementation.
- The shared-worktree portal typecheck currently reaches an unrelated concurrent edit in `apps/portal/components/deskPhones/DeskPhoneWizard.tsx` (`runId` used before its declaration). A clean temporary worktree cannot resolve this repository’s non-checked-in `node_modules`, so it cannot be used as an independent full typecheck. This is an outstanding release verification item, not an error reported in `FloatingAssistant`.

## Review artifact

Current interactive review mockup (outside the repository, durable task visualization folder):

`C:/Users/izzyw/.codex/visualizations/2026/09/15/01a0a601-3008-7cd3-af27-85b8c7495b42/ai-support-review/talk-to-laybel.html`

It includes:

- The same dark Assistant panel, header, greeting, suggestions, report/suggest actions, `Type or talk…` composer, and footer customers already recognize.
- A single, deliberately leading row: **Talk to Laybel** — “Speak with the same Assistant by voice.”
- A local mock voice state showing that Laybel keeps the existing Assistant conversation and page context. It deliberately shows no portrait, avatar, video call, new support console, or provider branding.

The earlier `talk-to-ai-support.html` and `concept-a.png`/`concept-b.png`/`concept-c.png` remain historical review material only. Do not reuse them as an approved design or implementation brief.

## Superseded architecture exploration

The following LiveKit/avatar assessment is retained as historical research only. It is **not** the approved scope and must not be used to start a provider evaluation, procurement, implementation, or deployment. The approved direction is the existing Assistant with a single voice-mode option.

```text
Loopcom Assistant (existing brain)
  ├─ existing customer/tenant identity and permissions
  ├─ existing support conversation, tools, diagnostics and escalation
  └─ existing transcript/timeline ownership
                 │
                 ▼
Video-support session adapter (new transport/presentation adapter only)
  ├─ maps STT turns → existing Assistant conversation
  ├─ maps existing assistant output → existing speech path and lifecycle state
  ├─ forwards explicit, scoped screen-share context only after consent
  └─ carries human-transfer package without re-summarizing customer history
                 │
                 ▼
Existing self-hosted LiveKit room
  ├─ customer camera/microphone/screen media
  ├─ standard controls, captions and resilient reconnect
  └─ avatar provider as a separate video-track participant
                 │
                 ▼
Avatar rendering provider (visual body only)
  └─ receives assistant speech + idle/listening/thinking/speaking state;
     returns lip-synced video/audio track to the LiveKit room
```

### Why this is the recommendation

- Loopcom Meetings already uses self-hosted LiveKit; video/audio/screen media should keep using that transport rather than moving all sessions to SignalWire or Telnyx.
- LiveKit documents virtual avatars as a standard room participant that publishes synchronized audio/video and can be rendered like any other video track. Its current avatar model overview lists Anam, D-ID, Beyond Presence and others with LiveKit plugins.
- The existing Assistant, its `completeWithTools` orchestration, support context, staff/customer security model, escalation record and remote-support consent model remain the authority. The adapter must call those existing doors; it must not clone their logic.
- Existing remote support already establishes the safety baseline: the customer alone consents, screen view and control are separate, status is re-evaluated on every action, stopping is never blocked, and the customer-facing consent route must retain its `permission: null` prefix rule. Do not turn a video-support feature into a second remote-control implementation.

## Provider comparison (research dated 2026-09-15)

| Option | Fit with existing stack | Cost signal | Recommendation |
|---|---|---|---|
| **LiveKit + Anam** | Strongest. Anam has LiveKit plugins; its avatar joins the same room as a visual participant while Loopcom retains the brain. Supports custom avatars and BYO/custom LLM flow. | Official Anam pricing shows 30 free minutes; paid plans include 50/250/2,000/5,000 minutes, 1/3/5/10 concurrent sessions, and $0.16/$0.14/$0.12/$0.11 overage per minute. Public price-card figures should be rechecked before buying. | **Pilot recommendation.** Lowest architecture disruption, preserves media transport and brand/control. |
| **SignalWire native video avatar** | Supports looping idle/listening/talking clips for an AI video call, but makes SignalWire the agent/video runtime rather than merely an avatar renderer. That works against the "existing Loopcom Assistant remains the brain" direction. | SignalWire publishes $0.16/min AI Agent Runtime plus voice/WebRTC transport at standard rates; it does not replace a custom real-time lip-sync avatar price in the cited recipe. | Keep only as a fallback for state-clipped video. Do not move Loopcom video transport or brain there. |
| **Telnyx AI Assistant + BYO Anam** | Its new Meeting API can attach a Telnyx assistant and a BYO Anam avatar, but that substitutes Telnyx’s assistant/tool system for Loopcom’s existing assistant. | Telnyx advertises $0.05/min Voice AI engine plus LLM/telephony; its meeting beta lists $0.02/min standard session or $0.05/min attached assistant plus tokens, with Anam billed separately. | Not recommended for this product. Useful benchmark/fallback only. |
| **Fully self-hosted avatar** | Would preserve data locality, but requires an independently operated real-time lip-sync/rendering pipeline, GPU capacity, model quality evaluation, monitoring and privacy controls. It is not a sensible first release. | Infrastructure/GPU and operations cost unknown until a prototype and session-concurrency target are measured. | Defer. Revisit only if third-party-data minimization or unit cost at scale justifies it. |

Source set: [LiveKit video/avatar docs](https://docs.livekit.io/agents/multimodality/vision/video/), [LiveKit avatar models](https://docs.livekit.io/agents/models/avatar/), [Anam pricing](https://anam.ai/pricing), [SignalWire avatar recipe](https://signalwire.com/developers/demos/r/give-an-agent-a-video-avatar.html), [SignalWire pricing](https://signalwire.com/pricing), [Telnyx meeting beta](https://telnyx.com/release-notes/telnyx-meeting-api-beta), [Telnyx voice-AI pricing](https://telnyx.com/pricing/voice-ai-agents).

## Cost framing (not a purchase quote)

The present LiveKit server does not add a third-party per-minute media fee, but its measured readiness is not yet sufficient to quote production capacity. It currently has a France media location and an unresolved forced-relay/hairpin issue; normal browser join is proven, filtered-office/relay operation is not.

For the recommended avatar layer, use time-connected rather than talking time: Anam bills from session start through session end. At the published Explorer overage rate, 1,000 minutes beyond included usage is $140; at Growth, 5,000 excess minutes is $600. Those numbers exclude the paid plan, existing Assistant-model/STT/TTS costs, LiveKit infrastructure, monitoring, and any custom-avatar/enterprise privacy agreement. A 10-minute support-session cap and automatic idle timeout should be a design requirement, not a billing afterthought.

## Non-negotiable integration contract

1. **No separate AI brain.** The adapter calls the same Loopcom Assistant conversation/orchestration layer; it gets no parallel model prompt, memory, knowledge base, or tool registry.
2. **No transport migration by default.** Use an existing Loopcom Meeting / LiveKit room; the avatar publishes a track into it.
3. **Explicit consent.** Customer camera/mic preview comes before join; screen sharing is expressly requested; remote control remains a separate, existing consent path and must never be implied by screen sharing.
4. **Least disclosure.** Send the provider only assistant speech/state needed to render the avatar. Do not expose raw customer diagnostics, secrets, customer history, screen contents or tenant data to the avatar provider unless a separately reviewed data contract makes that necessary.
5. **Preserve the live case.** Human escalation carries transcript, verified diagnostic results, current task, tenant/customer context and still-valid consent state. It must not make the customer repeat the problem.
6. **Failure is graceful.** Video loss degrades to the existing voice or text experience; no fresh conversation, tool loss or silent session death.
7. **Policy remains existing policy.** Recording is off unless explicitly approved; any enabled recording must be visibly disclosed and governed by retention/audit controls. PBX mutation safeguards remain fully in force.

## If implementation is later authorized

1. Preserve `FloatingAssistant`; do not create an Assistant replacement, separate app/page, avatar, or video interface.
2. Add exactly one customer-facing choice labelled **Talk to Laybel** and connect it to the same existing Assistant conversation, tenant context, tools, transcript, escalation, and permission checks.
3. Decide the existing voice transport/lifecycle and explicit disclosure requirements before writing runtime code. Do not infer a provider or introduce one from the superseded research.
4. Test that chat, voice, context continuity, and human escalation remain one conversation; then follow normal navigation/permission, deployment, and container-verification rules.

## Verification performed for this mockup phase

- Read the relevant Assistant, Technical Support Console, Meetings, Remote Support Hardening and Remote Support engine handoffs before proposing the change.
- Generated the three requested review-only avatar directions with the built-in image-generation flow; generated assets were displayed inline.
- Revised Concept A with the same built-in image-generation flow; inspection confirmed the tie is absent and the small Loopcom infinity lapel pin is present. That then-selected draft replaced `concept-a.png`; it is now superseded by the owner's no-avatar correction.
- Static mockup validation passed: 29,338-byte HTML fragment, under the 1 MB visualization limit; correct root; no document wrapper; no escaped markup; all three avatar assets and critical state/admin/transfer strings present.
- Rendering wrapper was generated successfully. A Chrome manual visual check could not proceed because browser automation rejects local `file:` URLs. No workaround was attempted. Therefore **browser visual acceptance is not proven**.
- Owner correction received after that review: replace the avatar/video concept with the existing Assistant visual and one `Talk to Laybel` voice row. New review fragment static validation passed: 9,907 bytes, no document wrapper or escaped markup; the row and local start/end voice-state controls are present.

## Current boundary

The owner explicitly authorized the production-ready build. The only remaining step is normal portal deployment and its required log/container verification, after the concurrent portal typecheck issue is resolved or confirmed unrelated by the release path. Do not widen the scope into avatar/video, a separate Laybel brain, a voice provider, backend persistence, or PBX work.
