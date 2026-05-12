import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDesktopVoicemailInboxProbePath,
  nextCooldownMsForFailure,
  NotificationProbeBackoff,
} from "./desktopNotificationPoll";

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
