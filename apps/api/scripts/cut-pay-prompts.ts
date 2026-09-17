/**
 * Cuts the 11 pay-line prompts added 2026-09-17 (PAY_PROMPTS_ADDED_2026_09_17)
 * through Amazon Polly, voice Stephen / neural — the same voice as the existing
 * stephen-neural set — and writes each as an 8-bit-safe 16-bit PCM WAV named
 * <ref>.wav into an output directory.
 *
 * Run from apps/api inside the api container (needs DB access for the stored
 * Polly credentials):
 *   npx tsx scripts/cut-pay-prompts.ts [outDir]
 *
 * Prints one line per file: ref, sample rate, bytes, duration seconds.
 * Exits non-zero on any failure (missing credentials, a Polly error, or a
 * write failure) — nothing partial should be reported as done.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@connect/db";
import { PAY_PROMPTS_ADDED_2026_09_17, PAY_POLLY_VOICE_ID, PAY_POLLY_ENGINE } from "../src/supermarket/payPrompts";
import { synthesisePollySpeech, PollyError } from "../src/voice/polly";
import { resolvePollyCredentials } from "../src/voice/pollyCredentials";
import { pcmToWav, pcmDurationSeconds } from "../src/voice/elevenLabs";

async function main() {
  const outDir = process.argv[2] || "./pay-prompts-out";
  mkdirSync(outDir, { recursive: true });

  const credentials = await resolvePollyCredentials(db);
  if (!credentials) {
    console.error("FATAL: no Polly credentials configured (AgentSecret 'polly_credentials' is empty and no env fallback is set).");
    process.exit(1);
  }

  const specs = PAY_PROMPTS_ADDED_2026_09_17;
  console.log(`Cutting ${specs.length} prompts, voice=${PAY_POLLY_VOICE_ID} engine=${PAY_POLLY_ENGINE}, region=${credentials.region}`);

  let failures = 0;
  for (const spec of specs) {
    try {
      const isSsml = typeof spec.ssml === "string" && spec.ssml.length > 0;
      const { pcm, sampleRate } = await synthesisePollySpeech(credentials, {
        voiceId: PAY_POLLY_VOICE_ID,
        text: isSsml ? (spec.ssml as string) : spec.text,
        engine: PAY_POLLY_ENGINE,
        ssml: isSsml,
      });
      const wav = pcmToWav(pcm, sampleRate);
      const outPath = join(outDir, `${spec.ref}.wav`);
      writeFileSync(outPath, wav);
      const durationSec = pcmDurationSeconds(pcm, sampleRate);
      console.log(`OK  ${spec.ref}.wav  sampleRate=${sampleRate}  bytes=${wav.length}  duration=${durationSec}s`);
    } catch (err: any) {
      failures += 1;
      if (err instanceof PollyError) {
        console.error(`FAIL ${spec.ref}: polly_${err.httpStatus} providerCode=${err.providerCode} — ${err.userMessage}`);
      } else {
        console.error(`FAIL ${spec.ref}: ${err?.message || err}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`${failures} of ${specs.length} prompts failed.`);
    process.exit(1);
  }
  console.log(`All ${specs.length} prompts cut successfully into ${outDir}`);
}

main().catch((err) => {
  console.error("FATAL:", err?.stack || err);
  process.exit(1);
});
