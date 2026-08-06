/**
 * Amazon Polly text-to-speech for IVR greetings.
 *
 * A second voice source alongside ElevenLabs, deliberately shaped the same way:
 * ask for phone-native 8 kHz mono PCM, hand back raw PCM plus the rate it
 * actually arrived at, and let the caller wrap it in a WAV header. By the time
 * audio reaches Asterisk, a Polly greeting and an ElevenLabs one are the same
 * kind of thing — only the row's `source` differs.
 *
 * Why the request signing is written out by hand
 * ──────────────────────────────────────────────
 * The obvious move is `@aws-sdk/client-polly`. It is also a large dependency
 * tree added to a container that has already been taken down once by an
 * undeclared import (`undici`, guarded now by dependencyHygiene.test.ts). Polly
 * is two plain HTTPS calls — DescribeVoices and SynthesizeSpeech — and AWS
 * Signature V4 is about forty lines of node:crypto. Hand-rolling it keeps
 * apps/api's dependency list untouched, which is worth more here than the SDK's
 * conveniences.
 *
 * Credentials are never returned to a caller and never logged, here or anywhere.
 */

import crypto from "node:crypto";
import { Buffer } from "node:buffer";

/** Same ceiling as the ElevenLabs path. Polly bills per character and a phone
 *  greeting is never this long. (Polly's own hard limit is 3,000 billed
 *  characters per request, so this stays comfortably inside it.) */
export const MAX_POLLY_CHARS = 2_500;

/** Synthesis of a long greeting is genuinely slow; metadata calls that gate a
 *  page load are not, and should not be allowed to hang one. */
const REQUEST_TIMEOUT_MS = 60_000;
const METADATA_TIMEOUT_MS = 15_000;

const SERVICE = "polly";

export interface PollyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Only set when someone is using temporary STS credentials. */
  sessionToken?: string | null;
}

export interface PollyVoice {
  voiceId: string;
  name: string;
  gender: string | null;
  languageCode: string | null;
  languageName: string | null;
  /** "standard" | "neural" | "long-form" | "generative" — a voice supports some
   *  subset, and asking for one it doesn't support is a 400. */
  engines: string[];
}

/**
 * Polly's engines, in the terms someone setting up a phone menu cares about.
 *
 * Neural is the default rather than standard: the price difference is
 * irrelevant at greeting lengths, and standard voices are noticeably more
 * robotic — which is the whole reason a business puts off recording a greeting.
 */
export const POLLY_ENGINES = [
  { id: "neural", label: "Natural", detail: "The best all-round choice. Clear and human on a phone line." },
  { id: "standard", label: "Basic", detail: "Cheapest and most robotic. Available on every voice." },
  { id: "long-form", label: "Long-form", detail: "For longer messages. Only some voices offer it." },
  { id: "generative", label: "Most expressive", detail: "The most lifelike, on the few voices that support it." },
] as const;

export type PollyEngineId = (typeof POLLY_ENGINES)[number]["id"];

export function isPollyEngineId(v: unknown): v is PollyEngineId {
  return POLLY_ENGINES.some((e) => e.id === v);
}

/** Speaking speed, expressed the way the recording modal already expresses it.
 *  Slightly slower than natural: callers are listening for a number to press,
 *  often in traffic, often on a bad line. */
export const POLLY_DEFAULT_SPEED = 0.95;

export class PollyError extends Error {
  /** Safe for a customer — see the constructor note. */
  readonly customerMessage: string;

  constructor(
    message: string,
    readonly httpStatus: number,
    /**
     * For Connect staff. Never contains the credentials, but it DOES name the
     * provider and our account state — so it is not for a customer's eyes.
     * Route handlers choose by role; see `customerMessage`.
     */
    readonly userMessage: string,
    /** AWS's own exception name ("InvalidSignatureException",
     *  "ThrottlingException", …) when they sent one. Lets callers branch on the
     *  actual reason rather than a status code that means several things. */
    readonly providerCode: string = "",
    /** Safe for a customer. Defaults to `userMessage`, which is right for the
     *  errors we raise ourselves ("type the greeting first") because those are
     *  about what the customer just did. Provider failures pass a neutral one. */
    customerMessage?: string,
    /** Our account or our supplier — not the customer, and not their fault. */
    readonly ourProblem: boolean = false,
  ) {
    super(message);
    this.name = "PollyError";
    this.customerMessage = customerMessage ?? userMessage;
  }
}

/** What a customer is told when the problem is ours. Never names the supplier
 *  and never mentions our AWS account or its billing. */
const CUSTOMER_UNAVAILABLE = "Making recordings isn't available right now. You can upload your own recording instead, or try again later.";
const CUSTOMER_BUSY = "The voice service is busy right now. Try again in a moment.";

