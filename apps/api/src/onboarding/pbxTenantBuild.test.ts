// Stress tests for the onboarding VitalPBX tenant build (pbxTenantBuild.ts +
// panelClient.ts) against a stateful FAKE PANEL that emulates the real
// VitalPBX panel's behaviors: login cookies, CSRF tokens embedded in rendered
// forms, module puts answering {state:"success"}, hidden error dialogs inside
// "success" responses, option lists used for existence verification, the CSV
// extension importer, per-extension edit forms, and Apply Changes.

import test from "node:test";
import assert from "node:assert/strict";
import { PanelSession } from "./panelClient";
import { buildPbxTenant, slugify, type PbxBuildJob } from "./pbxTenantBuild";

const CSRF = "deadbeefdeadbeefdeadbeef";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Fields = Array<[string, string]>;
const get = (f: Fields, k: string) => f.find(([n]) => n === k)?.[1];
const getAll = (f: Fields, k: string) => f.filter(([n]) => n === k).map(([, v]) => v);

class FakePanel {
  // knobs for failure-injection
  failTrunkWithDialog = false;
  omitTrunkOption = false;
  failCsvImport = false;
  suppressDeviceMarkers = false;
  failApply = false;
  rejectLogin = false;
  // Production behavior: the tenants form does NOT render 16-hex path hashes.
  hidePathsOnTenantsPage = false;

  applies = 0;
  sequence: string[] = [];
  puts: Array<{ cls: string; fields: Fields }> = [];
  csvImports: string[] = [];

  trunks: Array<{ id: string; name: string }> = [];
  routes: Array<{ id: string; name: string }> = [];
  selections: Array<{ id: string; name: string }> = [];
  tenants: Array<{ path: string; slug: string; description: string }> = [];
  extensions: Array<{ id: string; ext: string; name: string; devices: Array<Record<string, string>> }> = [];
  inboundRoutes: Array<Fields> = [];

  private nextId = 100;

  private json(obj: unknown, setCookie?: string[]) {
    return {
      status: 200,
      headers: {
        get: (k: string) => (k.toLowerCase() === "set-cookie" ? (setCookie || []).join(", ") || null : null),
        getSetCookie: () => setCookie || [],
      },
      text: async () => JSON.stringify(obj),
    } as unknown as Response;
  }

  private csrfHtml(extra = ""): string {
    return `<div><input value="${CSRF}" name="csfr_token">${extra}</div>`;
  }

  private optionsFor(list: Array<{ id: string; name: string }>): string {
    return list.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
  }

  private extensionEditHtml(ext: { id: string; ext: string; name: string; devices: Array<Record<string, string>> }): string {
    const markers = this.suppressDeviceMarkers
      ? ""
      : ext.devices.map((d) => `<span>${esc(d.user || "")} ${esc(d.number || "")}</span>`).join("");
    return this.csrfHtml(
      `<input name="extension" value="${ext.ext}">` +
        `<input name="ext_name" value="${esc(ext.name)}">` +
        `<input name="call_waiting" type="checkbox" checked value="yes">` +
        `<input name="secret_ignore" type="checkbox" value="yes">` +
        `<select name="profile_id"><option value="1" selected>Default PJSIP Profile</option><option value="12">Default WebRTC Profile</option></select>` +
        `<select name="dynamic_queues[]" multiple><option value="q1" selected>Q1</option></select>` +
        markers,
    );
  }

  async handle(_url: string, opts: RequestInit): Promise<Response> {
    const body: any = opts?.body;

    // login GET (primes cookie)
    if (!body) return this.json({ ok: true }, ["sid=fake-sid; Path=/", "vpbx_tenant=main0000000000ff; Path=/"]);

    // multipart CSV import
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const cls = String(body.get("class") || "");
      if (cls === "menu4") {
        const csv = await (body.get("csv") as Blob).text();
        this.csvImports.push(csv);
        this.sequence.push("csv-import");
        if (this.failCsvImport) {
          return this.json({ state: "success", notification: { type: "error", text: "1 row(s) had errors" } });
        }
        const lines = csv.trim().split("\n");
        const header = lines[0].split(",");
        for (const line of lines.slice(1)) {
          const cells = line.split(",");
          const row: Record<string, string> = {};
          header.forEach((h, i) => (row[h] = cells[i] ?? ""));
          this.extensions.push({ id: String(this.nextId++), ext: row.extension, name: row.ext_name, devices: [{ user: row.device_user }] });
        }
        return this.json({ state: "success", notification: { type: "info", text: "Import completed successfully" } });
      }
      return this.json({ state: "success" });
    }

