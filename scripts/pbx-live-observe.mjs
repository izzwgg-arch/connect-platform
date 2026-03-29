#!/usr/bin/env node
/**
 * Read-only live PBX observer: one SSH session, remote loop @ 1 Hz.
 * Runs: core show channels concise, bridge show all — no config changes, no Asterisk restart.
 *
 * LIMITATIONS (read docs/pbx-audit):
 *   cursor-audit@209.145.60.79 uses a forced SSH command only — it CANNOT run this remote
 *   bash loop. Use a user with a normal shell who may run asterisk -rx (e.g. root@PBX with key).
 *
 * Usage:
 *   node scripts/pbx-live-observe.mjs --host 209.145.60.79 --user root --identity ~/.ssh/id_ed25519
 *
 * Env (optional):
 *   CONNECT_PBX_SSH_HOST, CONNECT_PBX_SSH_USER, CONNECT_PBX_SSH_IDENTITY_FILE
 *   CONNECT_PBX_ASTERISK_BIN=/usr/sbin/asterisk
 *   CONNECT_PBX_ASTERISK_PREFIX=     (e.g. "sudo " if remote user needs sudo; trailing space ok)
 *
 * Output: one JSON object per line (NDJSON) to stdout. Ctrl+C stops.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_HOST = process.env.CONNECT_PBX_SSH_HOST || "209.145.60.79";
const DEFAULT_USER = process.env.CONNECT_PBX_SSH_USER || "root";
const AST_BIN = (process.env.CONNECT_PBX_ASTERISK_BIN || "/usr/sbin/asterisk").trim();
const AST_PREFIX = process.env.CONNECT_PBX_ASTERISK_PREFIX || "";

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { host: DEFAULT_HOST, user: DEFAULT_USER, identity: process.env.CONNECT_PBX_SSH_IDENTITY_FILE || "", help: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "-h" || a[i] === "--help") out.help = true;
    else if (a[i] === "--host") out.host = a[++i];
    else if (a[i] === "--user") out.user = a[++i];
    else if (a[i] === "--identity" || a[i] === "-i") out.identity = a[++i];
  }
  return out;
}

function usage() {
  console.error(`
pbx-live-observe.mjs — read-only 1 Hz channel + bridge snapshots over SSH

Required: SSH access where a shell can run: ${AST_PREFIX}${AST_BIN} -rx "<cli>"

  node scripts/pbx-live-observe.mjs --host 209.145.60.79 --user root --identity %USERPROFILE%\\.ssh\\key

Not compatible with forced-command-only accounts (e.g. cursor-audit snapshot user).
`);
}

/** Split concise line: prefer ! (Asterisk 18+), else tab. */
function parseConciseLine(line) {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed || /^Channel\s*\(/i.test(trimmed) || trimmed === "(None)") return null;
  const parts = trimmed.includes("!") ? trimmed.split("!") : trimmed.split(/\t+/);
  if (parts.length < 6) {
    return {
      name: trimmed,
      state: "",
      callerNumber: "",
      connectedNumber: "",
      context: "",
      extension: "",
      linkedid: null,
      uniqueid: null,
      application: "",
      appData: "",
      accountCode: "",
      duration: "",
      bridgedTo: "",
      rawFields: parts,
    };
  }
  // Align with docs/pbx-audit/pbx_audit_cli.sh (0-based): channel, context, exten, priority, state, app, ...
  const channel = (parts[0] || "").trim();
  const context = (parts[1] || "").trim();
  const extension = (parts[2] || "").trim();
  const priority = (parts[3] || "").trim();
  const state = (parts[4] || "").trim();
  const application = (parts[5] || "").trim();
  const appData = (parts[6] || "").trim();
  const callerid = (parts[7] || "").trim();
  const accountCode = (parts[8] || "").trim();
  const peerAccount = (parts[9] || "").trim();
  const duration = (parts[10] || "").trim();
  const bridgedTo = (parts[11] || "").trim();
  let linkedid = null;
  let uniqueid = null;
  if (parts.length >= 14) {
    uniqueid = (parts[parts.length - 2] || "").trim() || null;
    linkedid = (parts[parts.length - 1] || "").trim() || null;
  } else if (parts.length >= 13) {
    uniqueid = (parts[parts.length - 1] || "").trim() || null;
  }
  const callerNumber = extractNumberFromCallerId(callerid);
  const connectedNumber = extractPeerHint(bridgedTo, appData, extension);

  return {
    name: channel,
    state,
    callerNumber,
    connectedNumber,
    context,
    extension,
    linkedid,
    uniqueid,
    application,
    appData,
    accountCode,
    duration,
    bridgedTo,
    rawFields: parts,
  };
}

