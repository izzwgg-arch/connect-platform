import test from "node:test";
import assert from "node:assert/strict";

// ─── Env bootstrap ─────────────────────────────────────────────────────────
// `apps/telephony/src/config/env.ts` validates required env on import, and the
// ConnectWakeConsumer module transitively imports `env`. Set required vars
// BEFORE the late require below. `LOG_LEVEL=fatal` keeps pino quiet.
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// Late require so the env above is in place when the module's top-level
// loadEnv() runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConnectWakeConsumer, parseConnectWakeEvent } = require("./ConnectWakeConsumer");
// `import type` is erased and does not trigger env loading.
import type {
  ConnectWakeDeliverInput,
  TenantResolverLike,
} from "./ConnectWakeConsumer";
import type { AmiClient } from "../ami/AmiClient";
import type { AmiFrame } from "../ami/AmiTypes";

// Minimal AMI stub: only the EventEmitter surface ConnectWakeConsumer uses.
function makeAmiStub(): AmiClient & { emitEvent: (f: AmiFrame) => void } {
  const handlers: Array<(f: AmiFrame) => void> = [];
  const stub = {
    on(event: string, cb: (f: AmiFrame) => void) {
      if (event === "event") handlers.push(cb);
      return stub;
    },
    off(event: string, cb: (f: AmiFrame) => void) {
      if (event === "event") {
        const i = handlers.indexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      }
      return stub;
    },
    emitEvent(f: AmiFrame) {
      for (const h of [...handlers]) h(f);
    },
  };
  return stub as unknown as AmiClient & { emitEvent: (f: AmiFrame) => void };
}

const resolverFixed = (id: string | null): TenantResolverLike => ({
  resolveConnectTenant: () => id,
});

const wakeFrame = (over: Partial<Record<string, string>> = {}): AmiFrame => ({
  Event: "UserEvent",
  UserEvent: "ConnectWake",
  Tenant: "2",
  Extension: "110",
  CallId: "1700000000.1",
  From: "5035551234",
  ...over,
});

test("parseConnectWakeEvent: parses a well-formed ConnectWake frame", () => {
  const evt = parseConnectWakeEvent(wakeFrame());
  assert.deepEqual(evt, {
    tid: "2",
    ext: "110",
    callId: "1700000000.1",
    from: "5035551234",
  });
});

test("parseConnectWakeEvent: ignores non-UserEvent frames", () => {
  assert.equal(parseConnectWakeEvent({ Event: "Newchannel" }), null);
});

test("parseConnectWakeEvent: ignores other UserEvents", () => {
  assert.equal(
    parseConnectWakeEvent({ Event: "UserEvent", UserEvent: "SomethingElse" }),
    null,
  );
});

test("parseConnectWakeEvent: rejects frames missing tenant or extension", () => {
  assert.equal(parseConnectWakeEvent(wakeFrame({ Tenant: "" })), null);
  assert.equal(parseConnectWakeEvent(wakeFrame({ Extension: "" })), null);
});

test("handleWake: dispatches one delivery and resolves the connect tenant id", () => {
  const ami = makeAmiStub();
  const delivered: ConnectWakeDeliverInput[] = [];
  const consumer = new ConnectWakeConsumer(ami, resolverFixed("connect-uuid-1"), {
    now: () => 1000,
    deliver: async (input: ConnectWakeDeliverInput) => {
      delivered.push(input);
    },
  });

  const accepted = consumer.handleWake({
    tid: "2",
    ext: "110",
    callId: "abc.1",
    from: "5035551234",
  });

  assert.equal(accepted, true);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    linkedId: "abc.1",
    connectTenantId: "connect-uuid-1",
    pbxVitalTenantId: "2",
    toExtension: "110",
    fromNumber: "5035551234",
  });
});

test("handleWake: debounces duplicate wakes for same tenant+ext within window", () => {
  let nowMs = 1000;
  const delivered: ConnectWakeDeliverInput[] = [];
  const consumer = new ConnectWakeConsumer(makeAmiStub(), resolverFixed(null), {
    debounceMs: 5_000,
    now: () => nowMs,
    deliver: async (input: ConnectWakeDeliverInput) => {
      delivered.push(input);
    },
  });

  const evt = { tid: "2", ext: "110", callId: "c1", from: null };
  assert.equal(consumer.handleWake(evt), true); // first → dispatched
  nowMs = 2000;
  assert.equal(consumer.handleWake({ ...evt, callId: "c2" }), false); // within 5s → debounced
  nowMs = 7000;
  assert.equal(consumer.handleWake({ ...evt, callId: "c3" }), true); // past window → dispatched again

  assert.equal(delivered.length, 2);
  assert.deepEqual(
    delivered.map((d) => d.linkedId),
    ["c1", "c3"],
  );
});

test("handleWake: different extensions are tracked independently", () => {
  const delivered: ConnectWakeDeliverInput[] = [];
  const consumer = new ConnectWakeConsumer(makeAmiStub(), resolverFixed(null), {
    debounceMs: 5_000,
    now: () => 1000,
    deliver: async (input: ConnectWakeDeliverInput) => {
      delivered.push(input);
    },
  });

  assert.equal(consumer.handleWake({ tid: "2", ext: "110", callId: "a", from: null }), true);
  assert.equal(consumer.handleWake({ tid: "2", ext: "111", callId: "b", from: null }), true);
  assert.equal(delivered.length, 2);
});

test("start: wires the AMI event stream and dispatches on ConnectWake frames", () => {
  const ami = makeAmiStub();
  const delivered: ConnectWakeDeliverInput[] = [];
  const consumer = new ConnectWakeConsumer(ami, resolverFixed("t"), {
    now: () => 1000,
    deliver: async (input: ConnectWakeDeliverInput) => {
      delivered.push(input);
    },
  });
  consumer.start();

  ami.emitEvent({ Event: "Newchannel" }); // ignored
  ami.emitEvent(wakeFrame({ CallId: "live.1" }));

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.linkedId, "live.1");

  consumer.stop();
  ami.emitEvent(wakeFrame({ CallId: "live.2" })); // no longer listening
  assert.equal(delivered.length, 1);
});