    const f: Fields = [...(body as URLSearchParams).entries()];
    const cls = get(f, "class") || "";
    const method = get(f, "method") || "";
    const mode = get(f, "mode") || "";

    // login POST
    if (get(f, "loginForm") === "1") {
      if (this.rejectLogin) return this.json({ notification: { type: "error", title: "Login", text: "bad credentials" } });
      return this.json({ ok: true }, ["sid=fake-sid; Path=/", "vpbx_tenant=main0000000000ff; Path=/"]);
    }

    // Apply Changes
    if (get(f, "call") === "generateConfigurations") {
      this.sequence.push("apply");
      this.applies++;
      if (this.failApply) return this.json({ state: "error" });
      return this.json({ state: "success" });
    }

    // rendered forms (CSRF + option lists + edit forms). Selects are NAMED and
    // forms carry the same company-named decoy lists as the real panel — the
    // 2026-07-26 live incident was an unscoped scan matching the trunk (in
    // shared_trunks) when looking for the route selection.
    if (method === "getContent") {
      if (cls === "trunk_group" && mode === "add") {
        return this.json({
          html: this.csrfHtml(
            `<select name="trklist[]" multiple>${this.omitTrunkOption ? "" : this.optionsFor(this.trunks)}</select>` +
              `<select name="mod_dest"><option value="1">Extensions</option></select>`,
          ),
        });
      }
      if (cls === "ars" && mode === "add") {
        return this.json({
          html: this.csrfHtml(
            `<select name="members[{{row-count-placeholder}}][outbound_route_id]">${this.optionsFor(this.routes)}</select>` +
              `<select name="members[0][outbound_route_id]">${this.optionsFor(this.routes)}</select>` +
              `<select name="members[0][time_group_id]"><option value="">All time</option></select>`,
          ),
        });
      }
      if (cls === "tenants" && mode === "add") {
        // Same layout as production: outbound_profiles (route selections),
        // then trunk/route lists that ALSO contain the company name.
        return this.json({
          html: this.csrfHtml(
            `<select name="outbound_profiles[]" multiple>${this.optionsFor(this.selections)}</select>` +
              `<select name="shared_trunks[]" multiple>${this.optionsFor(this.trunks)}</select>` +
              `<select name="allowed_tenant_trunks[]" multiple>${this.optionsFor(this.trunks)}</select>` +
              `<select name="allowed_outbound_routes[]" multiple>${this.optionsFor(this.routes)}</select>`,
          ),
        });
      }
      if (cls === "tenants" && mode === "read") {
        const opts2 = this.tenants
          .map((t) => `<option value="${this.hidePathsOnTenantsPage ? t.slug : t.path}">${esc(t.slug)}</option>`)
          .join("");
        return this.json({ html: this.csrfHtml(opts2) });
      }
      if (cls === "extensions" && mode === "edit") {
        const ext = this.extensions.find((e) => e.id === get(f, "data"));
        if (!ext) return this.json({ html: this.csrfHtml() });
        return this.json({ html: this.extensionEditHtml(ext) });
      }
      if (cls === "inbound_route" && mode === "read") {
        const rows = this.inboundRoutes.map((r) => `<td>${esc(get(r, "did") || "")}</td>`).join("");
        return this.json({ html: this.csrfHtml(rows) });
      }
      return this.json({ html: this.csrfHtml() });
    }