function extractNumberFromCallerId(cid) {
  if (!cid) return "";
  const m = cid.match(/<([^>]+)>/);
  if (m) return m[1].replace(/\D/g, "").length >= 7 ? m[1].trim() : m[1].replace(/[^\d+]/g, "") || cid.trim();
  const digits = cid.replace(/[^\d+]/g, "");
  return digits.length >= 2 ? digits : cid.trim();
}

function extractPeerHint(bridgedTo, appData, exten) {
  if (bridgedTo && bridgedTo !== "(None)") {
    const m = bridgedTo.match(/\/([A-Za-z]?\d+[_-])?(\d{2,6})(?:-|;)/);
    if (m) return m[2];
    return bridgedTo.trim();
  }
  const d = (appData || "").replace(/\D/g, "");
  if (d.length >= 10) return appData.trim();
  return (exten || "").trim();
}

function isLikelyExtensionToken(s) {
  const t = String(s || "").replace(/\D/g, "");
  return t.length >= 2 && t.length <= 6;
}

function isLikelyExternal(s) {
  const t = String(s || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  return t.length >= 10;
}

function classifyBridge(bridge, channelByName) {
  const hints = [];
  const contexts = [];
  const names = bridge.channelNames || [];
  for (const cn of names) {
    const ch = channelByName.get(cn);
    if (!ch) continue;
    const ctx = (ch.context || "").toLowerCase();
    contexts.push(ch.context || "");
    if (ctx.includes("from-trunk") || ctx.includes("from-pstn") || ctx.includes("from-external")) {
      hints.push(`context_inbound_lean:${ch.context}`);
    }
    if (ctx.includes("from-internal") || ctx.includes("ext-local") || ctx.includes("outbound")) {
      hints.push(`context_internal_or_out_lean:${ch.context}`);
    }
  }

  let inferred = "unknown";
  const ctxJoined = contexts.join(" ").toLowerCase();
  const hasTrunkCtx =
    ctxJoined.includes("from-trunk") ||
    ctxJoined.includes("from-pstn") ||
    ctxJoined.includes("from-external");
  const hasInternalCtx =
    ctxJoined.includes("from-internal") ||
    ctxJoined.includes("ext-local") ||
    /^t\d+_cos-/i.test(ctxJoined);

  const nums = names
    .map((n) => {
      const ch = channelByName.get(n);
      return [ch?.callerNumber, ch?.connectedNumber, ch?.extension].filter(Boolean);
    })
    .flat();

  const anyExt = nums.some(isLikelyExtensionToken);
  const anyExt10 = nums.some(isLikelyExternal);

  if (hasTrunkCtx) {
    inferred = "inbound";
    hints.push("rule:trunk_context_present");
  } else if (hasInternalCtx && anyExt10 && anyExt) {
    inferred = "outbound";
    hints.push("rule:internal_context_and_mixed_ext_lengths");
  } else if (hasInternalCtx && anyExt && !anyExt10) {
    inferred = "internal";
    hints.push("rule:internal_context_short_numbers");
  } else {
    hints.push("rule:insufficient_pattern_log_contexts_only");
  }

  return { inferredCallType: inferred, classificationHints: hints };
}

/** Parse `bridge show all` multiline text (Asterisk CLI). */
function parseBridgeShowAll(text) {
  const lines = text.split(/\r?\n/);
  const bridges = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^Bridge:\s*(\S+)/);
    if (m) {
      if (current) bridges.push(current);
      const rest = line.slice(m.index + m[0].length);
      let bridgeType = "";
      let technology = "";
      const tm = rest.match(/type:\s*([^,)]+)/i);
      if (tm) bridgeType = tm[1].trim();
      const techm = rest.match(/technology:\s*([^)]+)/i);
      if (techm) technology = techm[1].trim();
      current = {
        bridgeId: m[1],
        bridgeType: bridgeType || "(see raw)",
        technology: technology || "(see raw)",
        channelNames: [],
        rawHeaderLine: line.trim(),
      };
      continue;
    }
    if (current && /^\s*Channel:\s*/.test(line)) {
      const cn = line.replace(/^\s*Channel:\s*/, "").replace(/\r$/, "").trim();
      if (cn) current.channelNames.push(cn);
    }
  }
  if (current) bridges.push(current);

  return bridges.map((b) => ({
    bridgeId: b.bridgeId,
    bridgeType: b.bridgeType,
    technology: b.technology,
    channelCount: b.channelNames.length,
    channels: b.channelNames,
    rawHeaderLine: b.rawHeaderLine,
  }));
}

