import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontMatter,
  parseKnowledgeDoc,
  capKnowledgeText,
  renderKnowledgeBlock,
  DEFAULT_KNOWLEDGE_CHARS_PER_DOC,
} from "./agentKnowledgeDoc";

test("front matter is read and stripped", () => {
  const { meta, rest } = parseFrontMatter(`---\ntenantId: abc123\ntenant: "A Plus Center"\n---\n# Hello\nbody\n`);
  assert.equal(meta.tenantid, "abc123");
  assert.equal(meta.tenant, "A Plus Center");
  assert.equal(rest.trim(), "# Hello\nbody");
});

test("a document with no front matter is still readable", () => {
  const { meta, rest } = parseFrontMatter("# Just a doc\n");
  assert.deepEqual(meta, {});
  assert.equal(rest, "# Just a doc\n");
});

test("internal sections never survive into the customer-safe body", () => {
  const doc = parseKnowledgeDoc({
    slug: "acme",
    text: [
      "---",
      "tenantId: t_acme",
      "tenant: Acme",
      "---",
      "They have three extensions.",
      "<!-- internal -->",
      "Their card declined twice; Gesheft had the same problem.",
      "<!-- /internal -->",
      "Their main number is (845) 555-0000.",
    ].join("\n"),
  });
  assert.deepEqual(doc.errors, []);
  assert.match(doc.body, /three extensions/);
  assert.match(doc.body, /845\) 555-0000/);
  assert.doesNotMatch(doc.body, /declined/);
  assert.doesNotMatch(doc.body, /Gesheft/);
  assert.match(doc.internalBody, /declined twice/);
});

test("⛔ an UNCLOSED internal marker fails closed — no staff text leaks", () => {
  const doc = parseKnowledgeDoc({
    slug: "acme",
    text: "---\ntenantId: t_acme\n---\nSafe line.\n<!-- internal -->\nSecret: the AMI password is in /root.\n",
  });
  assert.ok(doc.errors.some((e) => /unbalanced/i.test(e)), "must report the imbalance");
  assert.match(doc.body, /Safe line/);
  assert.doesNotMatch(doc.body, /AMI password/);
  assert.match(doc.internalBody, /AMI password/);
});

test("a tenant document that names no company is refused", () => {
  const doc = parseKnowledgeDoc({ slug: "mystery", text: "# Some notes\nThings.\n" });
  assert.ok(doc.errors.some((e) => /must name its company/.test(e)));
});

test("the system document is recognised by slug and rejects a tenantId", () => {
  const ok = parseKnowledgeDoc({ slug: "system", text: "# Platform\nHow Connect works.\n" });
  assert.equal(ok.scope, "system");
  assert.deepEqual(ok.errors, []);

  const bad = parseKnowledgeDoc({ slug: "system", text: "---\ntenantId: t_acme\n---\n# Platform\nx\n" });
  assert.ok(bad.errors.some((e) => /must not carry a tenantId/.test(e)));
});

test("title falls back to the first heading, then to the company name", () => {
  assert.equal(parseKnowledgeDoc({ slug: "system", text: "# Connect basics\nx" }).title, "Connect basics");
  assert.equal(
    parseKnowledgeDoc({ slug: "acme", text: "---\ntenantId: t\ntenant: Acme Ltd\n---\nno heading here" }).title,
    "Acme Ltd",
  );
});

test("capping cuts on a section boundary, never mid-sentence", () => {
  const text = ["## One", "a".repeat(50), "## Two", "b".repeat(50), "## Three", "c".repeat(50)].join("\n");
  const out = capKnowledgeText(text, 80);
  assert.ok(out.truncated);
  assert.match(out.text, /^## One/);
  assert.doesNotMatch(out.text, /## Two/, "a partially-included section must be dropped whole");
});

test("capping a single oversized section still returns something", () => {
  const out = capKnowledgeText("## Big\n" + "x".repeat(500), 100);
  assert.ok(out.truncated);
  assert.ok(out.text.length > 0);
  assert.ok(out.text.length <= 100);
});

test("no documents means no block — the agent behaves exactly as before", () => {
  assert.equal(renderKnowledgeBlock({ audience: "customer", system: null, tenant: null }), null);
  assert.equal(renderKnowledgeBlock({ audience: "customer", system: { title: "t", body: "   " } }), null);
});

test("the customer block carries both documents and the anti-invention rule", () => {
  const block = renderKnowledgeBlock({
    audience: "customer",
    system: { title: "Connect", body: "Voicemail arrives by email." },
    tenant: { title: "Acme", body: "Acme has 3 extensions." },
    tenantName: "Acme",
  });
  assert.ok(block);
  assert.match(block!, /Voicemail arrives by email/);
  assert.match(block!, /Acme has 3 extensions/);
  assert.match(block!, /never invent a detail/i);
  assert.match(block!, /never mention another company/i);
});

test("⛔ staff-only text reaches the internal audience and NEVER the customer one", () => {
  const docs = {
    system: { title: "Connect", body: "Public.", internalBody: "Platform secret." },
    tenant: { title: "Acme", body: "Public too.", internalBody: "Owes $90." },
  };
  const customer = renderKnowledgeBlock({ ...docs, audience: "customer" })!;
  assert.doesNotMatch(customer, /secret|Owes/i);

  const internal = renderKnowledgeBlock({ ...docs, audience: "internal" })!;
  assert.match(internal, /Platform secret/);
  assert.match(internal, /Owes \$90/);
});

test("each document is capped independently so one long file cannot crowd out the other", () => {
  const block = renderKnowledgeBlock({
    audience: "customer",
    system: { title: "Connect", body: "## S\n" + "s".repeat(5000) },
    tenant: { title: "Acme", body: "## T\nthe tenant fact" },
    maxCharsPerDoc: 200,
  })!;
  assert.match(block, /the tenant fact/, "the tenant document must survive a huge system document");
});

test("the default per-document budget is a sane prompt size", () => {
  assert.ok(DEFAULT_KNOWLEDGE_CHARS_PER_DOC >= 4000 && DEFAULT_KNOWLEDGE_CHARS_PER_DOC <= 40000);
});
