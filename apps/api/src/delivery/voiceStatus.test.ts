import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoiceResponse, roundMinutes, type VoiceFragment, type VoiceScenario } from "./voiceStatus";

const ALL: VoiceScenario[] = ["matched_single", "matched_multiple", "unmatched", "no_order", "delivered", "delayed", "canceled", "after_hours", "system_error"];

function allText(frags: VoiceFragment[]): string {
  return frags.map((f) => ("text" in f ? f.text : "")).join(" ").toLowerCase();
}

test("every scenario yields a non-empty, ending-in-menu-or-collect plan", () => {
  for (const s of ALL) {
    const frags = buildVoiceResponse(s, { statusLabel: "on the way", active: true, etaMinFrom: 18, etaMinTo: 27, orderCount: 3 });
    assert.ok(frags.length > 0, `${s} produced nothing`);
    const last = frags[frags.length - 1];
    assert.ok(["menu", "collectDigits", "transfer", "hangup"].includes(last.type), `${s} ends with ${last.type}`);
  }
});

test("PRIVACY: no fragment ever speaks an address / payment / sensitive detail", () => {
  const banned = ["elm st", "unit", "apt", "street", "card", "payment", "cvv", "$"];
  for (const s of ALL) {
    const text = allText(buildVoiceResponse(s, { statusLabel: "on the way", active: true, etaMinFrom: 20, etaMinTo: 30 }));
    for (const b of banned) assert.equal(text.includes(b), false, `${s} spoke banned term "${b}"`);
  }
});

test("matched_single: status + ETA + main menu with text-link/repeat/store", () => {
  const frags = buildVoiceResponse("matched_single", { statusLabel: "out for delivery", active: true, etaMinFrom: 18, etaMinTo: 27 });
  assert.ok(frags.some((f) => f.type === "sayMinuteRange"));
  const menu = frags.find((f) => f.type === "menu") as any;
  assert.deepEqual(menu.options.map((o: any) => o.action), ["text_link", "repeat", "transfer_store"]);
});

test("ETA minutes round to nearest 5 for natural playback", () => {
  assert.equal(roundMinutes(18), 20);
  assert.equal(roundMinutes(27), 25);
  const frags = buildVoiceResponse("matched_single", { active: true, etaMinFrom: 18, etaMinTo: 27 });
  const eta = frags.find((f) => f.type === "sayMinuteRange") as any;
  assert.equal(eta.from, 20);
  assert.equal(eta.to, 25);
});

test("no ETA fragment when not active or ETA missing", () => {
  assert.equal(buildVoiceResponse("matched_single", { active: false }).some((f) => f.type === "sayMinuteRange"), false);
  assert.equal(buildVoiceResponse("delivered", { active: false }).some((f) => f.type === "sayMinuteRange"), false);
});

test("system_error fails safe: no error detail, only link + store options", () => {
  const frags = buildVoiceResponse("system_error");
  const text = allText(frags);
  assert.doesNotMatch(text, /error code|exception|null|undefined|stack|500/);
  const menu = frags.find((f) => f.type === "menu") as any;
  assert.deepEqual(menu.options.map((o: any) => o.action), ["text_link", "transfer_store"]);
});

test("multiple orders disambiguate by last-4 (non-sensitive)", () => {
  const frags = buildVoiceResponse("matched_multiple", { orderCount: 3 });
  const collect = frags.find((f) => f.type === "collectDigits") as any;
  assert.equal(collect.maxDigits, 4);
});

test("after-hours still self-serves status and offers callback", () => {
  const frags = buildVoiceResponse("after_hours", { statusLabel: "on the way", active: true, etaMinFrom: 10, etaMinTo: 20 });
  assert.match(allText(frags), /store is closed/);
  const menu = frags.find((f) => f.type === "menu") as any;
  assert.ok(menu.options.some((o: any) => o.action === "callback"));
});
