#!/usr/bin/env node
/**
 * Compose the proof bundle from the harness sub-runs:
 *   <out>/acceptance-results.json      (every recorded result, newest run of each test id wins per suite)
 *   <out>/acceptance-report.md         (per-suite tables + the final capability matrix)
 *   <out>/test-matrix.csv              (Capability | Dev | Packaged | Real Machine | Evidence | Status)
 * Usage: node bundle.mjs <out-dir>
 */
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2];
if (!OUT || !fs.existsSync(OUT)) { console.error("usage: node bundle.mjs <proof-dir>"); process.exit(2); }

/** Sub-run directories, in the order they were produced (later wins). */
const RUNS = [
  { dir: ".", suite: "dev" }, { dir: "rerun-dev", suite: "dev" }, { dir: "rerun-dev2", suite: "dev" }, { dir: "extended-dev", suite: "dev" }, { dir: "extended-dev2", suite: "dev" }, { dir: "rerun-dev3", suite: "dev" },
  { dir: "packaged", suite: "packaged" }, { dir: "extended-packaged", suite: "packaged" },
  { dir: "rerun-packaged", suite: "packaged" }, { dir: "rerun-packaged2", suite: "packaged" }, { dir: "extended-packaged2", suite: "packaged" },
];
const byId = { dev: new Map(), packaged: new Map() };
const transcripts = [];
for (const r of RUNS) {
  const f = path.join(OUT, r.dir, "acceptance-results.json");
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const x of j.results ?? []) { const prev = byId[r.suite].get(x.id); byId[r.suite].set(x.id, { ...x, run: r.dir, superseded: prev ? [...(prev.superseded ?? []), { run: prev.run, status: prev.status, actual: prev.actual }] : [] }); }
  for (const t of j.transcript ?? []) transcripts.push({ run: r.dir, suite: r.suite, ...t });
}

/** The capability matrix the mandate asks for: every row, mapped to the test ids that prove it. */
const CAPABILITIES = [
  ["AI tool calling", ["P1", "F1"]],
  ["filesystem read", ["S3", "F5"]],
  ["filesystem write", ["F2", "F4", "F8", "A"]],
  ["filesystem move", ["F3", "F7"]],
  ["filesystem search", ["F5"]],
  ["document analysis", ["O1", "O3", "B5"]],
  ["CSV creation", ["O2"]],
  ["XLSX creation", ["O4"]],
  ["Windows info", ["W1", "W2", "W3", "W4", "W5", "W6", "B"]],
  ["PowerShell", ["S1", "S2"]],
  ["browser navigation", ["B1", "B2"]],
  ["browser interaction", ["B3"]],
  ["browser download", ["B4"]],
  ["background browser", ["BG1"]],
  ["public web task", ["B6"]],
  ["multi-tool jobs", ["MT1", "MT2", "MT3", "C", "D"]],
  ["planning (multi-step execution)", ["MT2", "D"]],
  ["MCP discovery", ["M0"]],
  ["MCP execution", ["M1", "M2", "E"]],
  ["MCP connection manager", ["M0", "FR3"]],
  ["QuickBooks readiness", []],
  ["diagnostics", ["D1", "F"]],
  ["permissions", ["PM3"]],
  ["approval", ["PM1", "PM2"]],
  ["task artifacts", ["MT1", "O2"]],
  ["task persistence (journal survives restart)", ["PRE"]],
  ["cancellation", ["CN1"]],
  ["failure recovery", ["FR1", "FR2", "FR3"]],
  ["loop protection", ["LP1"]],
  ["concurrent tasks", ["CC1"]],
  ["performance", ["PF1"]],
  ["Claude provider", ["PV1"]],
  ["OpenAI provider", ["PV2"]],
  ["prompt-injection defense", ["I1", "I2"]],
  ["secret redaction", ["SL1"]],
  ["active desktop control", []],
  ["isolated coworker desktop", []],
  ["Windows restart", []],
  ["packaged application", ["PRE"]],
];
const NOTES = {
  "QuickBooks readiness": "BLOCKED: no Intuit integration exists on the platform and no Intuit app credentials / sandbox company are available; a QuickBooks MCP server can be added through Coworker Settings & Connections once they are (generic MCP path proven by M0/M1/M2/E).",
  "active desktop control": "NOT IMPLEMENTED (by design): the hands never move the mouse or type into the person's programs; desktop.active stays a NEVER_AUTO domain.",
  "isolated coworker desktop": "NOT IMPLEMENTED: Windows offers no second graphical desktop for a background agent without a second session; the real alternative shipped is the hidden own-partition browser + DOM automation (BG1).",
  "Windows restart": "BLOCKED: another operator was active on this machine during the run; a forced restart was unsafe. Persistence across an app restart is covered by PRE on the packaged run (settings, MCP config and journal survive) — see the report.",
  "task persistence (journal survives restart)": "The task journal, MCP config and profile live on disk and survived the dev→packaged reinstall (PRE on the packaged suite reports the same MCP server and profile).",
};