    // destination options (extension lookup for inbound routes) — production
    // shape verified live: html is empty, extensions come as an options ARRAY.
    if (cls === "inbound_route" && method === "getDestinationChildOptions") {
      return this.json({
        state: "success",
        html: "",
        action: "dependentCombo",
        options: [
          { content: "Select Destination", value: "" },
          ...this.extensions.map((e) => ({ content: `${e.ext} - ${e.name}`, value: Number(e.id) })),
        ],
        child: "inbound_route-destination",
        parent: "inbound_route-mod_dest",
      });
    }

    // module writes
    if (method === "put") {
      this.puts.push({ cls, fields: f });
      if (cls === "trunks" && mode === "add") {
        this.sequence.push("put:trunks");
        if (this.failTrunkWithDialog) {
          return this.json({ state: "success", action: "dialog", html: "<ul><li>The trunk name already exists</li></ul>" });
        }
        this.trunks.push({ id: String(this.nextId++), name: get(f, "description") || "" });
        return this.json({ state: "success" });
      }
      if (cls === "trunk_group" && mode === "add") {
        this.sequence.push("put:trunk_group");
        this.routes.push({ id: String(this.nextId++), name: get(f, "description") || "" });
        return this.json({ state: "success" });
      }
      if (cls === "ars" && mode === "add") {
        this.sequence.push("put:ars");
        this.selections.push({ id: String(this.nextId++), name: get(f, "description") || "" });
        return this.json({ state: "success" });
      }
      if (cls === "tenants" && mode === "add") {
        this.sequence.push("put:tenants");
        const n = this.tenants.length;
        this.tenants.push({
          path: `a1b2c3d4e5f6071${n.toString(16)}`,
          slug: get(f, "name") || "",
          description: get(f, "description") || "",
        });
        return this.json({ state: "success" });
      }
      if (cls === "extensions" && mode === "edit") {
        this.sequence.push("put:device");
        const ext = this.extensions.find((e) => e.ext === get(f, "extension"));
        if (ext) {
          ext.devices.push({
            user: get(f, "user") || "",
            technology: get(f, "technology") || "",
            number: get(f, "number") || "",
            ring_device: get(f, "ring_device") || "",
            profile_id: get(f, "profile_id") || "",
            vitxi_client: get(f, "vitxi_client") || "",
            dtmfmode: get(f, "dtmfmode") || "",
          });
        }
        return this.json({ state: "success" });
      }
      if (cls === "inbound_route" && mode === "add") {
        this.sequence.push("put:inbound_route");
        this.inboundRoutes.push(f);
        return this.json({ state: "success" });
      }
      return this.json({ state: "success" });
    }

    return this.json({ state: "success" });
  }
}

