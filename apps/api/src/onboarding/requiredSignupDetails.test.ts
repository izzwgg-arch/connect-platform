import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requiredSignupDetailsProblem } from "./requiredSignupDetails";
import { uniqueTenantName } from "./uniqueTenantName";

// CRLF-safe: core.autocrlf checks .ts out with \r\n on this machine.
const src = (p: string) => readFileSync(join(__dirname, p), "utf8").replace(/\r\n/g, "\n");
// ⛔ Comments in these files quote the very identifiers the guards look for
// (that is what they document), so a naive match passes on the prose and hides
// a real regression. Strip comments before asserting on code.
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const GOOD = {
  companyName: "Cannvestments",
  address: "30 Robert Pitt Dr",
  addressCity: "Monsey",
  addressState: "NY",
  addressZip: "10952",
};

test("a complete sign-up passes", () => {
  assert.equal(requiredSignupDetailsProblem(GOOD), null);
});

test("a missing company name is refused", () => {
  for (const companyName of [undefined, null, "", "  ", "A"]) {
    const p = requiredSignupDetailsProblem({ ...GOOD, companyName });
    assert.equal(p?.field, "companyName", `accepted companyName=${JSON.stringify(companyName)}`);
  }
});

test("a missing 911 address is refused, field by field", () => {
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, address: "" })?.field, "address");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressCity: "" })?.field, "addressCity");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressState: "" })?.field, "addressState");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressZip: "" })?.field, "addressZip");
});

test("a street with no NUMBER is refused — VoIP.ms answers missing_street_number", () => {
  const p = requiredSignupDetailsProblem({ ...GOOD, address: "Robert Pitt Dr" });
  assert.equal(p?.field, "address");
  assert.match(p!.message, /street number/);
});

test("a two-letter state is required, not any old text", () => {
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressState: "New York" })?.field, "addressState");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressState: "N" })?.field, "addressState");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressState: "ny" }), null, "lower case is fine");
});

test("the ZIP must be a real five-digit ZIP", () => {
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressZip: "1095" })?.field, "addressZip");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressZip: "abcde" })?.field, "addressZip");
  assert.equal(requiredSignupDetailsProblem({ ...GOOD, addressZip: "10952-1234" }), null, "ZIP+4 is fine");
});

test("a LEGACY one-line address still passes — old drafts must stay finishable", () => {
  // Drafts saved before the split fields existed carry the whole address in
  // `address`; parseServiceAddressLine reads it and provisioning accepts it, so
  // refusing here would turn an old-but-valid draft into a dead link.
  const p = requiredSignupDetailsProblem({
    companyName: "Acme",
    address: "1 Main St, Monsey, NY 10952",
    addressCity: "", addressState: "", addressZip: "",
  });
  assert.equal(p, null);
});

test("a one-line address MISSING its city/state/zip is still refused", () => {
  const p = requiredSignupDetailsProblem({
    companyName: "Acme", address: "1 Main Street",
    addressCity: "", addressState: "", addressZip: "",
  });
  assert.ok(p, "an unparseable one-liner must not pass as a 911 address");
});

test("every refusal names the field and says 911 is why", () => {
  const p = requiredSignupDetailsProblem({ ...GOOD, addressCity: "" });
  assert.match(p!.message, /911/);
  assert.ok(p!.message.length > 25);
});

// ── Duplicate tenant names ──────────────────────────────────────────────────

function fakeDb(existing: string[]) {
  return {
    tenant: {
      findFirst: async ({ where }: any) => {
        const want = String(where.name.equals).toLowerCase();
        return existing.some((n) => n.toLowerCase() === want) ? { id: "x" } : null;
      },
    },
  };
}

test("a free name is used unchanged", async () => {
  assert.equal(await uniqueTenantName(fakeDb(["Other"]), "Cannvestments"), "Cannvestments");
});

test("a taken name gets a 2, and the FIRST holder is never renamed", async () => {
  assert.equal(await uniqueTenantName(fakeDb(["a plus center"]), "a plus center"), "a plus center 2");
});

test("numbering continues past 2", async () => {
  const db = fakeDb(["a plus center", "a plus center 2", "a plus center 3"]);
  assert.equal(await uniqueTenantName(db, "a plus center"), "a plus center 4");
});

test("the collision is case-insensitive — the real 2026-08-18 case", async () => {
  // Live rows were "A plus center" (April) and "a plus center" (August).
  assert.equal(await uniqueTenantName(fakeDb(["A plus center"]), "a plus center"), "a plus center 2");
});

test("a different company that merely starts the same does NOT collide", async () => {
  assert.equal(await uniqueTenantName(fakeDb(["Acme Holdings"]), "Acme"), "Acme");
});

test("removed tenants still hold their name", async () => {
  // uniqueTenantName must not filter on pbxRemovedAt — a removed tenant still
  // answers name lookups, so reusing its name recreates the ambiguity.
  assert.doesNotMatch(code("./uniqueTenantName.ts"), /pbxRemovedAt/);
});

// ── Call-site guards ────────────────────────────────────────────────────────

test("the submit route actually runs the required-details gate", () => {
  const routes = src("./publicRoutes.ts");
  assert.match(routes, /requiredSignupDetailsProblem\(/, "submit never calls the gate");
  assert.match(routes, /detailsProblem\.message/, "the gate's reason never reaches the customer");
});

test("BOTH tenant-creation paths number a duplicate name", () => {
  // The recurring defect shape here is a fix applied to one of two paths.
  assert.match(src("./onboardingPayment.ts"), /uniqueTenantName\(/, "checkout path creates unnumbered duplicates");
  assert.match(src("./setupOrchestrator.ts"), /uniqueTenantName\(/, "PBX-build path creates unnumbered duplicates");
});
