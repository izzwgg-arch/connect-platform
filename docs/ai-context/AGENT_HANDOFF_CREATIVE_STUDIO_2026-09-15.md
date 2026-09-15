# ⛔⛔ AGENT HANDOFF — LOOPCOM CREATIVE STUDIO: PHASE 0 ONLY. DESIGN + MOCKUP + ARCHITECTURE. **NOTHING IS BUILT, NOTHING IS WIRED, NO PRODUCTION FILE WAS TOUCHED** (2026-09-15)

Read this before touching anything called "Creative Studio", before adding any `creative_*` agent tool,
before proposing image/video generation anywhere in Loopcom, and before anyone acts on the mockup as if
it were a spec of something that exists. **It does not exist.** It is a drawing.

- **Mockup (live, clickable):** https://claude.ai/artifact/3SGpm83ss2eor8unoGkGPd
- **Source:** `docs/mockups/creative-studio/` — `index.html` + `cs-core.js` / `cs-user.js` / `cs-editors.js` /
  `cs-admin.js` / `cs-review.js` / `cs-boot.js` / `cs-screens.css` + `brand/` (3 real Signal Core PNGs copied
  from `apps/portal/public/brand/loopcom/`).
- **Summary file:** `docs/ai-context/claude-md-sections/2026-09-15-creative-studio-phase-zero.md`
- **Brief:** Izzy, 2026-09-15 — a complete AI Creative Studio (images, AI video capped at 15s per clip,
  storyboards, timeline, Canva-style design editor, brand kits, creative memory, provider-agnostic engines,
  GPU workers, admin console, permissions, multi-tenancy, security, cost tracking). The brief itself says:
  **do Phase 0 only, stop at the mockups, do not start production implementation.** That instruction was obeyed.

---

## 1. WHAT WAS PRODUCED

| Thing | Where | State |
|---|---|---|
| 20 customer screens + 12 UI states | the mockup, "Customer" mode | drawn, interactive |
| 7 platform-admin screens | the mockup, "Platform admin" mode | drawn, interactive |
| Design review A–J (flows, stack, architecture, data model, tools, security, GPU/cost, phases) | the mockup, "Design review" mode | written |
| This handoff | here | — |

The mockup is genuinely interactive, not a picture: the Coworker run plays through concepts → storyboard →
spend approval → rendering (with a deliberately failed self-check and one retry) → the cut → a revision →
export; the storyboard re-orders by drag; the design editor drags objects and edits properties; agent design
mode mutates the same document and prints the operation log; the timeline plays, splits and re-times; the
inpaint mask is really painted on a canvas; the compare slider works. Placeholder imagery is **painted
procedurally on `<canvas>`** (11 scenes) — no stock photos, no external image requests, nothing to license.

## 2. THE FACTS THE DESIGN IS BUILT ON (verified in this repo on 2026-09-15)

⛔ Check these again before building — they are the load-bearing ones.

- **There is NO image, video or TTS-image generation anywhere in Loopcom today.** No `gpt-image`, no DALL·E,
  no Runway, no `sharp`. The router (`apps/agent/src/llm/router.ts`) is OpenAI + Anthropic text only and
  **`filterChatModels` explicitly hides tts/image models from the picker**. Audio exists (ElevenLabs, Polly)
  and is the right base for voiceover.
- **FFmpeg already ships in the api and worker images** and is always called as a binary through
  `child_process` (`mohStorage.ts`, `voicemailEmailAttachment.ts`, `chatVoiceNoteDenoise.ts`,
  `mmsAudioConvert.ts`). There is no fluent-ffmpeg and no media container. The agent container has **no**
  ffmpeg — it hands audio to the api.