// ── AWS Signature V4 ─────────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS wants two forms of the same instant: 20260805T142530Z and 20260805. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Build the Authorization header for one request.
 *
 * Exported for the test suite: signing is the one part of this file that fails
 * silently-but-totally (every call comes back 403 with an unhelpful message),
 * so it is worth being able to assert the canonical form directly rather than
 * only through a live call.
 */
export function signRequest(input: {
  credentials: PollyCredentials;
  method: string;
  path: string;
  /** Already-encoded and sorted, or "" — Polly's two calls use at most one. */
  query: string;
  body: string;
  host: string;
  now?: Date;
}): Record<string, string> {
  const { credentials, method, path, query, body, host } = input;
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  if (body) headers["content-type"] = "application/json";

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, credentials.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** AWS puts the exception name in a header and (usually) in the body's `__type`. */
function providerCodeOf(res: Response, body: string): string {
  const header = res.headers.get("x-amzn-errortype") || "";
  const fromHeader = header.split(":")[0].trim();
  if (fromHeader) return fromHeader;
  try {
    const j = JSON.parse(body);
    return String(j?.__type || j?.code || "").split("#").pop() || "";
  } catch {
    return "";
  }
}

/**
 * Turn a provider failure into something a non-technical person can act on.
 *
 * The status code alone is not enough — Polly answers 400 for a validation
 * problem the customer caused (text too long) and 400 for one they can do
 * nothing about (this voice has no neural version). The exception name is what
 * separates them, so it is read first.
 */
function explain(code: string, status: number, body: string): string {
  switch (code) {
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "IncompleteSignature":
      return "Amazon rejected the access key or secret. Check both on the Amazon Polly page — a trailing space when pasting is the usual cause.";
    case "AccessDeniedException":
      return "These Amazon credentials are valid but not allowed to use Polly. The IAM user or role needs the polly:SynthesizeSpeech and polly:DescribeVoices permissions.";
    case "ThrottlingException":
    case "TooManyRequestsException":
      return "Amazon is rate-limiting us right now. Try again in a moment.";
    case "TextLengthExceededException":
      return `That's longer than a phone greeting should be (max ${MAX_POLLY_CHARS} characters).`;
    case "InvalidSsmlException":
      return "Amazon couldn't read that text. Try removing unusual characters.";
    case "EngineNotSupportedException":
      return "That voice doesn't offer the quality setting you picked. Choose another voice or another quality.";
    case "InvalidSampleRateException":
      return "Amazon refused the audio format for this voice. Try a different voice.";
    case "ServiceFailureException":
      return "Amazon Polly is having trouble at their end. Try again shortly.";
    default:
      break;
  }
  if (status === 403) return "Amazon rejected these credentials. Check them on the Amazon Polly page.";
  if (status === 429) return "Amazon is rate-limiting us right now. Try again in a moment.";
  if (status >= 500) return "Amazon Polly is having trouble at their end. Try again shortly.";
  if (status === 400 && /region/i.test(body)) return "That AWS region doesn't look right. Check it on the Amazon Polly page.";
  return "Couldn't generate the audio. Nothing was changed.";
}

/**
 * The same failure, told to a customer.
 *
 * Never names the supplier and never mentions our account. The exception is
 * text the customer typed — that is genuinely theirs to fix, and hiding it
 * would leave them stuck with no way forward.
 */
function explainForCustomer(code: string, status: number): { message: string; ourProblem: boolean } {
  if (code === "TextLengthExceededException") {
    return { message: `That's longer than a phone greeting should be (max ${MAX_POLLY_CHARS} characters).`, ourProblem: false };
  }
  if (code === "InvalidSsmlException") {
    return { message: "Some of that text couldn't be read. Try removing unusual characters.", ourProblem: false };
  }
  if (code === "EngineNotSupportedException" || code === "InvalidSampleRateException") {
    return { message: "That voice can't be used for this. Pick a different one.", ourProblem: false };
  }
  if (code === "ThrottlingException" || code === "TooManyRequestsException" || status === 429) {
    return { message: CUSTOMER_BUSY, ourProblem: false };
  }
  return { message: CUSTOMER_UNAVAILABLE, ourProblem: true };
}

async function call(
  credentials: PollyCredentials,
  init: { method: "GET" | "POST"; path: string; query?: string; body?: unknown; timeoutMs?: number },
): Promise<Response> {
  const host = `polly.${credentials.region}.amazonaws.com`;
  const body = init.body ? JSON.stringify(init.body) : "";
  const query = init.query ?? "";
  const headers = signRequest({ credentials, method: init.method, path: init.path, query, body, host });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}${init.path}${query ? `?${query}` : ""}`, {
      method: init.method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read at most a snippet: the body is only ever used to classify, never
      // shown verbatim.
      const text = (await res.text().catch(() => "")).slice(0, 400);
      const code = providerCodeOf(res, text);
      const forCustomer = explainForCustomer(code, res.status);
      throw new PollyError(
        `polly_${res.status}`,
        res.status,
        explain(code, res.status, text),
        code,
        forCustomer.message,
        forCustomer.ourProblem,
      );
    }
    return res;
  } catch (err: any) {
    if (err instanceof PollyError) throw err;
    if (err?.name === "AbortError") {
      throw new PollyError("polly_timeout", 504, "Amazon Polly took too long to answer. Try again.", "", "The voice service took too long to answer. Try again.", true);
    }
    // A wrong region produces a DNS failure rather than an HTTP error, and
    // "couldn't reach Amazon" would send someone to check their internet.
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(String(err?.message || err?.cause?.code || ""));
    throw new PollyError(
      `polly_unreachable: ${err?.message}`,
      502,
      dns
        ? `Couldn't reach Amazon Polly in region "${credentials.region}". Check the region on the Amazon Polly page.`
        : "Couldn't reach Amazon Polly.",
      "",
      "Couldn't reach the voice service. Try again shortly.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short-lived cache for the voice list.
 *
 * The status endpoint is hit every time the recording modal or the Polly page
 * opens. Half a minute makes those opens instant and stops a refresh storm from
 * tripping AWS's rate limiter, while still being short enough that a
 * just-corrected key shows its effect while someone is looking at the page.
 * Only successes are cached — a failure must stay a live question, or fixing
 * the credentials would keep reporting the old failure for thirty seconds.
 */
const READ_CACHE_MS = 30_000;
const voicesCache = new Map<string, { at: number; value: PollyVoice[] }>();

/** Tests (and a credentials change mid-session) need a clean slate. */
export function clearPollyReadCaches(): void {
  voicesCache.clear();
}

function cacheKeyFor(c: PollyCredentials): string {
  // Never the secret: a cache key ends up in memory dumps and, one careless log
  // line later, in a log file.
  return `${c.accessKeyId}@${c.region}`;
}

export interface PollyCheck {
  /** The credentials are real and Polly answered. */
  ok: boolean;
  /** Reachable AND able to synthesise right now. */
  usable?: boolean;
  voiceCount?: number;
  region?: string;
  /** Present whenever `usable` is false — always says what to do about it.
   *  Written for Connect staff: it names the provider and our account state. */
  userMessage?: string;
  /** The same situation told to a customer — no provider, no billing, no keys. */
  customerMessage?: string;
  /** Our account or supplier, not anything the customer did. */
  ourProblem?: boolean;
}

/**
 * Are these credentials real, AND can the account actually make a recording?
 *
 * Polly has no subscription endpoint to ask, and no separate "is billing OK"
 * signal — DescribeVoices succeeding with credentials that carry the Polly
 * permissions is the whole answer available. So `ok` and `usable` move together
 * here, unlike ElevenLabs where a valid key on an unpaid account is
 * `ok: true, usable: false`. The shape is kept identical anyway so both
 * providers can be handled by the same UI code.
 */
export async function checkPollyCredentials(credentials: PollyCredentials): Promise<PollyCheck> {
  try {
    const voices = await listPollyVoices(credentials);
    if (voices.length === 0) {
      return {
        ok: true,
        usable: false,
        voiceCount: 0,
        region: credentials.region,
        userMessage: `Amazon answered, but returned no voices for region "${credentials.region}". Try a different region.`,
        customerMessage: CUSTOMER_UNAVAILABLE,
        ourProblem: true,
      };
    }
    return { ok: true, usable: true, voiceCount: voices.length, region: credentials.region };
  } catch (err: any) {
    return {
      ok: false,
      usable: false,
      region: credentials.region,
      userMessage: err?.userMessage || "Couldn't check the Amazon credentials.",
      customerMessage: err?.customerMessage || CUSTOMER_UNAVAILABLE,
      ourProblem: err?.ourProblem ?? true,
    };
  }
}

export async function listPollyVoices(credentials: PollyCredentials): Promise<PollyVoice[]> {
  const key = cacheKeyFor(credentials);
  const hit = voicesCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.value;
  if (hit) voicesCache.delete(key);

  // DescribeVoices pages, but Polly's whole catalogue is well under one page
  // (a few hundred voices) and the page size is 60 by default — so follow
  // NextToken rather than silently showing the first sixty.
  const voices: PollyVoice[] = [];
  let nextToken: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const query = nextToken ? `NextToken=${encodeURIComponent(nextToken)}` : "";
    const res = await call(credentials, { method: "GET", path: "/v1/voices", query, timeoutMs: METADATA_TIMEOUT_MS });
    const j: any = await res.json();
    for (const v of Array.isArray(j?.Voices) ? j.Voices : []) {
      const voiceId = String(v?.Id ?? "");
      if (!voiceId) continue;
      voices.push({
        voiceId,
        name: String(v?.Name ?? voiceId),
        gender: typeof v?.Gender === "string" ? v.Gender : null,
        languageCode: typeof v?.LanguageCode === "string" ? v.LanguageCode : null,
        languageName: typeof v?.LanguageName === "string" ? v.LanguageName : null,
        engines: Array.isArray(v?.SupportedEngines) ? v.SupportedEngines.map((e: unknown) => String(e)) : [],
      });
    }
    nextToken = typeof j?.NextToken === "string" && j.NextToken ? j.NextToken : null;
    if (!nextToken) break;
  }

  // One entry exists in practice; the bound is a leak guard for credential churn.
  if (voicesCache.size > 8) voicesCache.clear();
  voicesCache.set(key, { at: Date.now(), value: voices });
  return voices;
}

