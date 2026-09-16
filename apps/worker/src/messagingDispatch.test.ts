/**
 * The Messaging Router registry + the provider-level backup route (unified
 * messaging Phase 1, 2026-09-16).
 *
 * The registry tests prove the dispatch map; the fallback tests drive
 * `attemptProviderFallback` through injected deps (no db, no network) and pin
 * every rule of the one-message-one-delivery contract:
 *  - null fallback (every existing row) = today's behaviour, untouched;
 *  - a partial delivery (__anySent) is NEVER re-sent through a backup;
 *  - an error carrying NO flag is treated as "may have sent" and not retried;
 *  - a successful backup stamps the route metadata the message-info drawer
 *    reads (customer copy says "backup route"; carrier names are for
 *    platform staff only).
 *
 * Source guards (replayed against pre-Phase-1 HEAD they FAIL — the job had an
 * inline if/else and no fallback at all).
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getOutboundChatAdapter, REGISTERED_CHAT_PROVIDERS } from "./messagingDispatch";
import { attemptProviderFallback, type ProviderFallbackDeps } from "./connectChatSmsJob";

function readSrc(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

// ── Registry ────────────────────────────────────────────────────────────────

test("the registry maps SIGNALWIRE and TELNYX to adapters and nothing else", async () => {
  assert.deepStrictEqual([...REGISTERED_CHAT_PROVIDERS], ["SIGNALWIRE", "TELNYX"]);
  assert.ok(await getOutboundChatAdapter("SIGNALWIRE"), "SignalWire adapter resolves");
  assert.ok(await getOutboundChatAdapter("TELNYX"), "Telnyx adapter resolves");
  assert.ok(await getOutboundChatAdapter("telnyx"), "provider match is case-insensitive");
  assert.strictEqual(await getOutboundChatAdapter("VOIPMS"), null, "VoIP.ms stays the job-body fallthrough");
  assert.strictEqual(await getOutboundChatAdapter("TWILIO"), null, "unknown providers fall through like before");
  assert.strictEqual(await getOutboundChatAdapter(""), null);
});

test("the job body carries no inline provider if/else anymore", () => {
  const src = stripComments(readSrc("./connectChatSmsJob.ts"));
  const jobAt = src.indexOf("export async function processConnectChatSmsJob");
  const helpersAt = src.indexOf("export type ProviderFallbackDeps");
  const body = src.slice(jobAt, helpersAt > jobAt ? helpersAt : undefined);
  assert.ok(!body.includes('=== "SIGNALWIRE"'), "the inline SignalWire branch is gone");
  assert.ok(body.includes("getOutboundChatAdapter(primaryProvider)"), "dispatch goes through the registry");
  assert.ok(body.includes("attemptProviderFallback"), "the backup route is wired into the job");
  assert.ok(body.includes("trackVoipMsAcceptance"), "VoIP.ms acceptance is tracked for the fallback contract");
});

// ── Backup route decision rules ─────────────────────────────────────────────

function fakeDeps(overrides: Partial<ProviderFallbackDeps> = {}): ProviderFallbackDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: ProviderFallbackDeps & { calls: string[] } = {
    calls,
    getAdapter: async (p) => {
      calls.push(`getAdapter:${p}`);
      if (p === "SIGNALWIRE" || p === "TELNYX") {
        return async () => { calls.push(`send:${p}`); };
      }
      return null;
    },
    loadMessage: async (id) => {
      calls.push(`load:${id}`);
      return { id, threadId: "t1", body: "hello", metadata: { keep: true }, attachments: [] };
    },
    readMetadata: async () => ({ keep: true, adapterWrote: true }),
    writeMetadata: async (id, metadata) => {
      calls.push(`meta:${JSON.stringify(metadata)}`);
    },
    ...overrides,
  };
  return deps;
}

const baseInput = {
  messageId: "m1", threadId: "t1", tenantId: "ten1",
  primaryProvider: "TELNYX", fallbackProvider: "SIGNALWIRE",
  primaryErr: Object.assign(new Error("boom"), { __anySent: false }),
  to: "+13479780090", from: "+12053513327",
};

test("no fallbackProvider (every existing row) means no backup attempt at all", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback({ ...baseInput, fallbackProvider: null }, deps);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(deps.calls, [], "nothing was even looked up");
});

test("a fallback equal to the primary is refused", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback({ ...baseInput, fallbackProvider: "TELNYX" }, deps);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(deps.calls, []);
});

test("a PARTIAL delivery is never duplicated through the backup route", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback({
    ...baseInput,
    primaryErr: Object.assign(new Error("part 2 of 3 failed"), { __anySent: true }),
  }, deps);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(deps.calls, [], "no adapter call, no duplicate");
});

test("an error carrying NO flag is treated as may-have-sent and not retried", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback({
    ...baseInput,
    primaryErr: new Error("opaque failure with no contract flag"),
  }, deps);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(deps.calls, []);
});

test("a provably-zero-sent failure goes out ONCE through the backup and stamps the route", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback(baseInput, deps);
  assert.strictEqual(handled, true);
  const sends = deps.calls.filter((c) => c.startsWith("send:"));
  assert.deepStrictEqual(sends, ["send:SIGNALWIRE"], "exactly one backup send");
  const metaCall = deps.calls.find((c) => c.startsWith("meta:"));
  assert.ok(metaCall, "route metadata was stamped");
  const meta = JSON.parse(metaCall!.slice(5));
  assert.strictEqual(meta.sentViaBackupRoute, true);
  assert.strictEqual(meta.backupCarrier, "SIGNALWIRE");
  assert.strictEqual(meta.primaryCarrier, "TELNYX");
  assert.strictEqual(meta.adapterWrote, true, "the adapter's own metadata writes survive the stamp");
});

test("a backup carrier with no adapter (VOIPMS today) refuses instead of guessing", async () => {
  const deps = fakeDeps();
  const handled = await attemptProviderFallback({ ...baseInput, fallbackProvider: "VOIPMS" }, deps);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(deps.calls, ["getAdapter:VOIPMS"]);
});

test("a failing backup adapter reports unhandled so the job stamps the PRIMARY failure", async () => {
  const deps = fakeDeps({
    getAdapter: async () => async () => { throw new Error("backup also down"); },
  });
  const handled = await attemptProviderFallback(baseInput, deps);
  assert.strictEqual(handled, false);
});

test("a vanished message row is unhandled, never a crash", async () => {
  const deps = fakeDeps({ loadMessage: async () => null });
  const handled = await attemptProviderFallback(baseInput, deps);
  assert.strictEqual(handled, false);
});

// ── The __anySent contract exists in every adapter ─────────────────────────

test("all three send paths carry the __anySent fallback contract", () => {
  for (const file of ["./connectChatSmsJob.ts", "./signalWireChatSend.ts", "./telnyxChatSend.ts"]) {
    const src = stripComments(readSrc(file));
    assert.ok(src.includes("__anySent"), `${file} attaches the acceptance flag`);
  }
});
