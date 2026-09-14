/**
 * "We fixed it" may reach a customer only when OUR audit trail shows a real,
 * successful change on that ticket — never because a report says so.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { verifiedChangeOnTicket } from "./customerUpdate";
import { reviewCustomerMessage } from "./customerUpdateSafety";

function dbWith(rows: Array<Record<string, any>>) {
  return {
    auditLog: {
      findMany: async ({ where }: any) =>
        rows.filter((r) => r.entityType === where.entityType && r.entityId === where.entityId && r.action === where.action),
    },
  };
}

const ESC = "esc-1";
const write = (statusCode: number, entityId = ESC) => ({
  entityType: "AgentEscalation",
  entityId,
  action: "SUPPORT_AGENT_ACT_WRITE",
  metadata: { statusCode },
});

describe("verifiedChangeOnTicket", () => {
  test("a successful write on this ticket counts", async () => {
    assert.equal(await verifiedChangeOnTicket(dbWith([write(200)]), ESC), true);
    assert.equal(await verifiedChangeOnTicket(dbWith([write(204)]), ESC), true);
  });

  test("⛔ a refused or failed write does not count", async () => {
    assert.equal(await verifiedChangeOnTicket(dbWith([write(403), write(409), write(500)]), ESC), false);
  });

  test("⛔ a READ, another ticket's write, or no escalation id does not count", async () => {
    const rows = [{ ...write(200), action: "SUPPORT_AGENT_ACT_READ" }, write(200, "esc-other")];
    assert.equal(await verifiedChangeOnTicket(dbWith(rows), ESC), false);
    assert.equal(await verifiedChangeOnTicket(dbWith([write(200)]), null), false);
  });

  test("⛔ a database that cannot be read means NO change (fails closed)", async () => {
    assert.equal(await verifiedChangeOnTicket({}, ESC), false);
    assert.equal(await verifiedChangeOnTicket({ auditLog: { findMany: async () => { throw new Error("down"); } } }, ESC), false);
  });

  test("the gate lets a fix claim through only when a change was made", () => {
    const text = "We've fixed your voicemail greeting. Please try calling in and let us know if it sounds right.";
    const base = { text, tenantName: "Trust Bookkeepings", allTenantNames: ["Trust Bookkeepings"] };
    assert.equal(reviewCustomerMessage(base).ok, false);
    assert.equal(reviewCustomerMessage({ ...base, changeWasMade: true }).ok, true);
  });
});

describe("source guard", () => {
  test("⛔ rewriteAndGate passes the audited changeWasMade into the gate and tells the model", () => {
    const src = fs.readFileSync(path.join(__dirname, "customerUpdate.ts"), "utf8").replace(/\r\n/g, "\n");
    const fn = src.slice(src.indexOf("export async function rewriteAndGate"));
    assert.match(fn, /const changeWasMade = await verifiedChangeOnTicket\(db, row\.escalationId\)/);
    assert.match(fn, /reviewCustomerMessage\(\{ text, tenantName, allTenantNames, changeWasMade \}\)/);
    assert.match(fn, /a change WAS made/);
  });
});