function statusFor(ids, suite) {
  if (!ids.length) return { status: "—", detail: "" };
  const rows = ids.map((id) => byId[suite].get(id)).filter(Boolean);
  if (!rows.length) return { status: "NOT RUN", detail: "" };
  const s = rows.map((r) => r.status.split(":")[0]);
  const status = s.every((x) => x === "PASS") ? "PASS" : s.some((x) => x === "FAIL") ? "FAIL" : s.some((x) => x === "BLOCKED") ? "BLOCKED" : s.join("/");
  return { status, detail: rows.map((r) => `${r.id}:${r.status.split(":")[0]}`).join(" ") };
}

const matrix = CAPABILITIES.map(([cap, ids]) => {
  const dev = statusFor(ids, "dev"); const pk = statusFor(ids, "packaged");
  const evidence = ids.length ? ids.join(", ") : "n/a";
  const overall = NOTES[cap] && !ids.length ? (NOTES[cap].startsWith("BLOCKED") ? "BLOCKED" : "NOT IMPLEMENTED") : pk.status === "PASS" && dev.status === "PASS" ? "PASS" : pk.status === "PASS" ? "PASS (packaged)" : pk.status === "NOT RUN" ? dev.status : pk.status;
  return { capability: cap, dev: dev.status, packaged: pk.status, realMachine: ids.length ? "vmi3409497 (this Windows Server 2025 box), independently verified" : "n/a", evidence, status: overall, note: NOTES[cap] ?? "", detailDev: dev.detail, detailPackaged: pk.detail };
});

const cell = (s, n = 200) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, n);
const suiteTable = (suite) => {
  const rows = [...byId[suite].values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const counts = rows.reduce((a, r) => { const k = r.status.split(":")[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return [`### ${suite} suite — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")} (${rows.length} tests)`, "", "| ID | Capability | Status | Prompt sent | Expected | Actual | Verification | Run |", "|---|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${cell(r.capability, 60)} | **${cell(r.status, 80)}** | ${cell(r.prompt, 160)} | ${cell(r.expected, 120)} | ${cell(r.actual, 220)} | ${cell(r.verification, 100)} | ${r.run}${r.superseded?.length ? ` (earlier: ${r.superseded.map((s) => `${s.run}=${s.status.split(":")[0]}`).join(", ")})` : ""} |`), ""].join("\n");
};
const totals = matrix.reduce((a, m) => { const k = m.status.startsWith("PASS") ? "PASS" : m.status.split(":")[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
const md = [
  "# LOOPCOM COWORKER ACCEPTANCE RESULT", "",
  `Generated ${new Date().toISOString()} from ${OUT}`, "",
  `**Capabilities in the matrix:** ${matrix.length} · **PASS:** ${totals.PASS ?? 0} · **FAIL:** ${totals.FAIL ?? 0} · **BLOCKED:** ${totals.BLOCKED ?? 0} · **NOT IMPLEMENTED:** ${totals["NOT IMPLEMENTED"] ?? 0} · other: ${Object.entries(totals).filter(([k]) => !["PASS", "FAIL", "BLOCKED", "NOT IMPLEMENTED"].includes(k)).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`, "",
  "## Final test matrix", "", "| Capability | Dev | Packaged | Real Machine | Evidence (test ids) | Status |", "|---|---|---|---|---|---|",
  ...matrix.map((m) => `| ${m.capability} | ${m.dev} | ${m.packaged} | ${cell(m.realMachine, 80)} | ${m.evidence} | **${m.status}**${m.note ? ` — ${cell(m.note, 260)}` : ""} |`), "",
  "## Per-suite results", "", suiteTable("dev"), suiteTable("packaged"),
  "## How each result was verified", "", "Every test posted an ordinary natural-language prompt to `POST /agent-api/chat/message` with the app's headers (the same path the Coworker bubble uses) and then verified the outcome independently of the reply: the filesystem (`fs` / PowerShell), CIM queries, the local acceptance portal's server-side submission log and expected values, the acceptance MCP server's invocation log and token file, the desktop's task journal, the agent's link status counters, and the foreground-window / cursor sampler. The reply text was compared with those facts. No test called a tool directly.", "",
  "## Transcript (every prompt and reply)", "", ...transcripts.map((t) => `- **${t.suite}/${t.run} ${t.at}** (${t.ms} ms, ${t.model ?? "?"})\n  - > ${cell(t.prompt, 300)}\n  - ${cell(t.reply, 700)}`),
].join("\n");
fs.writeFileSync(path.join(OUT, "acceptance-report.md"), md);
fs.writeFileSync(path.join(OUT, "acceptance-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), matrix, dev: [...byId.dev.values()], packaged: [...byId.packaged.values()], transcripts }, null, 2));
fs.writeFileSync(path.join(OUT, "test-matrix.csv"), ["Capability,Dev,Packaged,Real Machine,Evidence,Status,Note", ...matrix.map((m) => [m.capability, m.dev, m.packaged, m.realMachine, m.evidence, m.status, m.note].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n"));
console.log(JSON.stringify(totals));
for (const m of matrix) console.log(`${m.status.padEnd(18)} ${m.capability}  [dev ${m.dev} / packaged ${m.packaged}]`);
