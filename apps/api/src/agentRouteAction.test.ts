// M3 (Option A): pure route-target harvesting + fence logic. No DB, no helper.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRouteActionRequest, buildRouteTargets, isProvenTarget } from "./agentRouteAction";

test("schema: did required except for list_targets; destinationId required for retarget", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "list_targets" }).success, true);
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "route_inspect" }).success, false);
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "route_inspect", did: "845" }).success, true);
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "route_retarget", did: "845" }).success, false);
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "route_retarget", did: "845", destinationId: "456" }).success, true);
  assert.equal(AgentRouteActionRequest.safeParse({ ...base, action: "route_restore", did: "845" }).success, true);
  assert.equal(AgentRouteActionRequest.safeParse({ action: "list_targets", tenantId: "21" }).success, false); // agentActionId required
});

test("buildRouteTargets: distinct in-use destinations, connect/unknown excluded, labeled by DID", () => {
  const targets = buildRouteTargets([
    { did: "8455550001", description: "Main", destinationId: "456", mode: "pbx" },
    { did: "8455550002", description: "Sales", destinationId: "642", mode: "pbx" },
    { did: "8455550003", description: "Also main", destinationId: "456", mode: "pbx" }, // same dest as #1
    { did: "8455550004", description: "Connect routed", destinationId: "999", mode: "connect" }, // excluded
    { did: "8455550005", description: "Unknown", destinationId: "888", mode: "unknown" }, // excluded
    { did: "8455550006", description: "No dest", destinationId: null, mode: "pbx" }, // excluded
  ]);
  const ids = targets.map((t) => t.destinationId).sort();
  assert.deepEqual(ids, ["456", "642"]);
  const main = targets.find((t) => t.destinationId === "456")!;
  assert.equal(main.usedByDids.length, 2); // two DIDs share destination 456
  assert.ok(!targets.some((t) => t.destinationId === "999"), "connect-mode destination never offered");
});

test("isProvenTarget: only in-use destinations pass the fence", () => {
  const targets = buildRouteTargets([
    { did: "8455550001", description: "Main", destinationId: "456", mode: "pbx" },
    { did: "8455550002", description: "Sales", destinationId: "642", mode: "pbx" },
  ]);
  assert.equal(isProvenTarget(targets, "456"), true);
  assert.equal(isProvenTarget(targets, "642"), true);
  assert.equal(isProvenTarget(targets, "999"), false); // not in use ⇒ refused
  assert.equal(isProvenTarget(targets, "8"), false); // another tenant's dest ⇒ refused
  assert.equal(isProvenTarget([], "456"), false); // tenant with no routes ⇒ nothing passes
});