/** XML-escape, so an apostrophe or ampersand in a greeting can't break the SSML
 *  wrapper (or, worse, be read aloud as markup). */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Synthesise a greeting.
 *
 * Returns raw PCM plus the sample rate it actually came back at, because the
 * caller has to wrap it in a WAV header and only it knows the rate for certain
 * — asking for 8 kHz does not guarantee getting it for every voice and engine.
 */
export async function synthesisePollySpeech(
  credentials: PollyCredentials,
  input: { voiceId: string; text: string; engine?: PollyEngineId; speed?: number; languageCode?: string | null },
): Promise<{ pcm: Buffer; sampleRate: number; engine: PollyEngineId }> {
  const text = String(input.text ?? "").trim();
  if (!text) throw new PollyError("empty_text", 400, "There's nothing to say — type the greeting first.");
  if (text.length > MAX_POLLY_CHARS) {
    throw new PollyError("text_too_long", 400, `That's longer than a phone greeting should be (max ${MAX_POLLY_CHARS} characters).`);
  }
  if (!input.voiceId) throw new PollyError("no_voice", 400, "Pick a voice first.");

  const engine: PollyEngineId = isPollyEngineId(input.engine) ? input.engine : "neural";

  // Polly has no speed parameter — rate is SSML only. At exactly 1.0 send plain
  // text instead, so an unremarkable greeting never fails on an SSML quirk.
  const speed = Math.min(1.2, Math.max(0.7, Number(input.speed) || POLLY_DEFAULT_SPEED));
  const usesSsml = Math.abs(speed - 1) > 0.001;
  const payloadText = usesSsml
    ? `<speak><prosody rate="${Math.round(speed * 100)}%">${escapeXml(text)}</prosody></speak>`
    : text;

  const body: Record<string, unknown> = {
    Text: payloadText,
    TextType: usesSsml ? "ssml" : "text",
    VoiceId: input.voiceId,
    Engine: engine,
    OutputFormat: "pcm",
  };
  if (input.languageCode) body.LanguageCode = input.languageCode;

  // Ask for phone-native 8 kHz first. If this voice/engine won't produce it,
  // fall back to 16 kHz rather than failing the whole request — one downsample
  // by ffmpeg is a far better outcome for the customer than an error.
  for (const rate of [8000, 16000] as const) {
    try {
      const res = await call(credentials, {
        method: "POST",
        path: "/v1/speech",
        body: { ...body, SampleRate: String(rate) },
      });
      const pcm = Buffer.from(await res.arrayBuffer());
      if (pcm.length === 0) {
        throw new PollyError("empty_audio", 502, "Amazon Polly returned no audio. Try again.", "", "No audio came back. Try again.", true);
      }
      return { pcm, sampleRate: rate, engine };
    } catch (err: any) {
      // Only the sample rate is worth retrying. Bad credentials also answer
      // 400/403 — asking again at 16 kHz cannot help, and the second failure
      // is what buries the first, useful message.
      const canRetryAtHigherRate =
        rate === 8000 &&
        err instanceof PollyError &&
        (err.providerCode === "InvalidSampleRateException" ||
          (err.httpStatus === 400 && /sample.?rate/i.test(err.message + err.userMessage)));
      if (!canRetryAtHigherRate) throw err;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new PollyError("polly_no_format", 502, "Couldn't generate the audio. Nothing was changed.");
}
