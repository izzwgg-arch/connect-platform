# Yiddish Voice Lab: a design for building a proprietary Yiddish voice dataset (2026-09-15), DESIGN ONLY

Full handoff: **`docs/ai-context/AGENT_HANDOFF_YIDDISH_VOICE_LAB_2026-09-15.md`**.
Mockups: `docs/mockups/yiddish-voice-lab/voice-lab.html` (artifact https://claude.ai/artifact/Kxy7NSV8CPw41B7se2NcLp, 14 screens).

- ⛔ **The "Yiddish Labs → OpenAI voice testing system we just built" did not exist.** It is on no branch, worktree or stash, and in no Claude or Codex session. `studio.ts` render is a stub; Laybel uses the browser's own voice. Izzy chose "design from scratch: plan plus one real sample, then stop."
- ⛔⛔ **Yiddish Labs output may never train or fine-tune a model.** This is the recorded policy (`docs/ai-support-agent/YL_NO_TRAINING_POLICY.md`, `corpus.ts` `TRAINING_FORBIDDEN_MODELS`). Consequences for the design:
  - YL-sourced text is forced to SERVING_ONLY and excluded from every training export.
  - Training-eligible data must be human-authored or human-verified text, or consented human audio.
  - Evaluation, A/B and prompt tuning on YL text is judged a serving use. **Ask YL in writing before any fine-tune export.**
- **Design:** four layers, each stored separately: YL source text → speech-layer prepared text (one audit step per rule) → exact provider request → audio. The tables are normalized and provider-neutral:
  - immutable config versions, and dictionary entries with revisions, contextual rules and per-provider realizations (respelling or instruction hint for OpenAI; IPA always stored);
  - ratings with optional categories, word corrections, prosody marks, A/B comparisons with randomized sides, golden/rejected with reasons;
  - regression suites and runs, optimizer proposals that never self-promote, neutral JSONL export;
  - consent-gated reference audio (future), and retention that deletes audio only, never metadata.
- **Placement:**
  - Code: api `apps/api/src/voice/yiddishVoiceLab/`.
  - Audio: volume `voice-lab-audio`.
  - Page: `/admin/voice-lab`, key `can_view_admin_voice_lab`, owner-only fixed, gated on the SUPER_ADMIN JWT. ⛔ Not the agent's `requireOwner`, which also lets TENANT_ADMIN in.
- **OpenAI reality:**
  - mini-tts `instructions` works.
  - No SSML, phonemes or lexicons, and no speech fine-tuning.
  - Custom voices are sales-gated behind consent recordings (no Hebrew or Yiddish).
  - Yiddish isn't a listed language.
- ✅ **First real sample ran** (4 clips, gpt-4o-mini-tts, voice cedar, two cached YL sentences × plain/guided). All 200, 1.8–2.6 s. Guided clips run 10–14% longer. Files were sent to Izzy. ⏳ **His ear verdict is pending**; no quality claim until then.
- ⏳ Nothing built, migrated or deployed.
