/**
 * Turns the live facts from `collect-tenant-facts.mjs` into one markdown
 * knowledge document per company under `docs/agent-knowledge/tenants/`.
 *
 *   node scripts/agent-knowledge/render-tenant-docs.mjs <facts.json>
 *
 * ⛔ RE-RUNNING IS SAFE AND IS MEANT TO BE ROUTINE. Only the region between
 * `<!-- generated:facts -->` and `<!-- /generated:facts -->` is rewritten;
 * everything a human (or a Claude session) added around it — the quirks, the
 * history, the staff notes — is preserved byte for byte. That is the whole
 * reason for the markers: live facts go stale, hard-won knowledge must not be
 * destroyed to refresh them.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

const BEGIN = "<!-- generated:facts -->";
const END = "<!-- /generated:facts -->";

function pretty(e164) {
  const d = String(e164 || "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(e164 || "");
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "company";
}

/**
 * ⛔ TWO COMPANIES CAN SHARE A NAME — and this platform has two called "Connect
 * Communications" (the admin tenant and a customer one). Named by company alone
 * they land on the same file, and the second write silently replaces the first
 * company's facts with the other's. Any name used more than once therefore gets
 * the tail of its tenant id appended, for BOTH of them — never just the loser,
 * or which document is "the plain one" would change with sort order.
 */
