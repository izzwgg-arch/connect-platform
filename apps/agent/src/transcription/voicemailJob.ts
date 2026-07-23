/**
 * Voicemail auto-transcription (Izzy's routing spec):
 *   1. Detect the spoken language with a fast STT pass (whisper verbose JSON —
 *      returns detected language + text in one ~1.5s call).
 *   2. ENGLISH → keep that GPT transcript (fast path, done).
 *   3. YIDDISH (or Hebrew-script/uncertain) → re-transcribe on our own
 *      ivrit RunPod endpoint (Yiddish-tuned model, language forced to yi).
 *
 * Yiddish Labs is NOT in this path at all. Engine names are stored internally
 * (transcriptEngine) for audit but are never surfaced on the frontend.
 *
 * Runs as a poller: scans recent Voicemail rows with no transcript, fetches the
 * audio from the PBX (token-authenticated pbxRecfile path), transcribes, saves.
 * Read-only toward the PBX (a GET of the recording), additive toward the DB.
 */
import { createHmac } from "node:crypto";
import type { AuditLog } from "../audit/audit";

export interface VoicemailJobDeps {
  prisma: any;
  audit: AuditLog;
  openaiApiKey: () => string | null;
  /** Yiddish Labs key — the PRIMARY Yiddish transcription engine (king for
   *  American Yiddish, i.e. Yiddish carrying many English words). */
  yiddishLabsApiKey?: () => string | null;
  /** ivrit.ai (RunPod) — kept as an automatic fallback if Yiddish Labs is down. */
  ivritApiKey: () => string | null;
  ivritEndpointId: () => string | null;
  ivritModel: string;
  /** Internal portal API base (docker net), e.g. http://api:3001 — its stream
   *  endpoint already resolves recfile tokens, spool fallback, and transcode. */
  apiBaseUrl: () => string | null;
  /** Same JWT_SECRET the portal API uses, so we can mint an internal token. */
  jwtSecret: () => string | null;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const MAX_BATCH = 4;
const LOOKBACK_DAYS = 7;
const MAX_AUDIO_BYTES = 6 * 1024 * 1024; // ivrit blob cap safety

const hasHebrew = (s: string) => /[֐-׿]/.test(s);

/**
 * Clean a Yiddish Labs transcript for display: strip the ⟦#N⟧ segment/speaker
 * markers YL embeds, drop stray control brackets, and collapse whitespace.
 * These markers are internal structure, never meant for the reader.
 */
const cleanTranscript = (s: string): string =>
  s
    .replace(/⟦[^⟧]*⟧/g, " ") // ⟦#1⟧ segment markers
    .replace(/[⟦⟧]/g, " ") // any stray bracket halves
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();

export class VoicemailTranscriptionJob {
  private running = false;
  constructor(private deps: VoicemailJobDeps) {}

  /**
   * On-demand: transcribe a single voicemail NOW (the portal Transcribe button).
   * Re-transcribes even if a transcript exists (used for Re-transcribe too).
   * Returns the fresh transcript + detected language.
   */
  async transcribeById(id: string): Promise<{ ok: boolean; transcript?: string; language?: string; error?: string }> {
    const vm = await this.deps.prisma.voicemail.findUnique({
      where: { id },
      select: { id: true, pbxRecfile: true, deletedAt: true },
    });
    if (!vm || vm.deletedAt) return { ok: false, error: "not_found" };
    try {
      await this.transcribeOne({ id: vm.id, pbxRecfile: vm.pbxRecfile ?? "" });
      const row = await this.deps.prisma.voicemail.findUnique({ where: { id }, select: { transcript: true, transcriptLanguage: true } });
      return { ok: true, transcript: row?.transcript ?? "", language: row?.transcriptLanguage ?? undefined };
    } catch (err) {
      await this.deps.prisma.voicemail.update({ where: { id }, data: { transcriptError: String(err).slice(0, 300) } }).catch(() => {});
      return { ok: false, error: String(err).slice(0, 200) };
    }
  }

