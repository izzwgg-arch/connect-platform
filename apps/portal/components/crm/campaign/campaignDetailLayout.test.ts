import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const memberCardPath = join(here, "CampaignMemberCard.tsx");
const importEventPath = join(here, "CampaignImportEventCard.tsx");
const detailPagePath = join(here, "../../../app/(platform)/crm/campaigns/[id]/page.tsx");

test("campaign member row uses action deep links instead of repeated open workspace text", () => {
  const src = readFileSync(memberCardPath, "utf8");
  assert.match(src, /workspace=sms/);
  assert.match(src, /workspace=email/);
  assert.match(src, /action=call/);
  assert.match(src, /aria-label=\{`Open workspace for/);
  assert.doesNotMatch(src, /<span>Open workspace<\/span>/);
});

test("campaign detail removes global quick action strip from detail page", () => {
  const src = readFileSync(detailPagePath, "utf8");
  assert.doesNotMatch(src, /CampaignQuickActionStrip/);
  assert.match(src, /Assign Me/);
  assert.match(src, /Assign Agent/);
});

test("campaign import event card renders formatted operational fields", () => {
  const src = readFileSync(importEventPath, "utf8");
  assert.match(src, /formatImportTimestamp/);
  assert.match(src, /Rows/);
  assert.match(src, /Created/);
  assert.match(src, /Updated/);
  assert.match(src, /Skipped/);
  assert.doesNotMatch(src, /JSON\.stringify/);
});