function install(fake: FakePanel): void {
  (globalThis as any).fetch = (url: string, opts: RequestInit) => fake.handle(url, opts);
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

const ACCOUNT = { id: "robot", user: "robot@x.com", pass: "pw" };
const MAIN = "main0000000000ff";

function job(overrides: Partial<PbxBuildJob> = {}): PbxBuildJob {
  return {
    company: "Bobs Plumbing",
    did: "8455577726",
    voipms: { user: "344022_BobsPlumbing1", pass: "secretpw9a", server: "newyork1.voip.ms" },
    people: [
      { name: "John Doe", ext: "101", email: "john@x.com", vmPassword: "4321" },
      { name: "Jane Roe", ext: "102", email: "jane@x.com", cellMode: "also", cellNumber: "5622096644" },
      { name: "Cell Only", ext: "103", cellMode: "only", cellNumber: "9145550000" },
    ],
    ...overrides,
  };
}

async function run(fake: FakePanel, j: PbxBuildJob = job()) {
  install(fake);
  const s = await new PanelSession("https://panel.example", ACCOUNT).login();
  return buildPbxTenant(s, MAIN, j);
}

// ── Happy path: exact recorded contract ──────────────────────────────────────

test("full build: step order, Apply after every step, all objects verified", async () => {
  const fake = new FakePanel();
  const result = await run(fake);

  // Order: trunk→apply, route→apply, ars→apply, tenant→apply,
  // then per person csv-import + devices + apply, finally inbound→apply.
  assert.deepEqual(fake.sequence.slice(0, 8), [
    "put:trunks", "apply", "put:trunk_group", "apply", "put:ars", "apply", "put:tenants", "apply",
  ]);
  assert.equal(fake.sequence.filter((s) => s === "csv-import").length, 3);
  assert.equal(fake.sequence[fake.sequence.length - 2], "put:inbound_route");
  assert.equal(fake.sequence[fake.sequence.length - 1], "apply");
  // 4 infra applies + 3 per-person applies + 1 inbound apply
  assert.equal(fake.applies, 8);

  assert.equal(result.company, "Bobs Plumbing");
  assert.equal(result.slug, "bobs_plumbing");
  assert.ok(/^[a-f0-9]{16}$/.test(result.tenantPath));
  assert.ok(result.firstExtId);
});

test("trunk carries the VoIP.ms subaccount credentials and recorded codec order", async () => {
  const fake = new FakePanel();
  await run(fake);
  const trunk = fake.puts.find((p) => p.cls === "trunks")!;
  assert.equal(get(trunk.fields, "description"), "Bobs Plumbing");
  assert.equal(get(trunk.fields, "outgoing[username]"), "344022_BobsPlumbing1");
  assert.equal(get(trunk.fields, "outgoing[remotesecret]"), "secretpw9a");
  assert.equal(get(trunk.fields, "outgoing[host]"), "newyork1.voip.ms");
  assert.equal(get(trunk.fields, "outgoing[fromdomain]"), "newyork1.voip.ms");
  assert.equal(get(trunk.fields, "outgoing[client_uri]"), "sip:344022_BobsPlumbing1@newyork1.voip.ms");
  assert.deepEqual(getAll(trunk.fields, "codecs[]"), ["ulaw", "alaw", "g726", "g729"]);
  assert.equal(get(trunk.fields, "technology"), "pjsip");
});

test("outbound route: 5 recorded dial patterns, 845 prepend on 7-digit, DID as CID", async () => {
  const fake = new FakePanel();
  await run(fake);
  const route = fake.puts.find((p) => p.cls === "trunk_group")!;
  assert.equal(get(route.fields, "cid_number"), "8455577726");
  assert.equal(get(route.fields, "cid_name"), "Bobs Plumbing");
  assert.equal(get(route.fields, "trkpattern[0][prepend]"), "845");
  assert.equal(get(route.fields, "trkpattern[0][pattern]"), "nxxxxxx");
  assert.equal(get(route.fields, "trkpattern[1][pattern]"), "nxxnxxxxxx");
  assert.equal(get(route.fields, "trkpattern[2][pattern]"), "1nxxnxxxxxx");
  assert.equal(get(route.fields, "trkpattern[3][pattern]"), "+1nxxnxxxxxx");
  assert.equal(get(route.fields, "trkpattern[4][pattern]"), "011.");
  // routed through the trunk created one step earlier
  assert.equal(get(route.fields, "trklist[]"), fake.trunks[0].id);
});

test("tenant form: slug name, company description, DID inside the tenant, ARS profile", async () => {
  const fake = new FakePanel();
  await run(fake);
  const tenant = fake.puts.find((p) => p.cls === "tenants")!;
  assert.equal(get(tenant.fields, "name"), "bobs_plumbing");
  assert.equal(get(tenant.fields, "description"), "Bobs Plumbing");
  assert.equal(get(tenant.fields, "inbound_numbers[0][did]"), "8455577726");
  assert.equal(get(tenant.fields, "outbound_profiles[]"), fake.selections[0].id);
  assert.equal(get(tenant.fields, "send_welcome_email"), "1");
});

test("CSV import: recording + voicemail on, vm password, email; straight-to-cell desk device doesn't ring", async () => {
  const fake = new FakePanel();
  await run(fake);
  assert.equal(fake.csvImports.length, 3);

  const header = fake.csvImports[0].split("\n")[0].split(",");
  const rowFor = (csv: string) => {
    const cells = csv.split("\n")[1].split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  };

  const john = rowFor(fake.csvImports[0]);
  assert.equal(john.mode, "add");
  assert.equal(john.extension, "101");
  assert.equal(john.ext_name, "John Doe");
  assert.equal(john.technology, "pjsip");
  assert.equal(john.profile_name, "Default PJSIP Profile");
  assert.equal(john.vm_enabled, "yes");
  assert.equal(john.vm_password, "4321");
  assert.equal(john.outgoing_rec, "yes");
  assert.equal(john.incoming_rec, "yes");
  assert.equal(john.email, "john@x.com");
  assert.equal(john.ring_device, ""); // default (rings)

  const cellOnly = rowFor(fake.csvImports[2]);
  assert.equal(cellOnly.extension, "103");
  assert.equal(cellOnly.ring_device, "no"); // straight-to-cell: desk exists, doesn't ring
});

test("devices: WebRTC always; cell device only when a cell number is set; ring modes correct", async () => {
  const fake = new FakePanel();
  await run(fake);

  const ext101 = fake.extensions.find((e) => e.ext === "101")!;
  const ext102 = fake.extensions.find((e) => e.ext === "102")!;
  const ext103 = fake.extensions.find((e) => e.ext === "103")!;

  // 101: import device + WebRTC only (no cell)
  assert.deepEqual(ext101.devices.map((d) => d.user), ["101", "101_1"]);
  const w101 = ext101.devices[1];
  assert.equal(w101.technology, "pjsip");
  assert.equal(w101.profile_id, "12"); // matched the "Default WebRTC Profile" option
  assert.equal(w101.vitxi_client, "1");
  assert.equal(w101.ring_device, "yes");

  // 102 "also": WebRTC rings + cell device rings
  assert.deepEqual(ext102.devices.map((d) => d.user), ["102", "102_1", "102_2"]);
  assert.equal(ext102.devices[1].ring_device, "yes");
  const cell102 = ext102.devices[2];
  assert.equal(cell102.technology, "virtual");
  assert.equal(cell102.number, "5622096644");
  assert.equal(cell102.ring_device, "yes");
  assert.equal(cell102.dtmfmode, "rfc2833");

  // 103 "only": WebRTC created but silent, cell rings
  assert.equal(ext103.devices[1].ring_device, "no");
  assert.equal(ext103.devices[2].ring_device, "yes");
  assert.equal(ext103.devices[2].number, "9145550000");
});

test("inbound route points the DID at the FIRST extension", async () => {
  const fake = new FakePanel();
  const result = await run(fake);
  assert.equal(fake.inboundRoutes.length, 1);
  const ir = fake.inboundRoutes[0];
  assert.equal(get(ir, "did"), "8455577726");
  assert.equal(get(ir, "description"), "Main");
  assert.equal(get(ir, "destination"), result.firstExtId);
  const ext101 = fake.extensions.find((e) => e.ext === "101")!;
  assert.equal(result.firstExtId, ext101.id);
});

test("company names with & and ' survive HTML entity escaping in panel option lists", async () => {
  const fake = new FakePanel();
  const result = await run(fake, job({ company: "J&J's Plumbing" }));
  assert.equal(result.slug, "j_j_s_plumbing");
  assert.equal(fake.trunks[0].name, "J&J's Plumbing");
  assert.ok(result.tenantPath);
});

// ── Failure injection: the panel's lying "success" responses ─────────────────

test("hidden error dialog inside a 'success' response fails the build with the real error", async () => {
  const fake = new FakePanel();
  fake.failTrunkWithDialog = true;
  await assert.rejects(run(fake), /trunk.*already exists/i);
  assert.equal(fake.applies, 0); // nothing applied after a failed save
});

test("created trunk missing from the outbound-route options fails verification", async () => {
  const fake = new FakePanel();
  fake.omitTrunkOption = true;
  await assert.rejects(run(fake), /not found in outbound-route form/i);
});

test("CSV import rejection surfaces the importer's message", async () => {
  const fake = new FakePanel();
  fake.failCsvImport = true;
  await assert.rejects(run(fake), /ext 101.*errors|import failed/i);
});

test("device that never shows up on the extension after save fails verification", async () => {
  const fake = new FakePanel();
  fake.suppressDeviceMarkers = true;
  await assert.rejects(run(fake), /device not found on extension 101/i);
});

test("Apply Changes failure aborts immediately", async () => {
  const fake = new FakePanel();
  fake.failApply = true;
  await assert.rejects(run(fake), /Apply Changes failed/i);
});

test("login rejection throws with the panel's error", async () => {
  const fake = new FakePanel();
  fake.rejectLogin = true;
  install(fake);
  await assert.rejects(new PanelSession("https://panel.example", ACCOUNT).login(), /login rejected.*bad credentials/i);
});

test("job validation: missing DID / people / credentials are rejected before any panel write", async () => {
  const fake = new FakePanel();
  await assert.rejects(run(fake, job({ did: "" })), /job needs company, did, voipms/);
  await assert.rejects(run(fake, job({ people: [] })), /at least one person/);
  await assert.rejects(
    run(fake, job({ voipms: { user: "", pass: "x", server: "y" } })),
    /job needs company, did, voipms/,
  );
  assert.equal(fake.puts.length, 0);
});

// ── Resume / idempotency: a retried or interrupted build never duplicates ────

test("re-running the exact same build reuses every existing object — zero duplicates", async () => {
  const fake = new FakePanel();
  const first = await run(fake);
  const putsAfterFirst = fake.puts.length;
  const importsAfterFirst = fake.csvImports.length;

  const second = await run(fake); // e.g. orchestrator retry after a crash

  assert.equal(fake.puts.length, putsAfterFirst, "second run must not write anything");
  assert.equal(fake.csvImports.length, importsAfterFirst, "second run must not re-import CSVs");
  assert.equal(fake.trunks.length, 1);
  assert.equal(fake.routes.length, 1);
  assert.equal(fake.selections.length, 1);
  assert.equal(fake.tenants.length, 1);
  assert.equal(fake.inboundRoutes.length, 1);
  assert.equal(fake.extensions.length, 3);
  for (const e of fake.extensions) {
    const users = e.devices.map((d) => d.user);
    assert.equal(new Set(users).size, users.length, `ext ${e.ext} grew duplicate devices`);
  }
  assert.equal(second.tenantPath, first.tenantPath);
  assert.equal(second.trunkId, first.trunkId);
  assert.equal(second.firstExtId, first.firstExtId);
});

test("resume after a mid-build crash finishes only the missing pieces", async () => {
  const fake = new FakePanel();
  // First attempt dies right after the tenant step: simulate by failing the
  // CSV importer, then clear the flag and retry the whole build.
  fake.failCsvImport = true;
  await assert.rejects(run(fake), /errors|import failed/i);
  assert.equal(fake.tenants.length, 1); // infra exists, people don't

  fake.failCsvImport = false;
  const result = await run(fake);

  assert.equal(fake.trunks.length, 1, "trunk duplicated on resume");
  assert.equal(fake.routes.length, 1);
  assert.equal(fake.selections.length, 1);
  assert.equal(fake.tenants.length, 1, "tenant duplicated on resume");
  assert.equal(fake.extensions.length, 3); // finished on the retry
  assert.equal(fake.inboundRoutes.length, 1);
  assert.ok(result.tenantPath);
});

// ── Stress: volume ────────────────────────────────────────────────────────────

test("stress: 40-person tenant builds every extension and device", async () => {
  const fake = new FakePanel();
  const people = Array.from({ length: 40 }, (_, i) => ({
    name: `Person ${i + 1}`,
    ext: String(101 + i),
    email: `p${i + 1}@x.com`,
    ...(i % 3 === 0 ? { cellMode: "also" as const, cellNumber: `914555${String(1000 + i)}` } : {}),
  }));
  const result = await run(fake, job({ people }));
  assert.equal(fake.extensions.length, 40);
  for (const e of fake.extensions) {
    assert.ok(e.devices.some((d) => /_1$/.test(d.user || "")), `ext ${e.ext} missing WebRTC device`);
  }
  const withCell = fake.extensions.filter((e) => e.devices.some((d) => d.technology === "virtual"));
  assert.equal(withCell.length, people.filter((p: any) => p.cellNumber).length);
  assert.equal(result.firstExtId, fake.extensions[0].id);
});

test("REGRESSION: route selection is never confused with the same-named trunk (live 2026-07-26)", async () => {
  const fake = new FakePanel();
  // Resume scenario: the trunk (named exactly like the company) already
  // exists. The unscoped pre-check used to match it inside the tenant form's
  // shared_trunks list and skip creating the route selection entirely,
  // assigning the trunk's id as the tenant's outbound profile.
  fake.trunks.push({ id: "80", name: "Bobs Plumbing" });
  const result = await run(fake);
  assert.equal(result.trunkId, "80"); // trunk correctly reused
  assert.ok(fake.puts.some((p) => p.cls === "ars"), "route selection must actually be created");
  const tenant = fake.puts.find((p) => p.cls === "tenants")!;
  const profile = get(tenant.fields, "outbound_profiles[]");
  assert.equal(profile, result.arsId);
  assert.notEqual(profile, "80");
});

test("PRODUCTION contract: tenants page has no path hashes — the REST resolver supplies the path", async () => {
  // This is exactly what broke the first live run: the real panel's tenants
  // form renders numeric option ids, never 16-hex paths. The resolver (backed
  // by the read-only VitalPBX REST tenants list) must supply it.
  const fake = new FakePanel();
  fake.hidePathsOnTenantsPage = true;
  install(fake);
  const s = await new PanelSession("https://panel.example", ACCOUNT).login();
  const resolver = async (slug: string) => fake.tenants.find((t) => t.slug === slug)?.path || null;
  const result = await buildPbxTenant(s, MAIN, job(), () => {}, resolver);
  assert.match(result.tenantPath, /^[a-f0-9]{16}$/);
  assert.equal(result.tenantPath, fake.tenants[0].path);
  assert.equal(fake.inboundRoutes.length, 1); // build completed inside the tenant
});

test("no resolver + pathless tenants page fails with a clear error (after retries)", async () => {
  process.env.ONBOARDING_RETRY_BASE_MS = "5";
  try {
    const fake = new FakePanel();
    fake.hidePathsOnTenantsPage = true;
    await assert.rejects(run(fake), /path was not found/i);
  } finally {
    delete process.env.ONBOARDING_RETRY_BASE_MS;
  }
});

test("loadPanelConfig accepts the /etc/connect-robot credentials.env variable names", async () => {
  const { loadPanelConfig } = await import("./panelClient");
  const cfg = loadPanelConfig({
    CONNECT_BASE_URL: "https://m.connectcomunications.com/",
    CONNECT_ROBOT_USER: "lOOPCOMAGENT7548",
    CONNECT_ROBOT_PASS: "pw",
  } as any);
  assert.ok(cfg);
  assert.equal(cfg!.baseUrl, "https://m.connectcomunications.com");
  assert.equal(cfg!.accounts[0].user, "lOOPCOMAGENT7548");
  // ONBOARDING_* names still win when both are present
  const cfg2 = loadPanelConfig({
    ONBOARDING_PANEL_BASE_URL: "https://panel.example",
    CONNECT_BASE_URL: "https://other.example",
    ONBOARDING_ROBOT_USER: "a",
    ONBOARDING_ROBOT_PASS: "b",
  } as any);
  assert.equal(cfg2!.baseUrl, "https://panel.example");
});

test("slugify matches the robot's behavior", () => {
  assert.equal(slugify("j&j PLumbing"), "j_j_plumbing");
  assert.equal(slugify("  Acme  Corp  "), "acme_corp");
  assert.equal(slugify("A---B"), "a_b");
});
