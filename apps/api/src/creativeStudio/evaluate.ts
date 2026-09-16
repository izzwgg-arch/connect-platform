/**
 * Creative Studio — looking at the result before the customer does.
 *
 * Generators fail in recognisable ways: six fingers, a melted face, garbled
 * lettering, a product that has changed shape. A person spots it instantly; so
 * does a vision model. So every picture and every shot is looked at before it
 * is handed over, and an obviously broken one is re-rendered rather than shown.
 *
 * ⛔ THE RULES THAT KEEP THIS FROM BECOMING A MONEY PIT OR A NAG:
 *   - it runs at most ONCE per attempt and the job retries at most twice;
 *   - it only rejects on things it is confident about — "a bit boring" is not a
 *     defect, a hand with six fingers is;
 *   - if the checker itself fails (no key, timeout, bad JSON) the result is
 *     PASSED, not failed: never hold a good picture hostage to our own checker;
 *   - the verdict is stored on the generation record, so "why did it re-do
 *     that?" always has an answer.
 */
import path from "path";
import { promises as fs } from "fs";
import { resolveCreativeSecret } from "./engines";
import * as media from "./media";

export interface EvaluationProblem {
  kind: string;
  detail: string;
  severity: "minor" | "serious";
}

export interface Evaluation {
  ok: boolean;
  checked: boolean;
  problems: EvaluationProblem[];
  note?: string;
  ms?: number;
  model?: string;
}

const PASS_UNCHECKED: Evaluation = { ok: true, checked: false, problems: [], note: "not checked" };

/** What we ask the model to look for, in the order a person would notice it. */
const CHECKLIST = [
  "hands and fingers (count them: six fingers, fused or missing fingers are a SERIOUS defect)",
  "faces (melted, asymmetric, or a second face where there should be one)",
  "any text or lettering in the picture (garbled, misspelled or nonsense letters are SERIOUS)",
  "logos or brand marks that should not be there at all",
  "objects that are physically impossible or that merge into each other",
  "the subject being cut off badly at the frame edge",
];

function buildPrompt(intent: string): string {
  return [
    "You are checking one generated picture before it is shown to the customer who asked for it.",
    `They asked for: "${intent.slice(0, 400)}"`,
    "",
    "Look for these, in order:",
    ...CHECKLIST.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Judge ONLY what is objectively wrong. Taste is not a defect: do not report that it is boring,",
    "that the colours could be nicer, or that you would have composed it differently. If the picture is",
    "usable by a small business, it passes.",
    "",
    'Answer with JSON only: {"ok": true|false, "problems": [{"kind": "hands|face|text|logo|object|framing",',
    '"detail": "<one short sentence>", "severity": "minor|serious"}]}',
    'Set ok=false ONLY if there is at least one "serious" problem.',
  ].join("\n");
}

async function askVision(key: string, model: string, prompt: string, dataUrl: string, timeoutMs: number): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ],
          },
        ],
        // ⛔ REASONING TOKENS COUNT AGAINST THIS. Proven on production: with 400
        // the model spent the whole budget thinking, returned EMPTY content and
        // every check came back "could not answer" — so nothing was ever really
        // looked at. A trivial one-line prompt already burned 192 reasoning
        // tokens; a six-point checklist on a real frame needs far more room.
        max_completion_tokens: 2000,
      }),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (!text) return null;
    // The answer may arrive fenced (```json … ```); take the object itself.
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A still to look at: the picture itself, or a frame from the middle of a clip. */
async function frameFor(kind: string, buffer: Buffer): Promise<Buffer | null> {
  if (kind !== "video") return buffer;
  try {
    return await media.withTempDir(async (dir) => {
      const src = path.join(dir, "clip.mp4");
      await fs.writeFile(src, buffer);
      const info = await media.probe(src).catch(() => ({ durationMs: 2000 } as any));
      const at = Math.max(0.2, Math.min(10, (info.durationMs || 2000) / 2000));
      const out = path.join(dir, "frame.jpg");
      await media.thumbnail(src, out, at);
      return fs.readFile(out);
    });
  } catch {
    return null;
  }
}

