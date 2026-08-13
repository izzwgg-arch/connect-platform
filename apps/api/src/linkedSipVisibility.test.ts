import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupLinkedSipAccountRows,
  cdrRowMatchesExtensionNumbers,
  cdrRowInLinkedSipScopes,
  type LinkedSipCallScope,
} from "./linkedSipVisibility";

const HOME = "cmnlgrykx000fp9pa90gohk96"; // Trust Bookkeepings shape
const FOREIGN = "cmnlgryjk0003p9pabtu1z1oj"; // Trimpro shape

describe("groupLinkedSipAccountRows", () => {
  it("groups cross-tenant rows by foreign tenant", () => {
    const map = groupLinkedSipAccountRows(HOME, [
      { tenantId: FOREIGN, extNumber: "102", extStatus: "ACTIVE" },
      { tenantId: FOREIGN, extNumber: "103", extStatus: "ACTIVE" },
      { tenantId: "otherTenant", extNumber: "201", extStatus: "ACTIVE" },
    ]);
    assert.deepEqual(map.get(FOREIGN), ["102", "103"]);
    assert.deepEqual(map.get("otherTenant"), ["201"]);
  });

  it("drops same-tenant rows — an extra line inside the home tenant is not a cross-tenant scope", () => {
    const map = groupLinkedSipAccountRows(HOME, [
      { tenantId: HOME, extNumber: "105", extStatus: "ACTIVE" },
    ]);
    assert.equal(map.size, 0);
  });

  it("drops inactive extensions but keeps rows with unknown status", () => {
    const map = groupLinkedSipAccountRows(HOME, [
      { tenantId: FOREIGN, extNumber: "102", extStatus: "DISABLED" },
      { tenantId: FOREIGN, extNumber: "104" }, // status not loaded → keep
    ]);
    assert.deepEqual(map.get(FOREIGN), ["104"]);
  });

  it("drops blank/garbage extension numbers and dedupes", () => {
    const map = groupLinkedSipAccountRows(HOME, [
      { tenantId: FOREIGN, extNumber: "  ", extStatus: "ACTIVE" },
      { tenantId: FOREIGN, extNumber: null, extStatus: "ACTIVE" },
      { tenantId: FOREIGN, extNumber: "102", extStatus: "ACTIVE" },
      { tenantId: FOREIGN, extNumber: "102", extStatus: "ACTIVE" },
    ]);
    assert.deepEqual(map.get(FOREIGN), ["102"]);
  });
});

describe("cdrRowMatchesExtensionNumbers", () => {
  it("matches on fromNumber (outgoing leg)", () => {
    assert.equal(cdrRowMatchesExtensionNumbers({ fromNumber: "102", toNumber: "8455551234" }, ["102"]), true);
  });

  it("matches on toNumber (direct incoming leg)", () => {
    assert.equal(cdrRowMatchesExtensionNumbers({ fromNumber: "8455551234", toNumber: "102" }, ["102"]), true);
  });

  it("matches a queue/ring-group call via channelsSeen when from/to carry no extension", () => {
    const row = {
      fromNumber: "8455551234",
      toNumber: "9293598299",
      channelsSeen: ["PJSIP/T11_102_1-0000abcd", "Local/900@T11_cos-all-0000ef01"],
      dcontextsSeen: ["T11_cos-all"],
      dcontext: "T11_cos-all",
    };
    assert.equal(cdrRowMatchesExtensionNumbers(row, ["102"]), true);
  });

  it("does not false-match an extension embedded in a longer number", () => {
    // "102" inside "8451025555" must not match — digit-boundary rule.
    const row = { fromNumber: "8451025555", toNumber: "300", channelsSeen: [], dcontext: "" };
    assert.equal(cdrRowMatchesExtensionNumbers(row, ["102"]), false);
  });

  it("returns false with no extensions", () => {
    assert.equal(cdrRowMatchesExtensionNumbers({ fromNumber: "102" }, []), false);
  });
});

describe("cdrRowInLinkedSipScopes", () => {
  const scopes: LinkedSipCallScope[] = [
    { tenantKeys: [FOREIGN, "vpbx:trimpro"], extensions: ["102"] },
  ];

  it("allows a foreign-tenant row involving the linked extension (cuid form)", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: FOREIGN, fromNumber: "102", toNumber: "8455551234" }, scopes), true);
  });

  it("allows the vpbx:{slug} tenant form", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: "vpbx:trimpro", fromNumber: "9175550000", toNumber: "102" }, scopes), true);
  });

  it("refuses a foreign-tenant row for a DIFFERENT extension — tenant membership alone is never enough", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: FOREIGN, fromNumber: "101", toNumber: "8455551234" }, scopes), false);
  });

  it("refuses rows from unrelated tenants even when the extension number coincides", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: "someOtherTenant", fromNumber: "102", toNumber: "8455551234" }, scopes), false);
  });

  it("refuses rows with no tenantId", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: null, fromNumber: "102" }, scopes), false);
  });

  it("refuses everything when there are no scopes (switch off / no links)", () => {
    assert.equal(cdrRowInLinkedSipScopes({ tenantId: FOREIGN, fromNumber: "102" }, []), false);
  });
});
