/**
 * Source guard: on every run-scoped route, OWNERSHIP IS RESOLVED FIRST.
 *
 * ⛔⛔ THE ORDER IS THE SECURITY PROPERTY, AND IT IS INVISIBLE TO A UNIT TEST OF ANY
 * ONE ROUTE. Checking a permission first answers 403 and validating a body first
 * answers 400 — either one tells a stranger their guessed run id reached a real
 * endpoint and got further than a nonexistent one would have. Both shapes were
 * really there and were caught by the chaos suite driving the routes in random
 * orders, not by anybody reading the code.
 *
 * This reads the route file's SOURCE because the defect is a line ORDER, which no
 * behavioural test of a single call can see and no type can express.
 *
 * ⛔ Comments are stripped before matching. Sixth time in this repo that a negative
 * guard has otherwise matched the doc block explaining the very rule it enforces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** ⛔ CRLF-normalised: this tree is checked out CRLF under core.autocrlf=true. */
const raw = readFileSync(join(__dirname, "deskPhoneRoutes.ts"), "utf8").replace(/\r\n/g, "\n");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}
const code = stripComments(raw);

/** Every handler body, keyed by its method + path. */
function handlers(): Array<{ route: string; body: string }> {
  const out: Array<{ route: string; body: string }> = [];
  const re = /app\.(get|post)\("([^"]+)",\s*async \(req: any, reply: any\) => \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index + m[0].length;
    // scan to the matching close brace
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    out.push({ route: `${m[1].toUpperCase()} ${m[2]}`, body: code.slice(start, i) });
  }
  return out;
}

const ALL = handlers();
/**
 * A run-scoped CUSTOMER route is one whose path carries the run id and is not staff.
 *
 * The /admin/ routes are deliberately cross-tenant — Loopcom support looking at a
 * customer's setup is the whole point of them — so ownRun(), which scopes to the
 * CALLER's tenant, would be exactly wrong there. They are held to the stricter rule
 * below instead: staff-gated on their first line.
 */
const RUN_SCOPED = ALL.filter(
  (h) => h.route.includes("/desk-phones/runs/:id") && !h.route.includes("/admin/"),
);
const STAFF = ALL.filter((h) => h.route.includes("/admin/"));

test("the guard can see the routes at all", () => {
  assert.ok(ALL.length >= 10, `only found ${ALL.length} routes — the matcher has drifted`);
  assert.ok(RUN_SCOPED.length >= 5, `only found ${RUN_SCOPED.length} run-scoped routes`);
});

test("every run-scoped route resolves ownership before anything else", () => {
  for (const h of RUN_SCOPED) {
    const own = h.body.indexOf("ownRun(req, reply)");
    assert.ok(own >= 0, `${h.route} does not call ownRun() — it must, or it can answer 403/400 for another customer's run`);

    for (const [what, needle] of [
      ["a permission check", "userHasActionPermission"],
      ["a permission helper", "allowedToSetUp("],
      ["the reset permission helper", "allowedToReset("],
      ["body validation", ".safeParse("],
      ["the legacy resolve+permission helper", "mayRunSetup("],
    ] as Array<[string, string]>) {
      const at = h.body.indexOf(needle);
      if (at < 0) continue;
      assert.ok(at > own, `${h.route} runs ${what} BEFORE ownRun() — a stranger would get something other than 404`);
    }
  }
});

test("no run-scoped route looks a run up by id without the caller's tenant", () => {
  for (const h of RUN_SCOPED) {
    // The only lookup of a run inside a run-scoped handler should be ownRun's.
    assert.ok(
      !/deskPhoneSetupRun\.findFirst/.test(h.body),
      `${h.route} looks up the run itself; it must use ownRun() so the tenant scope can never be forgotten`,
    );
    // Phone lookups must be scoped by BOTH the resolved run and the tenant.
    const phoneLookups = h.body.match(/deskPhoneSetupPhone\.findFirst\(\{[\s\S]*?\}\)/g) ?? [];
    for (const lookup of phoneLookups) {
      // Either scope is sound: the caller's tenant, or the run ownRun() already
      // proved is theirs. What is never sound is the raw id off the url.
      const scoped = lookup.includes("tenantId: user.tenantId")
        || /runId: run\.id/.test(lookup)
        || /where: \{ id: phone\.id \}/.test(lookup);
      assert.ok(scoped, `${h.route} reads a phone with no tenant and no proven-run scope: ${lookup.slice(0, 90)}`);
      assert.ok(
        !lookup.includes("String(req.params.id)"),
        `${h.route} scopes a phone by the RAW run id from the url instead of the run ownRun() proved is theirs`,
      );
    }
  }
});

test("the helper that checked a permission before ownership is gone and stays gone", () => {
  assert.ok(!/async function mayAuthorizeReset\b/.test(code),
    "mayAuthorizeReset() is back — it resolves the caller and checks the reset permission in one step, which forces 403 ahead of 404");
});

test("the reset route re-checks that the run is still running, after ownership", () => {
  const h = RUN_SCOPED.find((x) => x.route.includes("authorize-reset"));
  assert.ok(h, "the authorize-reset route disappeared");
  const own = h!.body.indexOf("ownRun(req, reply)");
  const status = h!.body.indexOf('run.status !== "running"');
  assert.ok(status > own,
    "authorize-reset must confirm the run is still open AFTER ownership, so a finished run of another customer still reads 404");
  assert.ok(h!.body.indexOf("allowedToReset(") > status,
    "the reset permission must be asked after the run is known to be theirs and open");
});

test("every staff route is gated on its FIRST decision, before it reads anything", () => {
  assert.ok(STAFF.length >= 2, `only found ${STAFF.length} staff routes`);
  for (const h of STAFF) {
    const gate = h.body.indexOf("isSuper(user)");
    assert.ok(gate >= 0, `${h.route} has no staff gate`);
    for (const read of ["db.deskPhoneSetupRun", "db.deskPhoneSetupPhone", "db.tenant", "db.extension"]) {
      const at = h.body.indexOf(read);
      if (at >= 0) {
        assert.ok(at > gate, `${h.route} reads ${read} BEFORE its staff gate`);
      }
    }
  }
});

test("only a staff route may take a tenant from the caller", () => {
  // A customer route deriving its tenant from the request is the inbound-crm-match
  // defect: the tenant must come from the signed session, never the payload.
  for (const h of ALL) {
    if (h.route.includes("/admin/")) continue;
    assert.ok(!/body\.data\.tenantId/.test(h.body), `${h.route} reads a tenant from its body`);
    assert.ok(!/req\.body[^\n]*tenantId/.test(h.body), `${h.route} reads a tenant from its body`);
  }
  // And the one that does is behind the staff gate.
  const admin = STAFF.find((h) => /body\.data\.tenantId/.test(h.body));
  if (admin) {
    assert.ok(admin.body.indexOf("isSuper(user)") < admin.body.indexOf("body.data.tenantId"),
      `${admin.route} reads the tenant before checking the caller is staff`);
  }
});
