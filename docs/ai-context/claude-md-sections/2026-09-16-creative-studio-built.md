# Creative Studio — BUILT AND LIVE: images and AI video really generate (2026-09-16)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATIVE_STUDIO_BUILD_2026-09-16.md`**.
Phase-0 design + mockup: `2026-09-15-creative-studio-phase-zero.md` (still the screen inventory and the
licence research). Izzy, 2026-09-16: *"Go build it exactly like the mockups… do not stop until you have
proof."*

✅ **DEPLOYED: api `8a914d26`, container-verified healthy, migration `20260916140000_creative_studio`
applied (19 additive tables).** Proven on PRODUCTION, not a harness:

- **Image:** queued → succeeded in 15s, 2,022,197-byte PNG at the 4:5 that was asked for, FFmpeg thumbnail.
- **Video:** a 4s shot in 74s (h264+aac, 1280×720).
- ⛔⛔ **A 15-SECOND SHOT FROM A 12-SECOND ENGINE:** Sora only accepts `seconds` ∈ {4,8,12}, so the
  orchestrator planned **12 + 4**, ran two provider jobs, started part 2 from part 1's last frame, joined
  and trimmed → **duration exactly 15.000000s**. This is the headline capability; `planVideoSegments()` is
  why it works and must not be "simplified".
- **Refusals:** a Coca-Cola logo → 422 with a sentence for the customer; wrong internal secret → 403;
  another company asking for the same job → **404, not 403**; tampered signed URL → 401.
- **The learning loop, proven:** three identical rejections went `suggested(1) → suggested(2) →
  active(3)`, and the next generation came back `appliedMemory:["Prefers a slower pace"]` with the real
  prompt carrying *"Pacing: slower, let shots breathe."*

⛔⛔ **THE FACTS THAT MADE IT BUILDABLE IN A DAY — check these before re-planning anything:** the OpenAI key
already in `AgentSecret` has **gpt-image-2.5 AND sora-2** (no new account); **`connectcomms-minio` was
already running and completely unused** (that is the object storage; R2 unnecessary); **FFmpeg 5.1.9 is in
the api and worker images**. ⛔ The containers hold a PLACEHOLDER `OPENAI_API_KEY` — the real keys are
encrypted in `AgentSecret` and read via `resolveCreativeSecret()`; never "fix" the env.

⛔ **Enforced in code, not comments:** an engine with `commercialOk:false` cannot be chosen or enabled (422);
every query is tenant-scoped and answers *not found*; storage keys start `t/<tenantId>/`; quota is checked
before any provider call; cancel records part-done work as spent; FFmpeg always gets
`-protocol_whitelist file,pipe`; uploads are sniffed from their bytes. **One service (`service.ts`) serves
both the browser and the Coworker**, so the agent can never skip safety, quota or the brand kit.

⛔ **Two mistakes worth remembering:** `/internal/agent/creative/*` answered `unauthorized` until it was
added to `jwtPublicRouteBypass.ts` (which says so in its own comment); and a patch anchored on
`} from "lucide-react";` also matched inside `import type { LucideIcon }` on navConfig line 1 and merged
them — **another session caught and repaired that on origin**. Both are pinned by tests now.

⏳ **NOT DONE:** the **portal is not deployed** (`deploy-direct.sh portal` refused with `HEAVY JOB ALREADY
RUNNING` — another session was mid-build; pages are committed and typecheck clean); the **agent is not
rebuilt**, so the 10 `creative_*` tools are in git but not yet live in a chat; **no key is granted to
anybody** (granting IS the launch); MinIO is using ROOT credentials (scoped service account is the
follow-up); and the storyboard, timeline UI, audio/captions, export screen and self-evaluation are not
built yet. 40 tests pass (`apps/api/src/creativeStudio/creativeStudio.test.ts`).
