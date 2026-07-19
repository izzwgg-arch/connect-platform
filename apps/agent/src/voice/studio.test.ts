import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceStudio } from "./studio";
import { MessagingChannelHandler, NullMessagingTransport, normalizeWhatsAppFrom } from "../channels/messaging";
import { IdentityResolver } from "../channels/identity";
import { AuditLog } from "../audit/audit";

const audit = new AuditLog([{ async write() {} }]);

test("Voice Studio render is guarded without ElevenLabs key (never fakes audio)", async () => {
  const vs = new VoiceStudio({}, { elevenLabsApiKey: null, openaiApiKey: null }, audit);
  const r = await vs.render({ voiceId: "v1", text: "hello", language: "en" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /key_not_configured/);
});

test("Yiddish render flagged experimental", async () => {
  const vs = new VoiceStudio({}, { elevenLabsApiKey: "el-x", openaiApiKey: null }, audit);
  const r = await vs.render({ voiceId: "v1", text: "אַ גוטן", language: "yi" });
  assert.equal(r.experimental, true);
});

test("addVoice persists a record with provenance", async () => {
  const store: any = {};
  const prisma = {
    agentMemory: {
      upsert: async ({ create }: any) => { store[create.key] = create.value; return create; },
      findMany: async () => Object.values(store).map((v: any) => ({ value: v })),
    },
  };
  const vs = new VoiceStudio(prisma as any, { elevenLabsApiKey: "x", openaiApiKey: null }, audit);
  const rec = await vs.addVoice({ name: "Izzy Office", languages: ["en", "yi"], type: "pro_clone", provider: "elevenlabs", provenance: "owner-recorded" });
  assert.ok(rec.id.startsWith("v_"));
  const list = await vs.listVoices();
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance, "owner-recorded");
});

test("WhatsApp prefix normalization", () => {
  assert.equal(normalizeWhatsAppFrom("whatsapp:+18455551212"), "+18455551212");
  assert.equal(normalizeWhatsAppFrom("+18455551212"), "+18455551212");
});

test("messaging: known phone routed to engine; unknown declined", async () => {
  const engineStub: any = { calls: [] as any[], async handleMessage(ctx: any, text: string) { this.calls.push({ ctx, text }); return { conversationId: "c1", reply: "ok", language: "en", degraded: true }; } };
  const known = new IdentityResolver({ user: { findFirst: async () => ({ id: "u1", tenantId: "t9", role: "USER", email: "a@b.c" }) } } as any);
  const h1 = new MessagingChannelHandler(engineStub, known, new NullMessagingTransport(), audit);
  const r1 = await h1.handleInbound({ from: "whatsapp:+18455551212", text: "help", channel: "whatsapp" });
  assert.equal(r1.handled, true);
  assert.equal(engineStub.calls[0].ctx.channel, "whatsapp");

  const unknown = new IdentityResolver({ user: { findFirst: async () => null } } as any);
  const h2 = new MessagingChannelHandler(engineStub, unknown, new NullMessagingTransport(), audit);
  const r2 = await h2.handleInbound({ from: "+19999999999", text: "hi", channel: "sms" });
  assert.equal(r2.handled, false);
});
