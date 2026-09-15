# AGENT HANDOFF — Face-to-face AI Support: mockup and recommendation (2026-09-15)

## Status

**The earlier avatar/video direction is superseded.** The owner clarified that the AI must look exactly like the existing Loopcom Assistant. The only requested addition is a **“Talk to Laybel”** option, where Laybel is the name for the same Assistant when speaking by voice. No production code was added; no deployment, database migration, PBX interaction, provider account, model, knowledge base, tool registry, customer-context service, policy, retention setting, avatar, or video feature was changed or approved.

The owner specifically required the existing Loopcom AI Assistant to remain the intelligence/orchestration layer. Laybel is only the voice-mode name for that existing Assistant; this work honors that constraint.

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

The requested deliverable is the review mockup only. Do not deploy or implement the voice option until the owner explicitly asks to proceed.