  /** One polling pass. Returns how many voicemails were processed. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
      const rows = await this.deps.prisma.voicemail.findMany({
        where: { transcript: null, transcriptError: null, deletedAt: null, receivedAt: { gte: since }, pbxRecfile: { not: null } },
        orderBy: { receivedAt: "desc" },
        take: MAX_BATCH,
        select: { id: true, pbxRecfile: true, extension: true, durationSec: true, pbxExtensionId: true, pbxMessageId: true, pbxMsgNum: true, receivedAt: true, tenantId: true },
      });
      let done = 0;
      for (const vm of rows) {
        try {
          await this.transcribeOne(vm);
          done++;
        } catch (err) {
          await this.deps.prisma.voicemail.update({ where: { id: vm.id }, data: { transcriptError: String(err).slice(0, 300) } }).catch(() => {});
          await this.deps.audit.record({ actor: "system", event: "voicemail.transcribe_failed", payload: { id: vm.id, error: String(err).slice(0, 200) } });
        }
      }
      return done;
    } finally {
      this.running = false;
    }
  }

  /** Short-lived internal JWT the portal API accepts (SUPER_ADMIN, 5 min). */
  private mintToken(): string {
    const secret = this.deps.jwtSecret();
    if (!secret) throw new Error("no_jwt_secret");
    const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(Buffer.from(JSON.stringify({ sub: "agent-voicemail", tenantId: "", email: "agent@internal.connect", role: "SUPER_ADMIN", iat: now, exp: now + 300 })));
    const sig = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${sig}`;
  }

  /**
   * Fetch the voicemail audio through the portal API's own stream endpoint,
   * which already handles stale recfile refresh, spool-helper fallback, and
   * transcode. Far more robust than duplicating that resolution here.
   */
  private async fetchAudio(vm: { id: string }): Promise<Buffer> {
    const base = this.deps.apiBaseUrl();
    if (!base) throw new Error("no_api_base_url");
    const token = this.mintToken();
    const url = `${base.replace(/\/$/, "")}/voice/voicemail/${encodeURIComponent(vm.id)}/stream?raw=1&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`audio_fetch_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error("audio_empty");
    if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio_too_large_${buf.length}`);
    return buf;
  }