export interface EvaluateInput {
  db: any;
  kind: "image" | "video";
  buffer: Buffer;
  mime: string;
  /** What the person actually asked for, for context. */
  intent: string;
  model?: string;
  timeoutMs?: number;
}

export async function evaluateOutput(input: EvaluateInput): Promise<Evaluation> {
  const started = Date.now();
  const key = await resolveCreativeSecret(input.db, "openai_api_key");
  if (!key) return PASS_UNCHECKED;

  const frame = await frameFor(input.kind, input.buffer);
  if (!frame) return { ...PASS_UNCHECKED, note: "could not read a frame to check" };

  // Keep the payload small: a low-detail look is enough to spot a broken hand,
  // and a 2 MB base64 upload per generation is not.
  let look = frame;
  if (frame.length > 900_000) {
    look = await media
      .withTempDir(async (dir) => {
        const src = path.join(dir, "in.png");
        const out = path.join(dir, "small.jpg");
        await fs.writeFile(src, frame);
        await media.convertImage(src, out, { width: 768, quality: 6 });
        return fs.readFile(out);
      })
      .catch(() => frame);
  }

  // gpt-5-mini sees as well as its bigger sibling for "are these hands right?"
  // and thinks for a fraction of the tokens, which is the whole cost of this
  // check. Overridable per install.
  const model = input.model || process.env.CREATIVE_EVAL_MODEL || "gpt-5-mini";
  const dataUrl = `data:${look === frame && input.kind === "image" ? input.mime : "image/jpeg"};base64,${look.toString("base64")}`;
  const parsed = await askVision(key, model, buildPrompt(input.intent), dataUrl, input.timeoutMs ?? 60_000);

  // ⛔ A checker that cannot answer must never block a good result.
  if (!parsed || typeof parsed.ok !== "boolean") return { ...PASS_UNCHECKED, note: "the checker could not answer", ms: Date.now() - started };

  const problems: EvaluationProblem[] = Array.isArray(parsed.problems)
    ? parsed.problems
        .filter((p: any) => p && typeof p.detail === "string")
        .slice(0, 6)
        .map((p: any) => ({
          kind: String(p.kind || "other").slice(0, 20),
          detail: String(p.detail).slice(0, 200),
          severity: p.severity === "serious" ? "serious" : "minor",
        }))
    : [];

  const serious = problems.filter((p) => p.severity === "serious");
  return {
    ok: parsed.ok !== false && serious.length === 0,
    checked: true,
    problems,
    ms: Date.now() - started,
    model,
    note: serious.length ? serious[0].detail : undefined,
  };
}

/**
 * What to say to the person when we re-did something. Plain English, and it
 * names the real reason — "the hand came out wrong", never "evaluation failed".
 */
export function describeRetry(evaluation: Evaluation): string {
  const first = evaluation.problems.find((p) => p.severity === "serious") || evaluation.problems[0];
  if (!first) return "That one came out wrong, so I did it again.";
  const byKind: Record<string, string> = {
    hands: "the hands came out wrong",
    face: "the face came out wrong",
    text: "the lettering came out garbled",
    logo: "a logo appeared that should not be there",
    object: "something in it was misshapen",
    framing: "the subject was badly cut off",
  };
  return `${byKind[first.kind] || first.detail}, so I did it again`;
}

/** Negative wording added to the retry so the same fault is less likely twice. */
export function retryHint(evaluation: Evaluation): string {
  const kinds = new Set(evaluation.problems.map((p) => p.kind));
  const bits: string[] = [];
  if (kinds.has("hands")) bits.push("hands with exactly five fingers, clearly separated, natural pose");
  if (kinds.has("face")) bits.push("one clear symmetrical face, natural features");
  if (kinds.has("text")) bits.push("no text or lettering anywhere in the image");
  if (kinds.has("logo")) bits.push("no logos or brand marks of any kind");
  if (kinds.has("object")) bits.push("solid, correctly proportioned objects");
  if (kinds.has("framing")) bits.push("the subject fully inside the frame with room around it");
  return bits.join(", ");
}
