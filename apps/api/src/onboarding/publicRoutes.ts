import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { z } from "zod";
import type { OnboardingStatus } from "@prisma/client";
import { friendlySubmitError, isReusableTemplate, isSubmissionWriteBlocked, publicApplyNumberSchema, publicSaveSchema, publicSubmitSchema } from "./validation";
import { prepareOnboardingCheckout, quoteForSubmission } from "./onboardingPayment";
import { quoteInputForSubmission, isTollFreeNumberKind } from "./quoteInput";
import { describeQuote, quoteOnboarding } from "@connect/shared";
import { decryptJson } from "@connect/security";
import { VoipMsNumberProvider, type VoipMsCredentials } from "@connect/integrations";
import { applyOnboardingNumber, syncOnboardingSms, listSpareDids } from "./voipMsProvisioning";
import { runOnboardingSetup, resumeSetupIfSubmitted } from "./setupOrchestrator";
import { isSetupStalled } from "./setupWatchdog";
import { toPublicUrl } from "./provisioning";
import { resolveOnboardingStoragePath } from "./storage";
import { recordLinkOpened, recordJourneyBeacon } from "./journeyTracking";

// Journey-beacon payload (see journeyTracking.ts for how each becomes a line).
const publicTrackSchema = z.object({
  kind: z.enum(["step_viewed", "validation_blocked", "number_search", "portability", "went_back"]),
  step: z.string().max(60).optional(),
  fromStep: z.string().max(60).optional(),
  seconds: z.number().int().min(0).max(86_400).optional(),
  detail: z.string().max(300).optional(),
  count: z.number().int().min(-1).max(100_000).optional(),
});

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140) || "upload.bin";
}

function buildStorageKey(submissionId: string, original: string): string {
  const ts = Date.now();
  const safe = sanitizeFileName(original);
  return `onboarding/${submissionId}/${ts}_${safe}`;
}

async function ensureRowForToken(token: string): Promise<any | null> {
  const row = await (db as any).onboardingSubmission.findFirst({ where: { publicToken: token } });
  return row || null;
}

/** Master (reseller) VoIP.ms account used to search & buy numbers during onboarding. */
async function loadGlobalVoipMsCreds(): Promise<VoipMsCredentials | null> {
  const row = await (db as any).globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    const c = decryptJson<any>(row.credentialsEncrypted);
    if (!c?.username || !c?.password) return null;
    return { username: c.username, password: c.password, fromNumber: c.fromNumber || "", apiBaseUrl: row.apiBaseUrl || c.apiBaseUrl };
  } catch {
    return null;
  }
}

function isProduction(): boolean {
  return String(process.env.NODE_ENV || "development") === "production";
}

function canLazyCreate(): boolean {
  return !isProduction();
}

function generatePublicToken(bytes: number = 24): string {
  // 32+ URL-safe chars
  return randomBytes(bytes).toString("base64url");
}

/** Phone-keypad letters → digits ("PIZZA" → "74992"); digits pass through. */
function vanityToDigits(word: string): string {
  const keypad: Record<string, string> = {
    a: "2", b: "2", c: "2", d: "3", e: "3", f: "3", g: "4", h: "4", i: "4",
    j: "5", k: "5", l: "5", m: "6", n: "6", o: "6", p: "7", q: "7", r: "7", s: "7",
    t: "8", u: "8", v: "8", w: "9", x: "9", y: "9", z: "9",
  };
  return String(word || "")
    .toLowerCase()
    .split("")
    .map((c) => (/[0-9]/.test(c) ? c : keypad[c] || ""))
    .join("")
    .slice(0, 7);
}

/** Toll-free NPAs — the prefixes VoIP.ms sells as toll-free (and vanity). */
function isTollFreeTenDigits(d: string): boolean {
  return /^(800|833|844|855|866|877|888)/.test(d);
}

// Write policy + reusable-template detection live in ./validation so they can
// be unit-tested without route plumbing.
const isWriteBlocked = isSubmissionWriteBlocked;

