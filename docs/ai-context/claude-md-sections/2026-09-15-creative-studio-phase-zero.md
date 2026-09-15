# Creative Studio — PHASE 0 ONLY: mockup + architecture, NOTHING BUILT (2026-09-15)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATIVE_STUDIO_2026-09-15.md`**.
Mockup: **https://claude.ai/artifact/3SGpm83ss2eor8unoGkGPd** · source `docs/mockups/creative-studio/`.

Izzy's brief (2026-09-15): a full AI Creative Studio inside the existing Coworker — images, AI video capped
at 15s per clip, storyboards, timeline, a Canva-style editor the agent can drive, brand kits, creative
memory, provider-agnostic engines, GPU workers, admin console. **The brief itself orders a stop after the
mockups.** Obeyed: 20 customer screens + 12 states, 7 admin screens, and a design review (flows, stack with
licences, architecture, data model, tools, security, GPU/cost, phases). The prototype really runs — the
Coworker plays a whole commercial job including a failed self-check and a retry; the design editor drags and
the agent edits the same document; the timeline plays and splits. All imagery is painted on canvas in-page.

- ⏳ **NOT BUILT, NOT DEPLOYED, NOT APPROVED.** No route, table, migration, dependency, permission key,
  navConfig entry or agent tool exists. Only `docs/` files were added. **Silence is not approval.**
- ⛔⛔ **Licences are the constraint, not quality.** Safe: Qwen-Image (Apache), FLUX.1 schnell / FLUX.2 klein
  4B (Apache), Wan 2.2 (Apache), BiRefNet (MIT), Real-ESRGAN (BSD), ElevenLabs. **Not usable as defaults:**
  FLUX.1 dev/Kontext dev (non-commercial to serve), SD 3.5 + Stable Audio Open (free only under $1M revenue),
  **RMBG-2.0 and MusicGen (CC BY-NC)**, HunyuanVideo (excludes EU/UK/KR), LTX-2 (free under $10M ARR).
- ⛔ **Polotno is the editor recommendation but it is paid** (~$249–899/mo, licence key required) and the
  self-serve tier is **one domain — Loopcom has two hostnames**. Must be confirmed or priced as enterprise;
  free fallback is Konva/Fabric (MIT) plus months of UI work.
- ⛔⛔ **ComfyUI has NO authentication** — queueing a prompt on it runs Python. Loopback inside the worker
  only, versioned workflow templates only, no Manager. Whether HTTP-calling it satisfies its GPL needs a
  lawyer's sentence before Phase 5.
- ⛔⛔ **Repo facts that shape the build:** no image/video generation exists today (the router even hides
  image models); tool names must match `^[a-z][a-z0-9_]{0,63}$` so `creative.generateImage` is invalid;
  **the agent has no streaming and no async jobs** — a turn is one 900s-max HTTP request, so renders must
  return a job id and be polled; `StepKind` is a closed union needing a `media` member on both sides;
  storage today is Docker volumes (a directory with no volume is wiped every deploy); **there is no GPU
  anywhere** (loopcom has none, the 2012 desktop lacks AVX2).
- ⛔ **The spend approval is drawn by the server**, unlike the desktop Coworker's local approval window.
  Accepted here (refundable money, deletable content) — **must not be copied back to the desktop hands.**
- **Six decisions are open with Izzy:** editor licence, media storage (R2 recommended), which video provider,
  whether to charge customers, who gets it first, and the ComfyUI legal question.