  /** Fast STT pass: whisper verbose JSON → { text, language }. */
  private async detectPass(buf: Buffer): Promise<{ text: string; language: string }> {
    const key = this.deps.openaiApiKey();
    if (!key) throw new Error("openai_not_configured");
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)]), "vm.wav");
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) throw new Error(`detect_stt_${res.status}:${(await res.text().catch(() => "")).slice(0, 120)}`);
    const j: any = await res.json();
    return { text: (j.text ?? "").trim(), language: (j.language ?? "").toLowerCase() };
  }

  /**
   * Yiddish pass. PRIMARY engine is Yiddish Labs — it is built around American
   * Yiddish (Yiddish spoken with many English words), so heimishe voicemails
   * transcribe far more faithfully than with a generic model. ivrit.ai (our
   * RunPod endpoint) stays as an automatic fallback if YL is unavailable/fails.
   */
  private async yiddishPass(buf: Buffer): Promise<string> {
    // Primary: Yiddish Labs (language forced to Yiddish — this is the Yiddish
    // candidate; pickLanguage still decides whether the call was truly English).
    const ylKey = this.deps.yiddishLabsApiKey?.() ?? null;
    if (ylKey) {
      try {
        const { YiddishLabsClient } = await import("./yiddishlabs");
        const cli = new YiddishLabsClient(ylKey);
        let r = await cli.submitSync({ file: buf, filename: "vm.wav", language: "yi" });
        // Sync returns immediately for short audio; longer jobs may still be
        // processing — poll briefly (up to ~2 min) before giving up.
        for (let i = 0; i < 40 && r.status !== "completed" && r.status !== "failed"; i++) {
          await new Promise((x) => setTimeout(x, 3000));
          r = await cli.get(r.id);
        }
        if (r.status === "completed" && r.text && r.text.trim()) return cleanTranscript(r.text);
      } catch {
        // fall through to ivrit fallback
      }
    }
    // Fallback: ivrit.ai (Yiddish-tuned RunPod model) if YL is down/unconfigured.
    const { EverettClient } = await import("./everett");
    const cli = new EverettClient(this.deps.ivritApiKey(), this.deps.ivritEndpointId(), this.deps.ivritModel);
    const r = await cli.transcribe({ file: buf, language: "yi" });
    if (r.status !== "completed" || !r.text) throw new Error("yiddish_stt_failed");
    return r.text;
  }

  /**
   * Decide which language the caller ACTUALLY spoke, given both candidate
   * transcripts of the same audio.
   *
   * Why not trust Whisper's own language field? Empirically it labels Yiddish
   * audio as "english" and renders it as broken phonetic English, so a single
   * detect pass silently routes Yiddish callers to the English transcript
   * (exactly the bug we're fixing). Instead we transcribe with BOTH engines —
   * an English model and the Yiddish-tuned model — and let a cheap text judge
   * pick the language that reads coherently.
   *
   * This line is a Yiddish-first community line, and the models we can query
   * read English far better than Yiddish, so the judge is deliberately
   * Yiddish-biased: it returns English ONLY when the caller is clearly a native
   * English speaker with clean, natural English. Anything Yiddish, code-switched
   * (Yiddish with English business words), broken, or ambiguous → Yiddish. That
   * makes the only residual error "a short English call tagged Yiddish" — the
   * safe direction here — while every Yiddish call is caught.
   *
   * Returns "en" or "yi". Defaults to "yi" on any uncertainty or error.
   */
  private async pickLanguage(enText: string, yiText: string): Promise<"en" | "yi"> {
    const key = this.deps.openaiApiKey();
    // No English candidate, or no key to judge with → trust the Yiddish engine.
    if (!key || !enText.trim()) return "yi";
    const model = process.env.VOICEMAIL_JUDGE_MODEL || "gpt-4o";
    const sys =
      "You route voicemails on a heimish YIDDISH community phone line. Most callers speak Yiddish, very often mixing in English business words (order, please, ETA, invoice, appointment, processed). Two engines transcribed the SAME voicemail: Engine A = English model, Engine B = Yiddish model. The engine matching what was actually spoken reads coherently; the other is garbled because it forced the wrong language. Answer ENGLISH ONLY IF the caller is clearly a native English speaker using NO Yiddish at all AND Engine A reads as clean, natural, complete English. If there is ANY Yiddish, or Engine A looks broken/phonetic/number-heavy fragments, answer YIDDISH. Reply with EXACTLY one word: ENGLISH or YIDDISH.";
    const user = `Engine A (English model): "${enText.slice(0, 1200)}"\n\nEngine B (Yiddish model): "${yiText.slice(0, 1200)}"`;
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 3, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return "yi";
      const j: any = await res.json();
      const verdict = String(j?.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
      return verdict.startsWith("ENGLISH") ? "en" : "yi";
    } catch {
      return "yi"; // Yiddish-first: never drop a Yiddish call because the judge failed
    }
  }

  private async transcribeOne(vm: { id: string; pbxRecfile: string; pbxExtensionId?: string | null; pbxMessageId?: string; pbxMsgNum?: string | null; receivedAt?: Date; tenantId?: string | null }): Promise<void> {
    const buf = await this.fetchAudio(vm);

    // Transcribe with BOTH engines in parallel: the English model (Whisper/GPT)
    // and the Yiddish-tuned model (ivrit). Each renders the audio in its own
    // language — the one matching the spoken language reads coherently, the
    // other is forced/garbled — then pickLanguage() chooses the spoken language.
    const [enR, yiR] = await Promise.allSettled([this.detectPass(buf), this.yiddishPass(buf)]);
    const enText = enR.status === "fulfilled" ? enR.value.text : "";
    const yiText = yiR.status === "fulfilled" ? yiR.value : "";

    let transcript: string;
    let language: string;
    let engine: string; // internal tags only — never shown on the frontend

    if (!yiText && !enText) {
      throw new Error("both_stt_failed");
    } else if (!yiText) {
      // Yiddish engine unavailable → keep the English text so we have something.
      transcript = enText;
      language = "en";
      engine = "stt-en-fallback";
    } else if (!enText) {
      transcript = yiText;
      language = "yi";
      engine = "stt-yi";
    } else {
      const spoke = await this.pickLanguage(enText, yiText);
      if (spoke === "en") {
        transcript = enText;
        language = "en";
        engine = "stt-en";
      } else {
        transcript = yiText;
        language = hasHebrew(yiText) && /[a-z]/i.test(yiText) ? "yi-en" : "yi";
        engine = "stt-yi";
      }
    }

    await this.deps.prisma.voicemail.update({
      where: { id: vm.id },
      data: { transcript, transcriptLanguage: language, transcriptEngine: engine, transcribedAt: new Date(), transcriptError: null },
    });
    await this.deps.audit.record({
      actor: "system",
      event: "voicemail.transcribed",
      payload: { id: vm.id, language, engine, chars: transcript.length },
    });
  }
}