- ⛔⛔ **Agent tool names must match `^[a-z][a-z0-9_]{0,63}$`.** `creative.generateImage` (the dotted form in
  Izzy's brief) is invalid. Use `creative_image_generate`. Also add the new names to `RESERVED_TOOL_NAMES`
  (`desktopTools.ts:27`) so a desktop manifest cannot shadow them.
- ⛔⛔ **There is no streaming and no async job pattern in the agent.** One HTTP request is held open for the
  whole turn (nginx allows 900s); live progress is the `ActivityHub` poll (`/agent/coworker/activity`).
  **A four-minute render therefore cannot be an awaited tool call** — `creative_video_generate` must return a
  job id and the agent must poll. `StepKind` is a closed union (think/files/web/sheet/phone/shell/system/git/
  mcp/ask/account) shared with the portal's `coworkerModel.ts`; a `media` kind must be added on both sides.
- ⛔ **Storage today is local Docker volumes only** (`/var/lib/connect/<name>`, `*_STORAGE_DIR`), signed short-
  lived URLs, `storageKey` columns. `@aws-sdk/client-s3` is a dependency but **no `S3Client` is used**.
  ⛔ A directory with no volume is wiped by every deploy — this has bitten the project before (onboarding
  uploads). Media must not go on the api's disk by accident.
- **Queue:** BullMQ + ioredis against `redis://connectcomms-redis:6379`, a container on the external
  `infra_default` network that is **not defined in this repo's compose files**. Plus `setInterval` sweeps in
  the worker and the `EmailJob` table lane.
- ⛔⛔ **There is no GPU anywhere.** loopcom is 18 vCPU/94 GB with a QEMU virtual VGA; Izzy's desktop is a 2012
  i7-3770 with **no AVX2** (PyTorch aborts at import); the Latitude is a 15W laptop. Any "local generation"
  story is rented hardware or nothing.
- **Permissions:** one key per page, new keys in **no default bucket** (granting is the launch), and **both**
  editors must be updated in the same commit — `/admin/permissions` (In-sidebar switches) and
  `/admin/roles/[id]` (custom-role matrix). `permissionToggleCoverage.test.ts` enforces it.
- **Portal tokens** used by the mockup are the real ones: light `#f6f8fb / #fff / #0f172a / #3b82f6`, dark
  `#0c1218 / #141f2b / #e1e9f1 / #22a8ff → #4f7bff`, Inter, `data-theme` on `<html>`, 250px sidebar, 54px topbar.
  The Coworker language (step blocks, tool pills, approval cards) is ported from the approved Coworker mockup
  (artifact `9rkPBPFRp6hqQJcYCaSDXG`) so a build can port CSS instead of re-deriving it
  ([[never-claim-a-screen-matches-a-mockup-unproven]]).

## 3. RESEARCH: LICENCES ARE THE CONSTRAINT, NOT QUALITY (checked 2026-09-15, re-check before building)

⛔⛔ **Several of the best-known open models cannot legally be the thing a paying customer's work comes out of.**

- **Safe defaults:** Qwen-Image / Qwen-Image-Edit (Apache-2.0), FLUX.1 schnell and FLUX.2 klein 4B
  (Apache-2.0), BiRefNet background removal (MIT), Real-ESRGAN (BSD-3), Wan 2.2 video (Apache-2.0),
  RIFE interpolation (MIT), ElevenLabs voice/music/SFX (commercial API, already in Loopcom).
- ⛔ **Not usable as a default:** FLUX.1 dev / Kontext dev (non-commercial to *serve*, licence needed),
  SD 3.5 and Stable Audio Open (Stability Community Licence — free only under **$1M** revenue),
  **RMBG-2.0 (CC BY-NC)**, MusicGen (CC BY-NC), HunyuanVideo (**excludes the EU, UK and South Korea**),
  LTX-2 (free only under **$10M** ARR — usable now, but it must be flagged and watched).
- **Hosted video:** Sora 2 ≈ $0.10/s (16–20s per generation, extensions to ~2 min), Kling 3.0 3–15s,
  Runway Gen-4.5 ≈ $0.12/s, Veo 3.1 (pricing/clip length **UNVERIFIED**).
- **Editor:** Polotno is the recommendation — the design is one JSON document with `addElement` / `set` /
  `toJSON` / `loadJSON`, which is exactly what an agent needs, and `polotno-node` renders server-side.
  ⛔ It is **paid** (~$249/mo starter, ~$899/mo self-serve) and needs a licence key in production, and the
  self-serve tier is **one domain** — **Loopcom runs on two hostnames**, so that must be confirmed with them
  or priced as enterprise. Free fallback: Konva or Fabric.js (MIT) and build the UI ourselves.
- **ComfyUI:** GPL-3.0, and **it has no authentication at all** — anyone who can queue a prompt can run
  custom-node Python (see its own SECURITY.md; CVE-2026-6589 is a CSRF in `server.py`). It must never face a
  network, only versioned workflow templates may run, and the Manager add-on stays out of production.
  ⛔ Whether calling it over HTTP from our own service satisfies the GPL is a **lawyer's question**, not an
  engineer's — get a sentence in writing before the GPU phase.
- **GPU rental:** RunPod L40S ≈ $1.09/hr secure, A100 80GB ≈ $1.19–1.59, H100 ≈ $1.99–3.49; Modal similar with
  scale-to-zero.

## 4. THE DESIGN DECISIONS WORTH KEEPING

1. **One document, one revision number.** `CreativeDocument.revision` + an append-only `CreativeOperation`
   log. Agent and human both send ops against a base revision; a stale write is refused (409) and the agent
   re-reads. This is the entire answer to "the agent must understand the current canvas" and it is four
   columns, not a sync engine.
2. **Structured actions only.** The agent edits through operations, never by driving a canvas with a mouse.
   Browser automation is explicitly *not* a fallback here.
3. **No tool blocks for minutes** — jobs return ids (see §2's 900s ceiling).
4. **15 seconds is a Loopcom-level promise, not a model capability.** The engine table normalises native
   lengths; if the engine makes 5s, the orchestrator renders continuing pieces and joins them.
5. **Money always asks.** Every paid job is approved in the chat and checked against a quota server-side.
6. **Memory is seven scopes** (task / user / company / workflow / engine / project / feedback) with
   evidence rows behind every learned statement; personal preferences apply after 3 consistent signals,
   company rules need an admin. The only cross-tenant data is the engine scorecard, and it carries
   **latency, success and cost only — never prompts or content**.
7. ⛔⛔ **The spend approval is drawn by the server, and that is a real weakening** compared with the desktop
   Coworker's local approval window. It is acceptable *here* because the worst case is refundable money and
   deletable content — **it must not be copied back to the desktop hands**, whose approvals are decided on
   the person's own machine by `policyCore.ts`.

## 5. WHAT IS **NOT** TRUE / NOT DONE

- ⏳ Nothing is built. No route, no table, no migration, no dependency, no container, no provider account,
  no permission key, no navConfig entry, no agent tool. The only files added are under `docs/`.
- ⏳ No provider was contacted, no licence bought, no GPU rented, no model downloaded.
- ⏳ Nobody has approved the mockups. **Silence is not approval** — the brief says so explicitly.
- ⏳ The cost figures in the mockup are arithmetic from published prices, not measured spend.
- ⏳ The "on our own machines" engine is drawn as if it exists; it cannot exist until a GPU is rented.

## 6. OPEN DECISIONS FOR IZZY (nothing can start until these are answered)

1. **Design editor:** Polotno ($249–899/mo, confirm the two-hostname question) vs building on Konva/Fabric (MIT, months of work).
2. **Media storage:** Cloudflare R2 (recommended — Cloudflare is already in front of Loopcom, no egress fee) vs another Docker volume.
3. **Which video provider** to open an account with, decided on a real side-by-side of the same three shots.
4. **Whether any of this is charged on to customers** — it changes quotas and possibly the invoice engine.
5. **Who gets it first** — recommendation: Loopcom's own account for Loopcom's own marketing.
6. **The ComfyUI licence question** — only blocks Phase 5.

## 7. PROPOSED PHASES (for when it is approved)

1. Foundations + images (tables, object storage, jobs, permission keys with **both** toggles, brand kit, asset library, image generator, first tools).
2. Design editor (Polotno, shared document + revisions, inspect/modify tools, versions, image export).
3. Video (storyboard, hosted engines, render worker, timeline, voiceover, music, captions, self-evaluation, video export).
4. Learning (feedback capture, memory layers + screen, learned preferences applied at prompt time, engine routing). **Proof required: reject a preference, then show a later generation using it.**
5. Our own GPUs (rented workers, ComfyUI with versioned workflows, open engines, admin workers/queue screens, quotas, cost).
6. Hardening (security review of uploads + FFmpeg, load test, full multi-tenant proof, regression pass).

⛔ Phase gates that must not be skipped: a **cross-company test suite** run as a second tenant against every
new route, and a security review of the upload path and the FFmpeg builder (a playlist can make FFmpeg fetch
URLs — `-protocol_whitelist` is mandatory).

## 8. TESTS RUN

None. This task produced documentation and a disposable prototype; no production code was executed, no suite
was run, and nothing was deployed. Nothing in `TESTS_RUN.md` changed.
