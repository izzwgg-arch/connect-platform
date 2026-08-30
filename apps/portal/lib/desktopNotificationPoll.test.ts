import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildDesktopVoicemailInboxProbePath,
  decideMessageToasts,
  MAX_MESSAGE_TOASTS_PER_POLL,
  nextCooldownMsForFailure,
  NotificationProbeBackoff,
  type ChatThreadProbe,
} from "./desktopNotificationPoll";

// Source-reading guards must normalise CRLF (Windows checkout) — see
// [[source-reading-tests-must-normalise-crlf]].
function readSource(rel: string): string {
  return readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

describe("decideMessageToasts — per-message desktop notifications", () => {
  const thread = (over: Partial<ChatThreadProbe>): ChatThreadProbe => ({
    id: "t1",
    type: "SMS",
    participantName: "Shia W",
    lastMessage: "Lock box is 1445?",
    lastAt: "2026-08-30T12:00:00.000Z",
    isNew: true,
    externalSmsE164: "+18453240113",
    ...over,
  });

  it("first poll is a silent baseline — no toast storm at startup", () => {
    const { next, toasts } = decideMessageToasts(null, [thread({})]);
    assert.equal(toasts.length, 0);
    assert.equal(next.get("t1"), "2026-08-30T12:00:00.000Z");
  });

  it("a NEW MESSAGE in an EXISTING thread toasts — the FixUp regression case", () => {
    // The old bridge diffed thread IDS, so this exact shape (same thread id,
    // newer lastAt) produced NO notification, ever.
    const previous = new Map([["t1", "2026-08-30T11:00:00.000Z"]]);
    const { toasts } = decideMessageToasts(previous, [thread({})]);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, "Shia W");
    assert.equal(toasts[0].body, "Lock box is 1445?");
    assert.equal(toasts[0].route, "/sms?phone=%2B18453240113");
    assert.equal(toasts[0].key, "msg:t1:2026-08-30T12:00:00.000Z");
  });

  it("a brand-new thread (not in the baseline) still toasts", () => {
    const previous = new Map([["other", "2026-08-30T09:00:00.000Z"]]);
    const { toasts } = decideMessageToasts(previous, [thread({})]);
    assert.equal(toasts.length, 1);
  });

  it("own outbound reply moves lastAt but is NOT a notification (isNew false)", () => {
    const previous = new Map([["t1", "2026-08-30T11:00:00.000Z"]]);
    const { toasts } = decideMessageToasts(previous, [thread({ isNew: false })]);
    assert.equal(toasts.length, 0);
  });

  it("unchanged lastAt never re-fires, even while the thread stays unread", () => {
    const previous = new Map([["t1", "2026-08-30T12:00:00.000Z"]]);
    const { toasts } = decideMessageToasts(previous, [thread({})]);
    assert.equal(toasts.length, 0);
  });

  it("non-SMS threads route to /chat", () => {
    const previous = new Map([["t1", "old"]]);
    const { toasts } = decideMessageToasts(previous, [thread({ type: "DM", externalSmsE164: null })]);
    assert.equal(toasts[0].route, "/chat");
  });

  it("toasts are bounded per poll — the pill carries the rest", () => {
    const previous = new Map<string, string>();
    const many = Array.from({ length: 10 }, (_, i) => thread({ id: `t${i}`, lastAt: `2026-08-30T12:00:0${i % 10}.000Z` }));
    const { toasts } = decideMessageToasts(previous, many);
    assert.equal(toasts.length, MAX_MESSAGE_TOASTS_PER_POLL);
  });

  it("empty name/preview fall back to plain words, never blank toasts", () => {
    const previous = new Map([["t1", "old"]]);
    const { toasts } = decideMessageToasts(previous, [thread({ participantName: "  ", lastMessage: "" })]);
    assert.equal(toasts[0].title, "New message");
    assert.equal(toasts[0].body, "New message");
  });
});

