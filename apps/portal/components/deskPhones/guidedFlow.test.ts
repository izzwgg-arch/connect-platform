import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  candidateStateLine, classifyStuck, connectedAsMapped, extensionsWithPhones, normalizeSticker, orderCandidates,
  screenForFocused, stickerEndsIn, stickerMatches, type GuidedPhone,
} from "./guidedFlow";

const ph = (over: Partial<GuidedPhone> = {}): GuidedPhone => ({
  id: "p1", mac: "c0:74:ad:8c:60:5f", model: "SIP-T42S", vendor: "yealink", extNumber: "101", displayName: "Sarah",
  status: "working", note: null, needsAttention: false, connectedNow: false, registeredAsExt: null, ip: "192.168.6.170", ...over,
});

describe("sticker check — the last 4 of the MAC", () => {
  it("formats and matches regardless of case, colons or spaces", () => {
    assert.equal(stickerEndsIn("C0:74:AD:8C:60:5F"), "60 5F");
    assert.equal(stickerMatches("c074ad8c605f", "60 5f"), true);
    assert.equal(stickerMatches("c074ad8c605f", "605F"), true);
    assert.equal(stickerMatches("c074ad8c605f", "65 4E"), false);
    assert.equal(stickerMatches("c074ad8c605f", "5F"), false, "too short is never a match");
    assert.equal(stickerMatches(null, "605F"), false);
  });
  it("⛔ a typed letter O is a zero (Izzy, 2026-09-18), and noise around the digits is ignored", () => {
    assert.equal(normalizeSticker("6O 5f"), "605F");
    assert.equal(normalizeSticker("MAC: c0-74-ad-8c-6o-5f"), "C074AD8C605F");
    assert.equal(stickerMatches("c074ad8c605f", "6O5F"), true, "O typed for 0");
    assert.equal(stickerMatches("c074ad8c605f", "oo5f"), false, "O→0 only helps when the phone really has zeros");
    assert.equal(stickerMatches("c074ad8c0050", "oo5o"), true);
    assert.equal(stickerMatches("c074ad8c605f", "MAC C0:74:AD:8C:60:5F"), true, "the whole sticker line is fine too");
  });
});

describe("connectedAsMapped — green only from the phone's own registration AS the mapped extension", () => {
  it("the 2026-09-17 lie cannot happen: a phone not registered itself is never connected", () => {
    assert.equal(connectedAsMapped(ph({ connectedNow: false })), false);
    assert.equal(connectedAsMapped(ph({ connectedNow: null })), false);
  });
  it("registered as the mapped extension → connected; as another extension → not done", () => {
    assert.equal(connectedAsMapped(ph({ connectedNow: true, registeredAsExt: "101" })), true);
    assert.equal(connectedAsMapped(ph({ connectedNow: true, registeredAsExt: "104" })), false);
    assert.equal(connectedAsMapped(ph({ connectedNow: true, registeredAsExt: null })), true, "cold mirror fallback keeps the old answer");
    assert.equal(connectedAsMapped(ph({ connectedNow: true, extNumber: null })), false, "unmapped is never done");
  });
});

describe("screenForFocused", () => {
  it("connected wins over everything the driver says", () => {
    assert.equal(screenForFocused(ph({ connectedNow: true, registeredAsExt: "101", needsAttention: true }), [{ kind: "password", phoneId: "p1", label: "x", message: "" }], { ticking: true }), "connected");
  });
  it("stuck (server gave up) beats a pending password ask", () => {
    assert.equal(screenForFocused(ph({ needsAttention: true }), [{ kind: "password", phoneId: "p1", label: "x", message: "" }], { ticking: true }), "stuck");
  });
  it("a password ask for THIS phone is the person's factory reset; for another phone it is not", () => {
    assert.equal(screenForFocused(ph(), [{ kind: "password", phoneId: "p1", label: "x", message: "" }], { ticking: true }), "reset");
    assert.equal(screenForFocused(ph(), [{ kind: "password", phoneId: "p2", label: "x", message: "" }], { ticking: true }), "connecting");
  });
  it("otherwise: the robot is working while ticking; reset when nothing is running yet", () => {
    assert.equal(screenForFocused(ph(), [], { ticking: true }), "connecting");
    assert.equal(screenForFocused(ph(), [], { ticking: false }), "reset");
  });
});

describe("classifyStuck — wording only, from the server's own note", () => {
  it("names the four families", () => {
    assert.equal(classifyStuck("This phone is still registered to another provider's cloud"), "old_provider");
    assert.equal(classifyStuck("Yealink says another company claimed it; a release was filed"), "old_provider");
    assert.equal(classifyStuck("The phone is locked with a password we don't have"), "password");
    assert.equal(classifyStuck("Loopcom can't set this model of phone up automatically yet. Loopcom Support can connect it for you"), "unsupported");
    assert.equal(classifyStuck("It took its settings but never checked in"), "not_checking_in");
    assert.equal(classifyStuck(null), "not_checking_in");
  });
});

describe("the pick screen", () => {
  it("orders fresh/unassigned first, phones already on another desk last, hides none", () => {
    const a = ph({ id: "a", connectedNow: true, registeredAsExt: "104", extNumber: "104" });
    const b = ph({ id: "b", connectedNow: false });
    const c = ph({ id: "c", connectedNow: true, registeredAsExt: "101", extNumber: "103" });
    assert.deepEqual(orderCandidates([a, b, c]).map((p) => p.id), ["b", "c", "a"]);
  });
  it("state lines are honest and never claim fresh without the robot having seen it", () => {
    assert.equal(candidateStateLine(ph(), null).text, "Not connected yet");
    assert.equal(candidateStateLine(ph(), true).text, "Fresh out of the box — no reset needed");
    assert.equal(candidateStateLine(ph(), false).tone, "warn");
    assert.equal(candidateStateLine(ph({ connectedNow: true, registeredAsExt: "104" }), true).text, "Already connected as ext 104");
  });
  it("extensionsWithPhones reads what is REALLY on each extension, from registrations", () => {
    const exts = [{ id: "e1", extNumber: "101", displayName: "Sarah" }, { id: "e2", extNumber: "102", displayName: "Moshe" }];
    const out = extensionsWithPhones(exts, [ph({ connectedNow: true, registeredAsExt: "101" }), ph({ id: "p2", extNumber: "102", connectedNow: false })]);
    assert.equal(out[0].phone?.id, "p1");
    assert.equal(out[1].phone, null, "an assignment record is not a connection");
  });
});