function buildSlugMap(tenants) {
  const counts = new Map();
  for (const t of tenants) {
    const base = slugify(t.name);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const map = new Map();
  for (const t of tenants) {
    const base = slugify(t.name);
    map.set(t.id, counts.get(base) > 1 ? `${base}-${String(t.id).slice(-6)}` : base);
  }
  return map;
}

function personName(u) {
  return (u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "").trim();
}

function keyDestination(o) {
  const kind = {
    extension: "an extension",
    queue: "a waiting line",
    ring_group: "a team of phones",
    voicemail: "voicemail",
    ivr: "another menu",
    announcement: "a recorded message",
    external_number: "an outside phone number",
    terminate: "hanging up",
    custom: "an outside phone number",
  }[o.destinationType] || o.destinationType;
  return o.label ? `${o.label} (${kind})` : kind;
}

function renderFacts(t) {
  const L = [];
  L.push(BEGIN);
  L.push("<!-- Rewritten by scripts/agent-knowledge/render-tenant-docs.mjs. Edit around this block, not inside it. -->");
  L.push("");

  L.push("## Their phone numbers");
  if (t.dids.length === 0) {
    L.push("- No number is currently routed to them on the phone system.");
  } else {
    for (const d of t.dids) L.push(`- ${pretty(d.e164)}`);
  }
  L.push("");

  L.push("## Their extensions");
  const active = t.extensions.filter((e) => e.status === "ACTIVE");
  if (active.length === 0) {
    L.push("- No active extensions.");
  } else {
    for (const e of active) {
      const bits = [`**${e.extNumber}** — ${e.displayName || "unnamed"}`];
      if (e.vmEmailEnabled === false) bits.push("voicemail-to-email off");
      L.push(`- ${bits.join(", ")}`);
    }
  }
  const inactive = t.extensions.length - active.length;
  if (inactive > 0) L.push(`- (${inactive} more extension${inactive === 1 ? "" : "s"} exist but are not active.)`);
  L.push("");

  L.push("## Texting");
  const sms = t.smsNumbers.filter((n) => n.active);
  if (sms.length === 0) {
    L.push("- Texting is not set up for this company.");
  } else {
    for (const n of sms) {
      L.push(`- ${pretty(n.phoneE164)}${n.isTenantDefault ? " — the number their texts go out from" : ""}`);
    }
  }
  L.push("");

  if (t.profiles.length > 0) {
    L.push("## Their phone menu");
    for (const pr of t.profiles) {
      const kind = pr.type === "business_hours" ? "open hours" : pr.type === "after_hours" ? "after hours" : pr.type;
      L.push(`- **${pr.name}** (${kind})${pr.directDialEnabled ? " — callers may dial an extension directly" : ""}`);
      for (const o of pr.options.filter((x) => x.enabled)) {
        L.push(`  - press ${o.optionDigit} → ${keyDestination(o)}`);
      }
    }
    L.push("");
  }

  L.push("## People with a Connect login");
  if (t.users.length === 0) {
    L.push("- Nobody has a login yet.");
  } else {
    for (const u of t.users.slice(0, 25)) {
      const who = personName(u);
      const yiddish = u.uiLanguage === "yi" ? ", reads the app in Yiddish" : "";
      L.push(`- ${who || u.email}${u.role === "TENANT_ADMIN" ? " — the account admin" : ""}${yiddish}`);
    }
  }
  L.push("");

  L.push("<!-- internal -->");
  L.push("## Staff-only notes");
  L.push(`- Connect tenant id: \`${t.id}\`; on the phone system as tenant ${t.pbxLink?.pbxTenantId ?? "unknown"} (${t.pbxLink?.status ?? "no link"}).`);
  L.push(`- Customer since ${new Date(t.createdAt).toISOString().slice(0, 10)}. ${t.callCount} calls in the last 90 days.`);
  if (t.billing) {
    L.push(`- Billed on day ${t.billing.billingDayOfMonth} of the month; autopay ${t.billing.autopayEnabled ? "on" : "off"}; texting billing ${t.billing.smsBillingEnabled ? "on" : "off"}.`);
  } else {
    L.push("- ⛔ No billing settings row at all — this account has never been set up for billing.");
  }
  for (const u of t.users) {
    if (u.role === "TENANT_ADMIN") L.push(`- Admin login: ${u.email}`);
  }
  L.push("<!-- /internal -->");
  L.push("");
  L.push(END);
  return L.join("\n");
}

function newDocument(t) {
  return [
    "---",
    `tenantId: ${t.id}`,
    `tenant: ${t.name}`,
    "---",
    "",
    `# ${t.name}`,
    "",
    "What the assistant should know before answering anyone from this company.",
    "Everything outside the staff-only block may be said to the customer.",
    "",
    renderFacts(t),
    "",
    "## What we have learned about them",
    "",
    "_Nothing recorded yet. Add what a new person on the support desk would need_",
    "_to know: how they work, what has gone wrong before, what they always ask._",
    "",
  ].join("\n");
}

async function main() {
  const factsPath = process.argv[2];
  if (!factsPath) {
    console.error("usage: node render-tenant-docs.mjs <facts.json>");
    process.exit(2);
  }
  const facts = JSON.parse(await fsp.readFile(factsPath, "utf8"));
  const outDir = path.join(process.cwd(), "docs", "agent-knowledge", "tenants");
  await fsp.mkdir(outDir, { recursive: true });

  let created = 0;
  let refreshed = 0;
  const index = [];
  const slugs = buildSlugMap(facts.tenants);
  for (const t of facts.tenants) {
    const slug = slugs.get(t.id);
    const file = path.join(outDir, `${slug}.md`);
    let text;
    let existing = null;
    try {
      existing = await fsp.readFile(file, "utf8");
    } catch { /* new document */ }

    if (existing && existing.includes(BEGIN) && existing.includes(END)) {
      const head = existing.slice(0, existing.indexOf(BEGIN));
      const tail = existing.slice(existing.indexOf(END) + END.length);
      text = head + renderFacts(t) + tail;
      refreshed++;
    } else if (existing) {
      // A hand-written document with no generated block: leave it completely
      // alone. Never overwrite knowledge somebody chose to write by hand.
      index.push({ slug, name: t.name, action: "left alone (hand-written)" });
      continue;
    } else {
      text = newDocument(t);
      created++;
    }
    await fsp.writeFile(file, text, "utf8");
    index.push({ slug, name: t.name, action: existing ? "facts refreshed" : "created" });
  }

  console.log(JSON.stringify({ created, refreshed, total: facts.tenants.length, files: index }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
