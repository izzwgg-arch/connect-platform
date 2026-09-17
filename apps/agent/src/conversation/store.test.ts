import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrismaConversationStore, conversationChannel } from "./store";

test("a NEW Laybel voice conversation persists using a real schema enum value", async () => {
  const schema = readFileSync(new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
  const values = schema.match(/enum AgentChannel\s*\{([^}]+)\}/)![1].trim().split(/\s+/);
  const store = new PrismaConversationStore({ agentConversation: { create: async ({ data }: any) => {
    assert.ok(values.includes(data.channel), `Prisma would reject ${data.channel}`);
    assert.equal(data.channel, "CHAT"); assert.equal(data.tenantId, "verified-tenant");
    return { id: "new-conversation", ...data };
  } } });
  const result = await store.create({ tenantId: "verified-tenant", clientUserId: "verified-user", role: "customer", channel: "voice" });
  assert.equal(result.id, "new-conversation");
});

test("existing channel mappings stay intact and unknown values fail before persistence", () => {
  for (const value of ["chat", "email", "whatsapp", "sms", "phone"]) assert.equal(conversationChannel(value), value.toUpperCase());
  assert.equal(conversationChannel("VOICE"), "CHAT"); assert.equal(conversationChannel("invented"), null);
  const store = new PrismaConversationStore({ agentConversation: { create: () => assert.fail("invalid channel reached Prisma") } });
  assert.throws(() => store.create({ tenantId: "t", clientUserId: "u", role: "customer", channel: "invented" }), /Unsupported/);
});