function buildSnapshot(ts, rawChannelsText, rawBridgesText) {
  const parseWarnings = [];
  const channelLines = rawChannelsText.split(/\r?\n/).filter((l) => l.trim());
  const channels = [];
  for (const line of channelLines) {
    const p = parseConciseLine(line);
    if (p) channels.push(p);
  }
  if (channelLines.length > 0 && channels.length === 0) {
    parseWarnings.push("no_concise_rows_parsed_check_delimiter");
  }

  const channelByName = new Map(channels.map((c) => [c.name, c]));
  const bridges = parseBridgeShowAll(rawBridgesText);
  if (rawBridgesText.includes("Bridge:") && bridges.length === 0) {
    parseWarnings.push("bridge_parse_failed_check_cli_format");
  }

  const bridgesOut = bridges.map((b) => {
    const { inferredCallType, classificationHints } = classifyBridge(b, channelByName);
    return {
      bridgeId: b.bridgeId,
      bridgeType: b.bridgeType,
      technology: b.technology,
      channelCount: b.channelCount,
      channels: b.channels,
      inferredCallType,
      classificationHints,
      rawHeaderLine: b.rawHeaderLine,
    };
  });

  return {
    timestamp: ts,
    rawChannelCount: channels.length,
    rawBridgeCount: bridgesOut.length,
    bridges: bridgesOut,
    channels,
    parseWarnings,
  };
}

function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    process.exit(0);
  }

  const remoteUserHost = `${args.user}@${args.host}`;
  const binSafe = AST_BIN.replace(/'/g, "'\\''");
  const pre = (AST_PREFIX || "").trim();
  const runAst = pre
    ? `${pre} '${binSafe}'`
    : `'${binSafe}'`;

  const remoteScript = `while true; do
  echo "___TS___$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ${runAst} -rx 'core show channels concise' 2>/dev/null || true
  echo "___BRG___"
  ${runAst} -rx 'bridge show all' 2>/dev/null || true
  echo "___END___"
  sleep 1
done
`;

  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    remoteUserHost,
    "bash",
    "-s",
  ];
  if (args.identity) {
    sshArgs.unshift("-i", args.identity);
  }

  const child = spawn("ssh", sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdin.write(remoteScript);
  child.stdin.end();

  let buf = "";
  let currentTs = new Date().toISOString();
  let chanBuf = "";
  let mode = "skip";

  child.stderr.on("data", (d) => process.stderr.write(d));

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.startsWith("___TS___")) {
      currentTs = line.slice("___TS___".length).trim() || new Date().toISOString();
      mode = "channels";
      chanBuf = "";
      buf = "";
      return;
    }
    if (line === "___BRG___") {
      buf = "";
      mode = "bridges";
      return;
    }
    if (line === "___END___") {
      const snap = buildSnapshot(currentTs, chanBuf, buf);
      process.stdout.write(`${JSON.stringify(snap)}\n`);
      buf = "";
      chanBuf = "";
      mode = "skip";
      return;
    }
    if (mode === "channels") {
      chanBuf += `${line}\n`;
    } else if (mode === "bridges") {
      buf += `${line}\n`;
    }
  });

  child.on("exit", (code, sig) => {
    if (code && code !== 0) {
      console.error(JSON.stringify({ error: "ssh_exit", code, signal: sig }));
      process.exit(code || 1);
    }
  });

  process.on("SIGINT", () => {
    child.kill("SIGTERM");
    process.exit(0);
  });
}

main();
