import test from "node:test";
import assert from "node:assert/strict";
import { readDndState, savedDndState, dndUnavailableMessage } from "./profileDnd";

test("a failed or unsupported read never becomes a confirmed Off state", () => {
  for (const reason of ["no_extension", "no_tenant", "tenant_not_linked", "route_helper_not_configured", "read_failed"]) {
    assert.deepEqual(readDndState({ supported: false, dnd: false, reason }), { status: "unavailable", reason });
    assert.ok(dndUnavailableMessage(reason).length > 10);
  }
  assert.equal(readDndState({ supported: true }).status, "unavailable");
});

test("live reads preserve both On and Off and identify the extension", () => {
  for (const enabled of [true, false]) {
    assert.deepEqual(readDndState({ supported: true, dnd: enabled, extension: "101" }),
      { status: "ready", enabled, extension: "101" });
  }
});

test("unconfirmed writes never promote the API's echoed requested state", () => {
  for (const dnd of [true, false]) {
    assert.equal(savedDndState({ confirmed: false, dnd }).status, "unavailable");
    assert.equal(savedDndState({ dnd }).status, "unavailable");
    assert.deepEqual(savedDndState({ confirmed: true, dnd }), { status: "ready", enabled: dnd });
  }
  assert.equal(savedDndState({ confirmed: true }).status, "unavailable");
});