export async function registerOnboardingPublicRoutes(app: FastifyInstance) {
  // Validate token exists (prod) or can be created (dev)
  app.get("/onboarding/:token/validate", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) {
      if (canLazyCreate()) {
        return { ok: true, exists: false };
      }
      return reply.code(404).send({ error: "invalid_token" });
    }
    // Every wizard page-load lands here — the "customer opened the link"
    // moment. First open also emails the owner. Templates are spawn-only
    // shells, never opened by a customer themselves.
    if (!isReusableTemplate(row)) void recordLinkOpened(row);
    return {
      ok: true,
      exists: true,
      submission: {
        id: row.id,
        // The column is a STRING (autosave coerces it) — the old typeof-number
        // check meant this was always 0, so every refresh dumped the customer
        // back to step 1 with their answers filled in but their place lost.
        currentStep: Number(row.currentStep ?? 0) || 0,
        answers: row.answers ?? null,
      },
    };
  });

  // Public config — card capture disabled for now
  app.get("/onboarding/:token/public-config", async (req, reply) => {
    return { canTokenize: false };
  });

  // Journey beacons: the wizard reports what the customer is doing — step
  // reached (with time spent), going back, the exact validation message that
  // blocked them, number searches. Deliberately allowed AFTER submit too
  // (payment-stage friction is the interesting part), but never on templates,
  // and capped per submission so a runaway client can't flood the table.
  app.post("/onboarding/:token/track", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row || isReusableTemplate(row)) return reply.code(404).send({ error: "invalid_token" });
    const parsed = publicTrackSchema.safeParse(req.body || {});
    if (!parsed.success) return { ok: false };
    await recordJourneyBeacon(row.id, parsed.data as any);
    return { ok: true };
  });

  // Reusable TEST link: mints a brand-new submission (own token) on every call,
  // so one evergreen URL supports unlimited wizard runs. Only works against a
  // template row explicitly flagged answers.reusableTestLink = true.
  app.post("/onboarding/test/:token/spawn", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const template = await ensureRowForToken(token);
    if (!template || !isReusableTemplate(template)) return reply.code(404).send({ error: "invalid_token" });
    const newToken = generatePublicToken();
    const created = await (db as any).onboardingSubmission.create({
      data: {
        publicToken: newToken,
        status: "INVITE_SENT" as OnboardingStatus,
        events: { create: { type: "CREATED", message: `Spawned from reusable test link ${token.slice(0, 8)}…` } },
      },
    });
    return { ok: true, token: newToken, link: toPublicUrl(newToken), submissionId: created.id };
  });

  // VoIP.ms availability search takes 15-25s; cache per-query results so
  // repeat searches (and the auto-search on step entry) come back instantly.
  // ONLY the purchasable search is cached — the spare-DID list is fetched
  // fresh every time (it's one fast call, and stock changes with every
  // onboarding that claims or releases a number; caching it made freed
  // numbers invisible for up to 10 minutes — live 2026-07-27).
  const numberSearchCache = new Map<string, { at: number; purchasable: Array<Record<string, unknown>> }>();
  const NUMBER_SEARCH_CACHE_MS = 10 * 60_000;

  // Search available numbers to buy (VoIP.ms), gated by a valid onboarding token.
  // Read-only lookup only — never orders/charges. Never exposes prices to the customer.
  //
  // Query params:
  //   q      digits to search for
  //   mode   starts | contains | ends (local search position; default guesses)
  //   type   local (default) | tollfree
  //   vanity a word for toll-free vanity search ("PIZZA" → **74992); implies tollfree
  app.get("/onboarding/:token/numbers", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    const q = String((req.query as any)?.q || "").trim();
    const modeParam = String((req.query as any)?.mode || "").toLowerCase();
    const mode = (["starts", "contains", "ends"].includes(modeParam) ? modeParam : undefined) as
      | "starts" | "contains" | "ends" | undefined;
    const vanityWord = String((req.query as any)?.vanity || "").trim().slice(0, 40);
    const vanityDigits = vanityToDigits(vanityWord);
    const wantVanity = !!vanityDigits;
    const wantTollFree = wantVanity || String((req.query as any)?.type || "local").toLowerCase() === "tollfree";
    const creds = await loadGlobalVoipMsCreds();
    if (!creds) return { numbers: [], note: "number_provider_unconfigured" };

    const digits = q.replace(/\D/g, "");
    const cacheKey = wantVanity
      ? `vanity:${vanityDigits}`
      : `${wantTollFree ? "tollfree" : "local"}:${mode || "auto"}:${digits || q.toLowerCase()}`;
    const cached = numberSearchCache.get(cacheKey);
    const cachedPurchasable =
      cached && Date.now() - cached.at < NUMBER_SEARCH_CACHE_MS ? cached.purchasable : null;

    try {
      const testMode = (process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true";
      const provider = new VoipMsNumberProvider(creds, testMode);
      const fmt = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
      // The kind rides on every result so the wizard can price it ($15/month
      // toll-free) and provisioning can buy it with the right VoIP.ms method.
      const kind = wantVanity ? "vanity" : wantTollFree ? "tollfree" : "local";

      // Numbers we ALREADY OWN (spare in the master account, not assigned to
      // any subaccount) come first — use up stock before buying new ones.
      // Each tab only shows its own stock: toll-free spares never appear under
      // Local (they'd price wrong), and vice versa.
      // The availability search runs in parallel so this adds no wait time.
      const vanityRe = wantVanity
        ? new RegExp(`${vanityDigits.slice(-7)}$`)
        : null;
      const matchesQuery = (d: string) => {
        if (isTollFreeTenDigits(d) !== wantTollFree) return false;
        if (vanityRe) return vanityRe.test(d);
        if (!digits) return true;
        if (mode === "starts") return wantTollFree ? d.slice(3).startsWith(digits) : d.startsWith(digits);
        if (mode === "ends") return d.endsWith(digits);
        if (mode === "contains") return d.includes(digits);
        return digits.length <= 3 ? d.startsWith(digits) : d.includes(digits);
      };
      const [spares, results] = await Promise.all([
        listSpareDids(creds as any).catch(() => []),
        cachedPurchasable
          ? Promise.resolve(null)
          : (wantVanity
              ? provider.searchVanity({ pattern: vanityDigits, limit: 12 })
              : provider.searchNumbers({
                  type: wantTollFree ? "tollfree" : "local",
                  areaCode: digits || undefined,
                  contains: digits || undefined,
                  mode,
                  limit: 12,
                })
            ).catch(() => []),
      ]);
      const spareNumbers = spares
        .filter((s) => matchesQuery(s.did))
        .map((s) => ({
          number: fmt(s.did),
          e164: s.did,
          location: s.location,
          sms: s.sms,
          voice: true,
          inStock: true, // already purchased — provisioning routes it, no new purchase
          kind: wantTollFree ? ("tollfree" as const) : ("local" as const),
        }));
      const spareSet = new Set(spareNumbers.map((s) => s.e164));

      const purchasableAll =
        cachedPurchasable ??
        (results || []).map((r: any) => {
          const d = String(r.phoneNumber).replace(/\D/g, "").replace(/^1/, "");
          return {
            number: fmt(d.length === 10 ? d : String(r.phoneNumber)),
            e164: r.phoneNumber,
            location: r.region || "",
            sms: r.capabilities?.sms !== false,
            voice: r.capabilities?.voice !== false,
            inStock: false,
            kind,
          };
        });
      if (!cachedPurchasable && purchasableAll.length) {
        numberSearchCache.set(cacheKey, { at: Date.now(), purchasable: purchasableAll });
      }
      const purchasable = purchasableAll.filter(
        (n: any) => !spareSet.has(String(n.e164).replace(/\D/g, "").replace(/^1/, "")),
      );

      const numbers = [...spareNumbers, ...purchasable].slice(0, 12);
      return { numbers };
    } catch {
      return { numbers: [], error: "number_search_failed" };
    }
  });

  // Check whether an existing number can be ported in (VoIP.ms getPortability).
  // Read-only. Returns portable: true | false | null (unknown / not enough info).
  app.get("/onboarding/:token/portability", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    let number = String((req.query as any)?.number || "").replace(/\D/g, "");
    if (number.length === 11 && number.startsWith("1")) number = number.slice(1);
    if (number.length !== 10) return { portable: null, note: "need_full_number" };

    const creds = await loadGlobalVoipMsCreds();
    if (!creds) return { portable: null, note: "provider_unconfigured" };

    try {
      const base = (creds.apiBaseUrl || "https://voip.ms/api/v1/rest.php").replace(/\/$/, "");
      const url = new URL(base);
      url.searchParams.set("api_username", creds.username);
      url.searchParams.set("api_password", creds.password);
      url.searchParams.set("method", "getPortability");
      url.searchParams.set("did", number);
      const res = await fetch(url.toString(), { method: "GET" });
      const json: any = await res.json().catch(() => ({}));
      if (String(json.status || "").toLowerCase() !== "success") return { portable: null };
      const flag = String(json.portable ?? json.portability ?? "").toLowerCase();
      // Explicit "no" => not portable; anything else on a successful lookup => portable.
      return { portable: flag ? !/no|false|^0$/.test(flag) : true };
    } catch {
      return { portable: null };
    }
  });

  // Autosave current step + partial answers
  app.put("/onboarding/:token/save", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const body = publicSaveSchema.parse((req as any).body || {});
    let row = await ensureRowForToken(token);
    if (!row) {
      if (!canLazyCreate()) return reply.code(404).send({ error: "invalid_token" });
      row = await (db as any).onboardingSubmission.create({
        data: {
          publicToken: token,
          status: "IN_PROGRESS" as OnboardingStatus,
          currentStep: body.currentStep || null,
          answers: body.answers ?? null,
          events: { create: { type: "CREATED", message: "Submission created (lazy)" } },
        },
      });
    } else {
      if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });
      await (db as any).onboardingSubmission.update({
        where: { id: row.id },
        data: {
          currentStep: body.currentStep || null,
          answers: body.answers ?? null,
          status: (row.status === "INVITE_SENT" ? ("IN_PROGRESS" as OnboardingStatus) : row.status),
          events: { create: { type: "AUTOSAVED", message: body.currentStep ? `Step ${body.currentStep}` : undefined } },
        },
      });
    }
    return { ok: true };
  });

  // Upload latest bill / porting document
  app.post("/onboarding/:token/upload-bill", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });

    // fastify/multipart is registered globally in server.ts
    const parts: any = req.parts ? req.parts() : null;
    let filePart: any = null;
    if (parts && typeof parts === "object" && typeof parts[Symbol.asyncIterator] === "function") {
      for await (const p of parts as AsyncIterable<any>) {
        if (p?.file) { filePart = p; break; }
      }
    } else if (typeof req.file === "function") {
      filePart = await req.file();
    }
    if (!filePart) return reply.code(400).send({ error: "file_missing" });

    // Only the documents a port actually needs (PDF or a photo of the bill),
    // and no bigger than 10 MB — this is a public, unauthenticated endpoint.
    const originalName = sanitizeFileName(filePart.filename || "upload.bin");
    const allowedMime = new Set(["application/pdf", "image/jpeg", "image/png"]);
    const allowedExt = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
    const mime = String(filePart.mimetype || "").toLowerCase();
    const ext = path.extname(originalName).toLowerCase();
    if (!allowedMime.has(mime) && !allowedExt.has(ext)) {
      return reply.code(400).send({ error: "unsupported_file_type", detail: "Please upload a PDF, JPEG, or PNG." });
    }

    const maxBytes = 10 * 1024 * 1024;
    const bufs: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of filePart.file) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        filePart.file.resume?.();
        return reply.code(413).send({ error: "file_too_large", detail: "The file is over 10 MB. Please upload a smaller copy." });
      }
      bufs.push(buf);
    }
    if (filePart.file.truncated) {
      return reply.code(413).send({ error: "file_too_large", detail: "The file is over 10 MB. Please upload a smaller copy." });
    }
    const buffer = Buffer.concat(bufs);
    const storageKey = buildStorageKey(row.id, originalName);
    const absolutePath = resolveOnboardingStoragePath(storageKey);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, buffer);

    const kindParam = String((req.query as any)?.kind || "bill").toLowerCase();
    const fileKind = kindParam === "loa" ? "PORTING_LOA" : "PORTING_BILL";
    const saved = await (db as any).onboardingUploadedFile.create({
      data: {
        submissionId: row.id,
        filename: originalName,
        mimeType: filePart.mimetype || null,
        sizeBytes: buffer.length,
        storageKey,
        kind: fileKind,
      },
    });

    await (db as any).onboardingEvent.create({
      data: { submissionId: row.id, type: "FILE_UPLOADED", message: saved.filename },
    });

    return { ok: true, fileId: saved.id };
  });

  // ── Live build progress ───────────────────────────────────────────────────
  // Drives the "we're setting up your phone system" screen. Reports the real
  // stages rather than an indeterminate spinner: waiting is much easier when
  // you can see what is happening and that it is still moving.
  app.get("/onboarding/:token/progress", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    const full = await (db as any).onboardingSubmission.findUnique({
      where: { id: row.id },
      include: { requestedExtensions: true, events: { orderBy: { createdAt: "desc" }, take: 8 } },
    });

    // Self-heal the worst dead-end: card charged, but the post-payment kick
    // died before marking the submission paid (process restart, crash in the
    // detached finalize). The invoice knows the truth — if it's PAID and we
    // aren't, finalize + kick the pipeline right here. The customer's own
    // progress polling becomes the retry loop.
    if (full && !full.paidAt) {
      void (async () => {
        try {
          const inv = await (db as any).billingInvoice.findFirst({
            where: { status: "PAID", metadata: { path: ["onboardingSubmissionId"], equals: full.id } },
          });
          if (!inv) return;
          const { finalizeOnboardingInvoicePaid } = await import("./onboardingPayment");
          const done = await finalizeOnboardingInvoicePaid(inv);
          if (done) {
            await applyOnboardingNumber(done.submissionId).catch(() => { /* logged inside */ });
            await resumeSetupIfSubmitted(done.submissionId).catch(() => { /* logged inside */ });
          }
        } catch { /* next poll retries */ }
      })();
    }

    const numberReady = ["ready", "ready_dryrun", "ported_pending"].includes(String(full?.numberStatus || ""));
    const setup = String(full?.pbxSetupStatus || "");
    const built = setup === "done" || setup === "dry_run_done";
    const failed = setup === "failed";
    // Honesty over optimism: a paid build that nothing has touched for longer
    // than the stale window has no live run behind it. Say "we hit a snag"
    // instead of spinning forever — the watchdog sweep is already re-kicking
    // it, so "we're on it" is literally true.
    const stalled = !built && !failed && isSetupStalled(full);

    // Named, in the order they actually happen, so the screen can say which
    // one is running rather than "please wait".
    const steps = [
      { key: "paid", label: "Payment received", done: !!full?.paidAt,
        detail: full?.paidAmountCents ? `$${(full.paidAmountCents / 100).toFixed(2)}` : null },
      { key: "number", label: "Your number is yours", done: numberReady,
        detail: full?.provisionedDid ? String(full.provisionedDid) : null },
      { key: "extensions", label: "Creating your team's phone lines", done: built,
        detail: full?.requestedExtensions?.length ? `${full.requestedExtensions.length} ${full.requestedExtensions.length === 1 ? "person" : "people"}` : null },
      { key: "invites", label: "Sending everyone their login", done: built, detail: null },
    ];
    const current = steps.find((s) => !s.done)?.key ?? null;

    return {
      ok: true,
      paid: !!full?.paidAt,
      built,
      failed: failed || stalled,
      // Only surfaced when something actually went wrong — a half-finished
      // build should never look finished.
      error: failed
        ? (full?.setupError || "Setup didn't complete.")
        : stalled
          ? "We hit a snag finishing your setup. Our team has been notified and is on it — we'll email you as soon as your phone system is ready."
          : null,
      steps,
      current,
      tenantId: full?.createdTenantId ?? null,
      recentActivity: (full?.events ?? []).map((e: any) => ({ at: e.createdAt, message: e.message })).filter((e: any) => e.message),
    };
  });

  // ── What they'll pay ──────────────────────────────────────────────────────
  // Review-step receipt: itemized monthly lines + total, priced server-side by
  // the SAME code the first invoice uses — a quote that disagrees with the
  // charge is the kind of thing a customer never forgets. The wizard passes
  // its live extension count and SMS flag because autosave is debounced: the
  // stored answers can be a second behind what's on screen.
  app.get("/onboarding/:token/quote", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    const full = await (db as any).onboardingSubmission.findUnique({
      where: { id: row.id },
      include: { requestedExtensions: true },
    });
    const derived = quoteInputForSubmission(full || row);

    const q: any = req.query || {};
    const extParam = Number(q.extensions);
    const smsParam = String(q.sms ?? "");
    // The wizard passes its live pick too — apply-number is fire-and-forget
    // and autosave is debounced, so the stored numberKind can lag the screen.
    const kindParam = String(q.numberKind ?? "").toLowerCase();
    const input = {
      extensions:
        Number.isFinite(extParam) && extParam >= 0 ? Math.min(500, Math.floor(extParam)) : derived.extensions,
      phoneNumbers: derived.phoneNumbers,
      smsEnabled: smsParam === "1" ? true : smsParam === "0" ? false : derived.smsEnabled,
      tollFreeNumber: ["local", "tollfree", "vanity"].includes(kindParam)
        ? isTollFreeNumberKind(kindParam)
        : derived.tollFreeNumber,
    };
    const quote = quoteOnboarding(input);
    return { ok: true, lines: quote.lines, monthlyTotalCents: quote.monthlyTotalCents, summary: describeQuote(quote) };
  });

  // ── Checkout ──────────────────────────────────────────────────────────────
  // The wizard has no payment screen of its own. Reaching checkout calls this,
  // which creates the tenant and the first invoice in the background and hands
  // back a link to /pay/invoice/[token] — the SAME page every customer pays
  // invoices on. Card fields, receipt email, "Payment received": all of that
  // already existed there, which is exactly why the wizard's copy was deleted.
  //
  // Nothing is bought here. The number purchase and the PBX build fire from
  // the public pay route the moment the invoice is actually paid.
  app.post("/onboarding/:token/checkout", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    // Checkout happens AFTER submit locks the form, so a SUBMITTED row is
    // exactly the state that needs paying — the general write-block would 409
    // it. Templates never check out; anything past SUBMITTED only passes when
    // it's already paid (prepareOnboardingCheckout answers alreadyPaid and the
    // wizard forwards to the progress screen).
    const checkoutStatus = String((row as any).status || "");
    const checkoutAllowed =
      ["INVITE_SENT", "IN_PROGRESS", "SUBMITTED"].includes(checkoutStatus) || !!(row as any).paidAt;
    if (isReusableTemplate(row) || !checkoutAllowed) return reply.code(409).send({ error: "write_blocked" });

    const result = await prepareOnboardingCheckout(row.id);
    if (!result.ok) {
      // Journey: a customer who reached payment and got an error is a
      // customer about to give up — make sure the timeline says so.
      await (db as any).onboardingEvent.create({
        data: { submissionId: row.id, type: "STATUS_CHANGED", message: `Payment page FAILED to open: ${String(result.message || result.error).slice(0, 200)}` },
      }).catch(() => {});
      return reply.code(result.code).send({ error: result.error, message: result.message });
    }

    await (db as any).onboardingEvent.create({
      data: {
        submissionId: row.id,
        type: "STATUS_CHANGED",
        message: result.alreadyPaid
          ? "Came back to payment — already paid, sent to the progress screen"
          : `Handed to the payment page — $${(Number(result.amountCents || 0) / 100).toFixed(2)} due`,
      },
    }).catch(() => {});

    return {
      ok: true,
      payPath: result.payPath,
      invoiceNumber: result.invoiceNumber,
      amountCents: result.amountCents,
      alreadyPaid: result.alreadyPaid,
    };
  });

  // Apply the chosen number — fires when the customer leaves the "Your number"
  // step. Persists the choice and kicks off VoIP.ms provisioning (subaccount +
  // DID / port + temporary number) in the background so it's usually done by
  // the time they hit "Launch".
  app.post("/onboarding/:token/apply-number", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const body = publicApplyNumberSchema.parse(req.body || {});
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked" });

    // Merge the number choice into answers so provisioning can read it even if
    // the autosave for this step hasn't landed yet.
    const answers: any = { ...(row.answers as any || {}) };
    answers.phone = {
      ...(answers.phone || {}),
      choice: body.choice,
      selectedNumber: body.selectedNumber || answers.phone?.selectedNumber || "",
      // The kind travels with the selection: it prices the $15 toll-free line
      // and picks the purchase method. A port has no kind.
      numberKind: body.choice === "port" ? undefined : body.numberKind || answers.phone?.numberKind || "local",
      details: body.porting ?? answers.phone?.details ?? {},
    };
    await (db as any).onboardingSubmission.update({
      where: { id: row.id },
      data: {
        answers,
        phoneNumberChoice: body.choice,
        companyName: row.companyName || body.companyName || null,
      },
    });

    // The choice is SAVED here, but nothing is BOUGHT. Buying used to start
    // the moment someone left this step, which meant an abandoned sign-up left
    // us holding a paid-for VoIP.ms number. Provisioning now waits for payment
    // and is kicked off by the pay route instead.
    if (!row.paidAt) return { ok: true, status: "saved_awaiting_payment" };

    void (async () => {
      await applyOnboardingNumber(row.id).catch(() => { /* logged inside */ });
      // If the customer raced ahead and already hit "Launch" while the number
      // was provisioning, carry the setup pipeline forward now.
      await resumeSetupIfSubmitted(row.id).catch(() => { /* logged inside */ });
    })();
    return { ok: true, status: "provisioning" };
  });

  // Submit — validate + persist
  app.post("/onboarding/:token/submit", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    // A parse() throw here surfaced to customers as a raw "internal_error"
    // zod dump — validation failures must come back as a friendly 400.
    const parsedBody = publicSubmitSchema.safeParse(req.body || {});
    if (!parsedBody.success) return reply.code(400).send({ error: friendlySubmitError(parsedBody.error) });
    const body = parsedBody.data;

    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });

    // validate extensions numeric + long enough + unique.
    //
    // ⛔ Three digits is a HARD floor, not a style preference. VitalPBX accepts
    // a one-digit extension and builds it happily, but every Connect directory
    // read filters on `^\d{2,6}$` (isRealDirectoryExtensionNumber in server.ts),
    // so the extension is created, billed, and INVISIBLE — no phones listed
    // anywhere, and "a person" greyed out in the IVR Studio with nothing on
    // screen to explain it. One customer signed up with their only extension
    // numbered "1" and lived exactly that. The wizard promotes a single digit
    // (1 → 101) before it gets here; this is the gate an older or scripted
    // client can't walk past. Rejecting rather than rewriting is deliberate:
    // silently renumbering someone's phone is not ours to do.
    const seen = new Set<string>();
    for (const e of body.extensions || []) {
      if (!/^[0-9]+$/.test(e.extNumber)) return reply.code(400).send({ error: `Extension number "${e.extNumber}" can only contain digits.` });
      if (!/^[0-9]{3,6}$/.test(e.extNumber)) {
        return reply.code(400).send({
          error: `Extension number "${e.extNumber}" is too short — extension numbers need at least three digits, like 101.`,
        });
      }
      if (seen.has(e.extNumber)) return reply.code(400).send({ error: `Extension number ${e.extNumber} is used more than once — extension numbers must be unique.` });
      seen.add(e.extNumber);
    }

    const smsEnabled = !!body.smsEnabled;
    const smsMonthlyPriceCents = smsEnabled ? 1000 : 0;

    await (db as any).$transaction(async (tx: any) => {
      await tx.onboardingRequestedExtension.deleteMany({ where: { submissionId: row.id } });
      if ((body.extensions || []).length > 0) {
        await tx.onboardingRequestedExtension.createMany({
          data: (body.extensions || []).map((e) => ({
            submissionId: row.id,
            displayName: e.displayName || null,
            extNumber: e.extNumber,
            email: e.email || null,
            vmPassword: e.vmPassword || null,
            smsEnabled: !!e.smsEnabled,
            cellMode: e.cellMode || null,
            cellNumber: e.cellMode ? e.cellNumber || null : null,
          })),
          skipDuplicates: true,
        });
      }

      // Keep the latest number choice in answers too (provisioning reads it there).
      const answers: any = { ...(row.answers as any || {}) };
      // Which language should this customer's screens be in? Asked once, at
      // sign-up. "yi" switches Yiddish ON for the whole tenant; anything else
      // leaves it English. Stored in answers so the orchestrator can read it
      // when it creates the Connect tenant.
      if (typeof body.language === "string") {
        answers.language = String(body.language).toLowerCase() === "yi" ? "yi" : "en";
      }
      // The E911 address must survive submit even if an autosave was missed.
      if (typeof body.address === "string" && body.address.trim()) {
        answers.contact = { ...(answers.contact || {}), address: body.address.trim() };
      }
      answers.phone = {
        ...(answers.phone || {}),
        choice: body.phoneNumberChoice || answers.phone?.choice || "",
        selectedNumber: body.selectedNumber || answers.phone?.selectedNumber || "",
        numberKind:
          (body.phoneNumberChoice || answers.phone?.choice) === "port"
            ? undefined
            : body.numberKind || answers.phone?.numberKind || "local",
        details: body.porting ?? answers.phone?.details ?? {},
      };
      // Which extension is the account owner (becomes the tenant admin when
      // the system is built). Defaults to the first extension when the wizard
      // didn't mark one — an account with nobody in charge helps no one.
      answers.ownerExtNumber =
        (body.extensions || []).find((e) => (e as any).isOwner)?.extNumber ||
        (body.extensions || [])[0]?.extNumber ||
        null;

      await tx.onboardingSubmission.update({
        where: { id: row.id },
        data: {
          companyName: body.companyName,
          contactFirstName: body.contactFirstName,
          contactLastName: body.contactLastName,
          mainEmail: body.mainEmail,
          // No separate billing contact means bills go to the main email.
          billingEmail: body.billingEmail || body.mainEmail,
          mainPhone: body.mainPhone || null,
          phoneNumberChoice: body.phoneNumberChoice || null,
          answers,
          smsEnabled,
          smsMonthlyPriceCents,
          status: "SUBMITTED" as OnboardingStatus,
          submittedAt: new Date(),
          events: { create: { type: "SUBMITTED", message: `${seen.size} extensions` } },
        },
      });
    });

    // Nothing is bought or built until the invoice is paid. The pay route is
    // what kicks number purchase / port filing + the PBX build once the card
    // clears (finalize → applyOnboardingNumber → resumeSetupIfSubmitted).
    // Kicking it here too used to buy DIDs and build tenants for sign-ups that
    // never paid. The only submit that runs the pipeline is one on an
    // already-paid row (pay page finished in another tab first).
    if ((row as any).paidAt) {
      void (async () => {
        await applyOnboardingNumber(row.id).catch(() => { /* logged inside */ });
        await syncOnboardingSms(row.id).catch(() => { /* logged inside */ });
        await runOnboardingSetup(row.id).catch(() => { /* logged inside */ });
      })();
    }

    return { ok: true };
  });
}
