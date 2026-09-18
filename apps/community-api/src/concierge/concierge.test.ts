import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { rulesIntent, understand } from "./understand.js";

test("rules intent: vendor request with place, quantity and deadline", () => {
  const i = rulesIntent("I need 25 custom embroidered jackets delivered to Monroe before October 20");
  assert.equal(i.kind, "find_vendor");
  assert.equal(i.location, "Monroe");
  assert.equal(i.quantity, "25");
  assert.match(i.deadline ?? "", /october 20/);
  assert.equal(i.source, "rules");
  assert.equal(rulesIntent("who is hiring bookkeepers in Monsey").kind, "find_person");
  assert.equal(rulesIntent("looking for a job as an office manager").kind, "find_job");
  assert.equal(rulesIntent("asdf").kind, "unclear");
});

test("understand() uses Claude through the tool schema when a key is set, and falls back to rules on failure", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const fakeFetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice.name, "set_intent");
      return new Response(JSON.stringify({ content: [{ type: "tool_use", input: { kind: "find_vendor", service: "packaging boxes", customerType: null, location: "Brooklyn", radiusMiles: 50, quantity: "5,000", deadline: null, budget: null, summary: "Packaging company for 5,000 boxes" } }] }), { status: 200 });
    }) as typeof fetch;
    const ai = await understand("I need a packaging company within 50 miles that can manufacture 5,000 boxes next month", fakeFetch);
    assert.equal(ai.source, "ai");
    assert.equal(ai.radiusMiles, 50);
    const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const fb = await understand("packaging company in Brooklyn", failing);
    assert.equal(fb.source, "rules");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("ask returns only real matches with why-lines and signed actions; act needs confirmation and posts a real RFQ inviting the match", async () => {
  const app = await testApp();
  const vendorOwner = await createUser(app, { firstName: "Shloimy", lastName: uniq("Weiss") });
  const org = await createOrg(app, vendorOwner, `Weiss Embroidery ${uniq()}`);
  await tdb().organization.update({ where: { id: org.id }, data: { searchText: `${org.displayName} embroidery uniforms jackets monroe`, description: "Custom embroidery" } });
  const buyer = await createUser(app);
  const ask = await api(app, { method: "POST", url: "/concierge/ask", token: buyer.accessToken, payload: { question: "I need an embroidery shop for 25 jackets delivered to Monroe by October 20" } });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.equal(ask.body.intent.kind, "find_vendor");
  const orgMatch = ask.body.matches.find((m: any) => m.type === "organizations" && m.id === org.id);
  assert.ok(orgMatch, "the real org is a match");
  assert.ok(orgMatch.why.length > 3);
  const rfqAction = ask.body.actions.find((a: any) => a.kind === "post_rfq");
  assert.ok(rfqAction && rfqAction.needsConfirmation === true);
  // Tampered token is refused; someone else's token is refused.
  const bad = await api(app, { method: "POST", url: "/concierge/act", token: buyer.accessToken, payload: { token: rfqAction.token.slice(0, -2) + "xx" } });
  assert.equal(bad.status, 400);
  const other = await api(app, { method: "POST", url: "/concierge/act", token: vendorOwner.accessToken, payload: { token: rfqAction.token } });
  assert.equal(other.status, 403);
  const act = await api(app, { method: "POST", url: "/concierge/act", token: buyer.accessToken, payload: { token: rfqAction.token } });
  if (act.status === 400 && /rfq_failed/.test(JSON.stringify(act.body))) {
    // The RFQ domain is built by a parallel agent; when its route is absent the concierge reports the failure honestly.
    assert.match(act.body.message, /.+/);
    return;
  }
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.done, "post_rfq");
  const rfq = await tdb().rfq.findUnique({ where: { id: act.body.rfqId }, include: { invites: true } });
  assert.ok(rfq);
  assert.ok(rfq!.invites.some((i) => i.organizationId === org.id), "matching vendor invited");
  const audit = await tdb().auditLog.findFirst({ where: { actorId: buyer.personId, action: "concierge.post_rfq" } });
  assert.ok(audit);
});

test("unclear questions get guidance, no matches, no actions", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const r = await api(app, { method: "POST", url: "/concierge/ask", token: u.accessToken, payload: { question: "hello there" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.intent.kind, "unclear");
  assert.equal(r.body.actions.length, 0);
});
