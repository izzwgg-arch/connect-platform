# Talk to Laybel — deployed, provider activation pending (2026-09-16)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_FACE_TO_FACE_AI_SUPPORT_2026-09-15.md`**.

- **Deployed:** API and portal scripted blue/green releases at `b6d3310ec3177ddb02de3d16c1853c6a66afe4d6`; completion logs, container build markers, API code and portal bundles verified. Stable upstreams restored to 3001/3000; public readiness 200, external internal-route guard 403.
- **Same Assistant:** Anam custom-LLM media adapter forwards finalized speech to the existing Assistant and speaks its replies. Encrypted owner setup, bounded/authenticated sessions, consent, lifecycle cleanup, deduplication and voice-only fallback are deployed. No PBX or schema changes.
- **Verified:** 30/30 focused tests; frozen pnpm 10.30.2 lock validation; full isolated portal typecheck and production build (217 pages). Live API rejects anonymous access, customer settings writes, overrides and unconfigured sessions; keys never returned.
- **Blocked on provider activation:** production has no Anam key or approved avatar/voice IDs. Owner setup is under Assistant > Talk to Laybel > Owner video setup. Customer rollout stays disabled. No actual animated conversation, approved portrait upload, playback, retention or Yiddish quality has been verified. Existing SignalWire credentials do not implement the requested comparison adapter; that remains unfinished.
- **Owner approval used:** repaired unrelated pnpm 11 lock churn to 18 additive Anam/buffer lines; scoped Windows SSH exception enabled this release. Isolated commit excludes unrelated shared-tree edits. Desktop Commander is not a prerequisite; do not stall on pairing it.
