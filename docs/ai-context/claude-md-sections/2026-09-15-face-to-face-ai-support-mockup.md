# Talk to Laybel — live screen test, acceptance still open (2026-09-16)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_FACE_TO_FACE_AI_SUPPORT_2026-09-15.md`**.

- Owner demands user-visible proof before any working claim. Tests, deployment, tokens and Connected status are not a substitute for a heard question and audible reply.
- Restricted session-token-only Anam key stored encrypted; approved no-tie/infinity-pin custom Laybel avatar configured. Existing Assistant is still the brain. Customer rollout remains disabled; owner preview enabled. No paid upgrade.
- Actual live call exposed collapsed video: panel only 21.6 px high. Fixed flex shrinking, aspect ratio/containment and transcript scrolling in portal commit `40c3ba2a`; deployed blue/green. After reload actual portrait rendered at 310.4 x 174.6 px, panel 287.8 px. Screenshots shown to owner.
- First call passed microphone transcription into existing Assistant and replies appeared in chat. Post-fix call connected with visible portrait, then disconnected before a spoken test reply. Owner reported restart trouble; controlled End > Talk to Laybel > Start produced a second connected session with portrait. No post-fix spoken utterance or audible answer confirmed. Ended test and left Start video call open, microphone off.
- Verification: 17/17 Assistant tests, full portal typecheck, production build (221 pages). Running /app/.build-commit matches 40c3ba2a and bundle contains fix; stable upstream :3000, /ready 200. Final deploy log instead said fb563e27 because shared clone advanced concurrently; investigated rather than blindly redeploying. Full evidence in handoff.
- Still open: actual audible question/reply acceptance, unexplained disconnect and owner's repeat-start experience; voice/Yiddish quality, retention and plan duration (app cap 300 seconds). SignalWire comparison adapter remains unfinished. Do not call this end-to-end proven.