describe("DesktopNotificationsBridge wiring (source guards)", () => {
  const src = readSource("components/DesktopNotificationsBridge.tsx");

  it("polls /chat/threads — never the thread-collapsing /sms/messages helper", () => {
    assert.ok(src.includes('"/chat/threads"'), "bridge must poll /chat/threads");
    assert.ok(!src.includes("fetchTenantSmsInboxThreads"), "the old /sms/messages-based helper collapses every inbound thread into one entry keyed by the tenant's own number");
  });

  it("message detection goes through decideMessageToasts (per-message, not thread-id diff)", () => {
    assert.ok(src.includes("decideMessageToasts("), "bridge must use the tested per-message decision");
    assert.ok(!/previous\.has\(\s*thread\.id\s*\)/.test(src), "the thread-id set diff is the bug that silenced every message in an existing conversation");
  });

  it("runs in EVERY desktop window — the mini dialer must notify too", () => {
    assert.ok(!src.includes('windowKind !== "full"'), "the full-window-only gate left mini-dialer users with zero message notifications");
    assert.ok(src.includes("isDesktopWindow()"), "desktop gate stays — browser tabs get no toasts by design");
  });
});

describe("DesktopMiniDialer tab pills (source guards)", () => {
  const src = readSource("components/DesktopMiniDialer.tsx");

  it("the bottom tab bar renders per-tab unread pills", () => {
    assert.ok(src.includes("mini-tab-pill"), "tab pill markup/CSS must exist");
    assert.ok(src.includes("tabBadges"), "per-tab badge counts must exist");
  });

  it("pills cover chat, voicemail and missed calls — the phone app's three", () => {
    const memo = src.slice(src.indexOf("const tabBadges"), src.indexOf("const tabBadges") + 600);
    assert.ok(memo.includes("messages:"), "chat unread pill");
    assert.ok(memo.includes("voicemail:"), "voicemail unheard pill");
    assert.ok(memo.includes("calls:"), "missed-call pill");
  });
});

describe("buildDesktopVoicemailInboxProbePath", () => {
  it("returns null for SUPER_ADMIN without a real tenant", () => {
    assert.equal(
      buildDesktopVoicemailInboxProbePath({
        folder: "inbox",
        page: 1,
        tenantId: "local",
        backendJwtRole: "SUPER_ADMIN",
      }),
      null,
    );
    assert.equal(
      buildDesktopVoicemailInboxProbePath({
        folder: "inbox",
        page: 1,
        tenantId: "",
        backendJwtRole: "SUPER_ADMIN",
      }),
      null,
    );
  });

  it("includes tenantId for SUPER_ADMIN with workspace tenant", () => {
    const p = buildDesktopVoicemailInboxProbePath({
      folder: "inbox",
      page: 1,
      tenantId: "tid_workspace",
      backendJwtRole: "SUPER_ADMIN",
    });
    assert.ok(p);
    assert.ok(p!.includes("tenantId=tid_workspace"));
    assert.ok(!p!.includes("pageSize=10"));
  });

  it("omits tenantId for non-super-admin (JWT-owned scope on server)", () => {
    const p = buildDesktopVoicemailInboxProbePath({
      folder: "inbox",
      page: 1,
      tenantId: "tid_workspace",
      backendJwtRole: "USER",
    });
    assert.ok(p);
    assert.ok(!p!.includes("tenantId="));
  });
});

describe("nextCooldownMsForFailure", () => {
  it("ramps exponentially then caps", () => {
    assert.equal(nextCooldownMsForFailure(1), 30_000);
    assert.equal(nextCooldownMsForFailure(2), 60_000);
    assert.equal(nextCooldownMsForFailure(3), 120_000);
    assert.ok(nextCooldownMsForFailure(99) <= 30 * 60 * 1000);
  });
});

describe("NotificationProbeBackoff", () => {
  it("applies cooldown per probe independently", () => {
    const b = new NotificationProbeBackoff();
    assert.equal(b.shouldSkip("sms"), false);
    b.recordFailure("sms", 500);
    assert.equal(b.shouldSkip("sms"), true);
    assert.equal(b.shouldSkip("voicemail"), false);
    b.recordFailure("voicemail", 400);
    assert.equal(b.shouldSkip("voicemail"), true);
  });

  it("clears failures on success", () => {
    const b = new NotificationProbeBackoff();
    b.recordFailure("sms", 500);
    assert.equal(b.shouldSkip("sms"), true);
    b.recordSuccess("sms");
    assert.equal(b.shouldSkip("sms"), false);
  });
});
