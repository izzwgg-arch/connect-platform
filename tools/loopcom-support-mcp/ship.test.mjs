/**
 * Phase 3: the support agent's code change is shipped only by ship.mjs, only
 * after the tests pass and the owner replies GO, and it is rolled back when the
 * deploy cannot be verified.
 *
 * ⛔ What these defend: an edit reaching a forbidden file; a change shipped that
 * is not the commit the owner approved; a force push; a pinned commit that rolls
 * production back; a failed deploy left in place; a crash resuming half a ship.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkShipPath,
  servicesFor,
  packagesFor,
  hasStrayControlBytes,
  stageEdit,
  stageNewFile,
  requestShip,
  decideShip,
  noticeSummary,
  parseShipResult,
  shipVerdict,
  shipEntry,
  processShips,
  remoteDeployScript,
  SHIPS_PER_DAY,
  FORBIDDEN_FILES,
} from "./ship.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-15T15:00:00Z");
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-test-"));
  const stateFile = path.join(dir, "state.json");
  const wt = path.join(dir, "wt");
  fs.mkdirSync(path.join(wt, "apps/api/src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "apps/api/src/greeting.ts"), ["export const a = 1;", "export const b = 2;", ""].join(NL));
  let ships = {};
  const deps = {
    now: () => NOW,
    load: () => JSON.parse(JSON.stringify(ships)),
    save: (s) => { ships = JSON.parse(JSON.stringify(s)); },
    ensureWorktree: () => ({ wt, base: "base000" }),
    get ships() { return ships; },
    set ships(v) { ships = v; },
  };
  return { dir, wt, stateFile, deps };
}

/** A fake command runner that records every call and answers from a script. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const key = [cmd, ...args].join(" ");
    for (const [pattern, fn] of Object.entries(answers)) {
      if (key.includes(pattern)) return typeof fn === "function" ? fn(key, calls) : fn;
    }
    return { code: 0, out: "", err: "" };
  };
  return { exec, calls };
}

describe("what the agent may touch", () => {
  test("allowlisted source paths pass, with Windows separators normalised", () => {
    assert.equal(checkShipPath("apps/api/src/support/x.ts").ok, true);
    assert.equal(checkShipPath("apps/portal/components/Foo.tsx").ok, true);
    assert.equal(checkShipPath("packages/shared/src/a.ts").ok, true);
    assert.equal(checkShipPath(["apps", "api", "src", "b.ts"].join(String.fromCharCode(92))).ok, true);
  });

  test("⛔ the agent's own gates are never shippable", () => {
    for (const f of FORBIDDEN_FILES) assert.equal(checkShipPath(f).ok, false, f);
  });

  test("⛔ secrets, schema, dependencies, config and anything outside the allowlist are refused", () => {
    for (const bad of [
      ".env", "apps/api/.env.platform", ".connect-ssh/connect2_ed25519", "packages/db/prisma/schema.prisma",
      "apps/api/src/migrations/x.ts", "apps/api/package.json", "pnpm-lock.yaml", "apps/api/tsconfig.json",
      "apps/api/Dockerfile", "docker-compose.app.yml", "scripts/deploy-api.sh", "tools/loopcom-support-mcp/watch.mjs",
      "apps/mobile/src/App.tsx", "/etc/passwd", "C:/x.ts", "apps/api/src/../../.env", "", "apps/api//src/x.ts",
    ]) {
      assert.equal(checkShipPath(bad).ok, false, bad);
    }
  });

  test("services and packages follow the files; a shared change is checked and shipped everywhere it is used", () => {
    assert.deepEqual(servicesFor(["apps/api/src/a.ts"]), ["api"]);
    assert.deepEqual(servicesFor(["apps/portal/lib/a.ts"]), ["portal"]);
    assert.deepEqual(servicesFor(["packages/shared/src/a.ts"]), ["api", "portal"]);
    assert.deepEqual(packagesFor(["packages/shared/src/a.ts"]), ["packages/shared", "apps/api", "apps/portal"]);
  });

  test("⛔ control bytes are caught; CRLF, LF and tab are fine", () => {
    assert.equal(hasStrayControlBytes(Buffer.from([97, 13, 10, 98, 10, 9, 99])), false);
    assert.equal(hasStrayControlBytes(Buffer.from([97, 0, 98])), true);
    assert.equal(hasStrayControlBytes(Buffer.from([97, 13, 98])), true);
    assert.equal(hasStrayControlBytes("x" + String.fromCharCode(27)), true);
  });
});

describe("staging an edit", () => {
  test("an exact single match is replaced and recorded", () => {
    const s = sandbox();
    const r = stageEdit({ ref: "3gth9m", path: "apps/api/src/greeting.ts", oldString: "export const b = 2;", newString: "export const b = 3;" }, s.deps);
    assert.deepEqual(r.files, ["apps/api/src/greeting.ts"]);
    assert.match(fs.readFileSync(path.join(s.wt, "apps/api/src/greeting.ts"), "utf8"), /b = 3/);
    assert.equal(s.deps.ships["3GTH9M"].status, "staged");
  });

  test("⛔ zero or several matches, a forbidden path, or control characters change nothing", () => {
    const s = sandbox();
    const file = path.join(s.wt, "apps/api/src/greeting.ts");
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "nope", newString: "x" }, s.deps), /not found/);
    assert.throws(() => stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "export const", newString: "x" }, s.deps), /matches 2 places/);
    assert.throws(() => stageEdit({ ref: "3GTH9M", path: "apps/api/package.json", oldString: "a", newString: "b" }, s.deps), /not something the agent may ship/);
    assert.throws(() => stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "a = 1", newString: "a = " + String.fromCharCode(0) }, s.deps), /control characters/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  test("a CRLF file matches text written with plain line breaks", () => {
    const s = sandbox();
    const file = path.join(s.wt, "apps/api/src/greeting.ts");
    fs.writeFileSync(file, ["line one", "line two", ""].join(CR + NL));
    stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: ["line one", "line two"].join(NL), newString: ["line one", "line 2"].join(NL) }, s.deps);
    assert.equal(fs.readFileSync(file, "utf8"), ["line one", "line 2", ""].join(CR + NL));
  });

  test("a new file never overwrites, and nothing can be staged once submitted", () => {
    const s = sandbox();
    assert.throws(() => stageNewFile({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", content: "x" }, s.deps), /already exists/);
    stageNewFile({ ref: "3GTH9M", path: "apps/api/src/new/thing.test.ts", content: "export {};" }, s.deps);
    assert.ok(fs.existsSync(path.join(s.wt, "apps/api/src/new/thing.test.ts")));
    s.deps.ships = { "3GTH9M": { ...s.deps.ships["3GTH9M"], status: "awaiting_go" } };
    assert.throws(() => stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "a = 1", newString: "a = 9" }, s.deps), /already has a change/);
  });
});

describe("requesting a ship", () => {
  test("commits ONLY the staged files by pathspec, and ships nothing", () => {
    const s = sandbox();
    stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "b = 2", newString: "b = 3" }, s.deps);
    const { exec, calls } = fakeExec({ "rev-parse HEAD": { code: 0, out: "abc123def456" + NL, err: "" } });
    const r = requestShip({ ref: "3GTH9M", summary: "Save the busy greeting alongside the unavailable one." }, { ...s.deps, exec });
    assert.equal(r.sha, "abc123def456");
    assert.deepEqual(r.services, ["api"]);
    const add = calls.find((c) => c.args.includes("add"));
    assert.deepEqual(add.args.slice(-2), ["--", "apps/api/src/greeting.ts"]);
    const commit = calls.find((c) => c.args.includes("commit"));
    assert.ok(commit.args.includes("--") && commit.args.at(-1) === "apps/api/src/greeting.ts");
    assert.ok(!calls.some((c) => c.args.includes("push")), "request_ship must never push");
    assert.equal(s.deps.ships["3GTH9M"].status, "submitted");
  });

  test(`⛔ at most ${SHIPS_PER_DAY} submissions per day`, () => {
    const s = sandbox();
    const today = new Date(NOW).toISOString();
    s.deps.ships = Object.fromEntries(Array.from({ length: SHIPS_PER_DAY }, (_, i) => [`AAAA${i}`, { status: "shipped", submittedAt: today }]));
    stageEdit({ ref: "3GTH9M", path: "apps/api/src/greeting.ts", oldString: "b = 2", newString: "b = 3" }, s.deps);
    assert.throws(() => requestShip({ ref: "3GTH9M", summary: "A perfectly reasonable summary." }, { ...s.deps, exec: fakeExec().exec }), /already submitted today/);
  });
});

describe("the owner's GO", () => {
  const entry = { ref: "3GTH9M", status: "awaiting_go", noticeId: "n1", sha: "abc12345ff", services: ["api"], files: ["apps/api/src/a.ts"], summary: "Fix the greeting." };

  test("approved ships, STOP discards, expiry discards, otherwise wait", () => {
    assert.equal(decideShip(entry, [{ id: "n1", status: "approved", expiresAt: "2026-09-16T00:00:00Z" }], NOW).action, "ship");
    assert.equal(decideShip(entry, [{ id: "n1", status: "stopped", expiresAt: "2026-09-16T00:00:00Z" }], NOW).action, "discard");
    assert.equal(decideShip(entry, [{ id: "n1", status: "awaiting_go", expiresAt: "2026-09-15T14:00:00Z" }], NOW).action, "discard");
    assert.equal(decideShip(entry, [{ id: "n1", status: "awaiting_go", expiresAt: "2026-09-16T00:00:00Z" }], NOW).action, "wait");
    assert.equal(decideShip(entry, [{ id: "other", status: "approved", expiresAt: "2026-09-16T00:00:00Z" }], NOW).action, "wait");
  });

  test("the GO text names the commit, the services and the files, and fits a notice", () => {
    const s = noticeSummary({ ...entry, files: ["apps/api/src/a.ts", "apps/api/src/b.ts", "apps/api/src/c.ts", "apps/api/src/d.ts"] });
    assert.match(s, /abc12345/);
    assert.match(s, /api/);
    assert.match(s, /4 files/);
    assert.match(s, /[+]1 more/);
    assert.ok(s.length <= 400);
  });
});

describe("verification", () => {
  const good = "noise" + NL + "SHIP_RESULT status=success job=j1 heavy=0 build=abc ancestor=1 health_api=200 health_api2=200 health_portal=307";

  test("the result line is parsed and a full pass is verified", () => {
    const r = parseShipResult(good);
    assert.equal(r.job, "j1");
    assert.deepEqual(shipVerdict(r, "portal"), { ok: true });
  });

  test("⛔ a failed job, a container without the commit, or bad health is NOT verified", () => {
    const base = parseShipResult(good);
    assert.equal(shipVerdict({ ...base, status: "failed" }, "api").ok, false);
    assert.equal(shipVerdict({ ...base, ancestor: "0" }, "api").ok, false);
    assert.equal(shipVerdict({ ...base, health_api: "502" }, "api").ok, false);
    assert.equal(shipVerdict({ ...base, health_portal: "500" }, "portal").ok, false);
    assert.equal(shipVerdict(null, "api").ok, false);
  });

  test("⛔ SOURCE GUARD: the remote script deploys the branch tip, waits safely, probes locally", () => {
    const sh = remoteDeployScript();
    assert.doesNotMatch(sh, /commitHash/);
    assert.match(sh, /"branch":"%s"/);
    assert.match(sh, /\[d\]eploy-api[.]sh/);
    assert.match(sh, /--resolve app[.]loopcom[.]net:443:127[.]0[.]0[.]1/);
    assert.doesNotMatch(sh, /docker compose|git (reset|checkout|pull)/);
  });
});

function shipFlow(overrides = {}) {
  const log = [];
  const told = [];
  const deployments = [];
  const answers = {
    "rev-parse HEAD": { code: 0, out: "abc12345ff" + NL, err: "" },
    "status --porcelain": { code: 0, out: "", err: "" },
    ...overrides.git,
  };
  const { exec, calls } = fakeExec(answers);
  const entry = { ref: "3GTH9M", worktree: "/wt", status: "awaiting_go", sha: "abc12345ff", services: ["api"], files: ["apps/api/src/a.ts"], summary: "Fix it.", log };
  const deps = {
    exec,
    now: () => NOW,
    sleep: () => {},
    runChecks: () => ({ ok: true, results: [] }),
    tell: async (m) => told.push(m),
    sshRun: (script, args) => {
      deployments.push(args);
      return { code: 0, out: (overrides.results ?? []).shift?.() ?? "SHIP_RESULT status=success job=j1 heavy=0 build=abc12345ff ancestor=1 health_api=200 health_api2=200 health_portal=200", err: "" };
    },
  };
  return { entry, deps, calls, told, deployments };
}

describe("shipping after GO", () => {
  test("pushes the approved commit (never forced), deploys the branch and texts the owner", async () => {
    const f = shipFlow();
    const out = await shipEntry(f.entry, f.deps);
    assert.equal(out.status, "shipped");
    const push = f.calls.find((c) => c.args.includes("push"));
    assert.deepEqual(push.args.slice(-2), ["origin", "HEAD:refs/heads/feat/ivr-migration-takeover"]);
    assert.ok(!f.calls.some((c) => c.args.some((a) => /force/.test(a))));
    assert.deepEqual(f.deployments[0], ["api", "3GTH9M", "abc12345ff", "feat/ivr-migration-takeover"]);
    assert.match(f.told.at(-1), /Shipped code fix abc12345/);
  });

  test("⛔ a worktree that no longer holds the approved commit is refused before anything is pushed", async () => {
    const f = shipFlow({ git: { "rev-parse HEAD": { code: 0, out: "different0" + NL, err: "" } } });
    const out = await shipEntry(f.entry, f.deps);
    assert.equal(out.status, "failed");
    assert.ok(!f.calls.some((c) => c.args.includes("push")));
    assert.equal(f.deployments.length, 0);
  });

  test("⛔ uncommitted changes after approval are refused", async () => {
    const f = shipFlow({ git: { "status --porcelain": { code: 0, out: " M apps/api/src/a.ts", err: "" } } });
    assert.equal((await shipEntry(f.entry, f.deps)).status, "failed");
    assert.ok(!f.calls.some((c) => c.args.includes("push")));
  });

  test("⛔ a rebase conflict aborts, pushes nothing and tells the owner", async () => {
    const f = shipFlow({ git: { "rebase origin/": { code: 1, out: "", err: "CONFLICT" } } });
    const out = await shipEntry(f.entry, f.deps);
    assert.equal(out.status, "failed");
    assert.ok(f.calls.some((c) => c.args.includes("--abort")));
    assert.ok(!f.calls.some((c) => c.args.includes("push")));
    assert.match(f.told.at(-1), /NOT shipped/);
  });

  test("⛔ verification failure reverts, pushes the revert, redeploys and says ROLLED BACK", async () => {
    const f = shipFlow({
      results: [
        "SHIP_RESULT status=success job=j1 heavy=0 build=old ancestor=0 health_api=200 health_api2=200 health_portal=200",
        "SHIP_RESULT status=success job=j2 heavy=0 build=rev ancestor=1 health_api=200 health_api2=200 health_portal=200",
      ],
    });
    const out = await shipEntry(f.entry, f.deps);
    assert.equal(out.status, "rolled_back");
    assert.ok(f.calls.some((c) => c.args.includes("revert")));
    assert.equal(f.calls.filter((c) => c.args.includes("push")).length, 2);
    assert.equal(f.deployments.length, 2);
    assert.match(f.told.at(-1), /ROLLED BACK/);
  });

  test("a heavy job from another session is waited out and retried, not treated as a failure", async () => {
    const f = shipFlow({
      results: [
        "SHIP_RESULT status=failed job=j1 heavy=1 build=x ancestor=0 health_api=200 health_api2=200 health_portal=200",
        "SHIP_RESULT status=success job=j2 heavy=0 build=abc ancestor=1 health_api=200 health_api2=200 health_portal=200",
      ],
    });
    assert.equal((await shipEntry(f.entry, f.deps)).status, "shipped");
    assert.equal(f.deployments.length, 2);
  });
});

describe("the watcher's step", () => {
  function ctx(ships) {
    let state = JSON.parse(JSON.stringify(ships));
    const notices = [];
    const told = [];
    return {
      get state() { return state; },
      notices,
      told,
      deps: {
        now: () => NOW,
        load: () => JSON.parse(JSON.stringify(state)),
        save: (s) => { state = JSON.parse(JSON.stringify(s)); },
        exec: fakeExec().exec,
        api: {
          postOwnerNotice: async (_cfg, ref, body) => { notices.push({ ref, ...body }); return { noticeId: "n9" }; },
          getOwnerNotices: async () => ({ notices: [] }),
          postOwnerUpdate: async (_cfg, _ref, m) => { told.push(m); },
        },
      },
    };
  }

  test("checks pass → a system notice naming the commit is posted and the ship waits for GO", async () => {
    const c = ctx({ "3GTH9M": { ref: "3GTH9M", status: "submitted", sha: "abc12345ff", services: ["api"], files: ["apps/api/src/a.ts"], summary: "Fix it now.", log: [], createdAt: new Date(NOW).toISOString() } });
    const out = await processShips({}, { ...c.deps, runChecks: () => ({ ok: true, results: [] }) });
    assert.equal(out, "awaiting_go");
    assert.equal(c.notices[0].scope, "system");
    assert.match(c.notices[0].summary, /abc12345/);
    assert.equal(c.state["3GTH9M"].noticeId, "n9");
  });

  test("⛔ checks fail → the owner is NOT asked for GO, only told", async () => {
    const c = ctx({ "3GTH9M": { ref: "3GTH9M", status: "submitted", sha: "abc12345ff", services: ["api"], files: ["apps/api/src/a.ts"], summary: "Fix it now.", log: [], createdAt: new Date(NOW).toISOString() } });
    const out = await processShips({}, { ...c.deps, runChecks: () => ({ ok: false, results: [] }) });
    assert.equal(out, "checks_failed");
    assert.equal(c.notices.length, 0);
    assert.match(c.told[0], /FAILED its tests/);
  });

  test("⛔ a ship a crash interrupted is never resumed; the owner is told", async () => {
    const c = ctx({ "3GTH9M": { ref: "3GTH9M", status: "deploying", sha: "abc", services: ["api"], files: [], summary: "x", log: [], createdAt: new Date(NOW).toISOString() } });
    assert.equal(await processShips({}, c.deps), "interrupted");
    assert.equal(c.state["3GTH9M"].status, "interrupted");
    assert.match(c.told[0], /NOT resumed/);
  });
});

describe("source guards", () => {
  const ship = fs.readFileSync(path.join(HERE, "ship.mjs"), "utf8");
  const code = ship.split(NL).filter((l) => !/^[ ]*([*]|[/][/]|[/][*])/.test(l)).join(NL);

  test("⛔ no shell, no force, no add-all, no pinned commit", () => {
    assert.doesNotMatch(code, /shell:[ ]*true/);
    assert.doesNotMatch(code, /--force-with-lease|push[^)]*--force/);
    assert.doesNotMatch(code, /"add", "-A"|"add", "[.]"/);
    assert.doesNotMatch(code, /commitHash/);
  });

  test("⛔ the watcher runs ship steps and the agent may only stage and request", () => {
    const watch = fs.readFileSync(path.join(HERE, "watch.mjs"), "utf8");
    assert.match(watch, /processShips\(cfg,/);
    const server = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");
    for (const t of ["stage_edit", "stage_new_file", "request_ship", "get_ship_status"]) assert.ok(server.includes(`"${t}"`), t);
    assert.doesNotMatch(server, /shipEntry|processShips|deployService/);
  });
});
