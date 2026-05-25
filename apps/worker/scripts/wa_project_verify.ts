import { buildDedupeKey, buildFallbackExternalMessageId, normalizeWhatsAppE164, projectInboundToConnectChat } from "../src/whatsappProject";
import type { WaInboundMessageEvent } from "@connect/shared/src/whatsappTypes";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

async function run() {
  let passed = 0, failed = 0;
  const pass = (m: string) => { passed++; console.log(`OK  - ${m}`); };
  const fail = (m: string, e?: any) => { failed++; console.error(`FAIL - ${m}${e?.message ? ": " + e.message : ""}`); };

  try {
    assert(normalizeWhatsAppE164("whatsapp:+15551234567") === "+15551234567", "normalizeWhatsAppE164 strips prefix");
    assert(normalizeWhatsAppE164("+15551234567") === "+15551234567", "normalizeWhatsAppE164 keeps E164");
    pass("normalizeWhatsAppE164");
  } catch (e) { fail("normalizeWhatsAppE164", e); }

  try {
    const dk = buildDedupeKey("t1", "pnid1", "+1555");
    assert(dk === "wa:t1:pnid1:+1555", "dedupeKey format");
    pass("buildDedupeKey");
  } catch (e) { fail("buildDedupeKey", e); }

  try {
    const ev: WaInboundMessageEvent = {
      type: "wa_inbound_message",
      tenantId: "t1",
      provider: "WHATSAPP_META",
      accountRef: "pnid1",
      externalMessageId: undefined,
      from: "+15551234567",
      to: "+15557654321",
      bodyText: "Hello world",
      media: undefined,
      timestamp: new Date("2026-05-24T12:00:00Z").toISOString(),
      providerPayloadRedacted: { message: "hi" },
    };
    const id1 = buildFallbackExternalMessageId(ev);
    const id2 = buildFallbackExternalMessageId(ev);
    assert(id1 === id2 && id1.startsWith("fallback:"), "fallback externalMessageId deterministic with prefix");
    pass("buildFallbackExternalMessageId deterministic");
  } catch (e) { fail("buildFallbackExternalMessageId deterministic", e); }

  try {
    // Projection disabled path should short-circuit without DB access.
    process.env.WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED = "false";
    const ev: WaInboundMessageEvent = {
      type: "wa_inbound_message",
      tenantId: "t1",
      provider: "WHATSAPP_TWILIO",
      accountRef: "AC123",
      externalMessageId: "",
      from: "whatsapp:+15551234567",
      to: "whatsapp:+15557654321",
      bodyText: "Hi",
      media: undefined,
      timestamp: new Date().toISOString(),
      providerPayloadRedacted: {},
    };
    await projectInboundToConnectChat(ev);
    pass("projectInboundToConnectChat short-circuits when disabled");
  } catch (e) { fail("projectInboundToConnectChat short-circuits when disabled", e); }

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  } else {
    console.log(`\n${passed} passed, 0 failed`);
  }
}

run().catch((e) => { console.error("UNEXPECTED_ERROR", e); process.exit(1); });
