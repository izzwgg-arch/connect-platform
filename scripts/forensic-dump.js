/**
 * Forensic side-by-side dump of all live calls through the same resolution pipeline
 * that AriBridgedActivePoller uses.
 */
const http = require("http");

const ARI_HOST = "209.145.60.79";
const ARI_PORT = 8088;
const ARI_AUTH = "connectcomms:8457823075Tty@";
const API_URL  = "http://api:3001/internal/telephony/pbx-tenant-map";

function ariGet(path) {
  return new Promise((resolve, reject) => {
    const opts = { host: ARI_HOST, port: ARI_PORT, path, auth: ARI_AUTH, headers: { accept: "application/json" } };
    http.get(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", reject);
  });
}

function apiGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", reject);
  });
}

function ariGetVar(channelId, varName) {
  return new Promise((resolve) => {
    const path = `/ari/channels/${encodeURIComponent(channelId)}/variable?variable=${encodeURIComponent(varName)}`;
    const opts = { host: ARI_HOST, port: ARI_PORT, path, auth: ARI_AUTH, headers: { accept: "application/json" } };
    http.get(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { const j = JSON.parse(d); resolve(j && j.value != null ? j.value : null); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

function norm(n) { return String(n || "").replace(/\D/g, ""); }

async function main() {
  const [bridgesRaw, channelsRaw, mapData] = await Promise.all([
    ariGet("/ari/bridges"),
    ariGet("/ari/channels"),
    apiGet(API_URL),
  ]);

  const bridges = Array.isArray(bridgesRaw) ? bridgesRaw : [];
  const channels = Array.isArray(channelsRaw) ? channelsRaw : [];
  const byId = {};
  for (const ch of channels) byId[ch.id] = ch;

  // Build DID map
  const didMap = {};
  for (const d of (mapData && mapData.didEntries) || []) {
    didMap[d.e164] = d;
  }
  const slugMap = {};
  const entries = (mapData && mapData.entries) || [];
  const didEntries = (mapData && mapData.didEntries) || [];
  for (const e of entries) {
    if (!e.tenantSlug) continue;
    let uuid = e.connectTenantId;
    if (!uuid) {
      for (const d of didEntries) {
        if (!d.connectTenantId) continue;
        if (d.tenantCode === e.tenantCode) { uuid = d.connectTenantId; break; }
        if (d.vitalTenantId === e.vitalTenantId) { uuid = d.connectTenantId; break; }
      }
    }
    if (uuid) slugMap[e.tenantSlug.toLowerCase()] = { uuid, name: didEntries.find(d => d.connectTenantId === uuid)?.tenantName };
  }

  console.log("DID map size:", Object.keys(didMap).length, "| Slug map size:", Object.keys(slugMap).length);
  console.log("");

  // Find qualifying bridges (≥2 non-Local, non-Down channels)
  for (const br of bridges) {
    const mids = br.channels || [];
    const valid = mids.map(id => byId[id]).filter(ch => ch && ch.name && !ch.name.startsWith("Local/") && ch.state !== "Down");
    if (valid.length < 2) continue;

    console.log("═".repeat(70));
    console.log("BRIDGE:", br.id);
    console.log("");

    // Stage A: raw channel data
    console.log("── STAGE A: RAW CHANNEL DATA ──");
    for (const ch of valid) {
      console.log("  Channel:", ch.name, "(id:", ch.id, ")");
      console.log("    state:", ch.state);
      console.log("    caller.number:", ch.caller && ch.caller.number);
      console.log("    caller.name:", ch.caller && ch.caller.name);
      console.log("    connected.number:", ch.connected && ch.connected.number);
      console.log("    connected.name:", ch.connected && ch.connected.name);
      console.log("    dialplan.context:", ch.dialplan && ch.dialplan.context);
      console.log("    dialplan.exten:", ch.dialplan && ch.dialplan.exten);

      // Fetch channel variables
      const vars = ["CALLERID(num)", "CALLERID(dnid)", "DNID", "EXTEN", "CDR(dst)"];
      for (const v of vars) {
        const val = await ariGetVar(ch.id, v);
        if (val) console.log(`    VAR ${v}:`, val);
      }
    }

    // Stage B: tenant resolution simulation
    console.log("\n── STAGE B: TENANT RESOLUTION ──");
    // Identify channels
    const tnCh = valid.find(ch => /^PJSIP\/T\d+_/i.test(ch.name));
    const trunkCh = valid.find(ch => !(/^PJSIP\/T\d+_/i.test(ch.name)));
    console.log("  Extension channel (T{n}):", tnCh ? tnCh.name : "NONE");
    console.log("  Trunk channel:", trunkCh ? trunkCh.name : "NONE");

    // Extract slug from trunk channel name (PJSIP/{digits}_{slug}-{id})
    let slugFromChannel = null;
    if (trunkCh) {
      const m = /^PJSIP\/(\d+)_([^/-]+)-/i.exec(trunkCh.name);
      if (m) {
        slugFromChannel = m[2].toLowerCase();
        console.log("  Slug from trunk channel name:", slugFromChannel);
        const slugEntry = slugMap[slugFromChannel];
        if (slugEntry) {
          console.log("  Slug resolves to:", slugEntry.uuid, "(", slugEntry.name, ")");
        } else {
          console.log("  Slug NOT in slug map! Available slugs:", Object.keys(slugMap).join(", "));
        }
      } else {
        console.log("  Trunk channel name does NOT match PJSIP/{digits}_{slug} pattern");
      }
    }

    // Extract T-code from extension channel
    let tCode = null;
    if (tnCh) {
      const m = /^PJSIP\/T(\d+)_/i.exec(tnCh.name);
      if (m) tCode = "T" + m[1];
      console.log("  T-code from extension channel:", tCode);
    }

    // Fetch CALLERID(num) from extension channel
    let callerIdNum = null;
    if (tnCh) {
      callerIdNum = await ariGetVar(tnCh.id, "CALLERID(num)");
      console.log("  CALLERID(num) on T{n} channel:", callerIdNum);
      if (callerIdNum && /^\d{7,}$/.test(callerIdNum)) {
        const didEntry = didMap[callerIdNum];
        if (didEntry) {
          console.log("  DID lookup hit:", callerIdNum, "->", didEntry.connectTenantId, "(", didEntry.tenantName, ")");
        } else {
          console.log("  DID lookup MISS for:", callerIdNum, "(not in DID map)");
          // Try last-10 match
          const last10 = callerIdNum.slice(-10);
          const hit = Object.entries(didMap).find(([k]) => k.slice(-10) === last10);
          if (hit) console.log("  Last-10 match:", hit[0], "->", hit[1].connectTenantId);
        }
      }
    }

    // Stage C: destination resolution
    console.log("\n── STAGE C: DESTINATION RESOLUTION ──");
    const callerNum = trunkCh && norm(trunkCh.caller && trunkCh.caller.number);
    const connectedNum = trunkCh && norm(trunkCh.connected && trunkCh.connected.number);
    const dialplanExten = (tnCh || valid[0]) && norm((tnCh || valid[0]).dialplan && (tnCh || valid[0]).dialplan.exten);
    const calledNumCached = callerIdNum && /^\d{7,}$/.test(callerIdNum) ? callerIdNum : null;

    console.log("  Trunk caller.number (digits):", callerNum);
    console.log("  Trunk connected.number (digits):", connectedNum);
    console.log("  dialplan.exten (digits):", dialplanExten);
    console.log("  CALLERID(num) cached:", calledNumCached);

    let toField = null;
    let toSource = null;
    if (calledNumCached && calledNumCached.length >= 7) {
      toField = calledNumCached; toSource = "CALLERID(num) on T{n} channel";
    } else if (connectedNum && connectedNum.length >= 7) {
      toField = connectedNum; toSource = "trunk connected.number";
    } else if (dialplanExten && dialplanExten.length >= 7) {
      toField = dialplanExten; toSource = "dialplanExten";
    } else {
      toField = "Unknown"; toSource = "FALLBACK (no 7+ digit number found)";
    }
    console.log("  RESOLVED to:", toField, "(source:", toSource + ")");

    // Stage D: final payload
    console.log("\n── STAGE D: FINAL PAYLOAD ──");
    const from = (trunkCh && trunkCh.caller && trunkCh.caller.number) || "?";
    console.log("  from:", from);
    console.log("  to:", toField);
    if (calledNumCached && didMap[calledNumCached]) {
      console.log("  tenantId:", didMap[calledNumCached].connectTenantId);
      console.log("  tenantName:", didMap[calledNumCached].tenantName);
    } else if (slugFromChannel && slugMap[slugFromChannel]) {
      console.log("  tenantId:", slugMap[slugFromChannel].uuid);
      console.log("  tenantName:", slugMap[slugFromChannel].name);
    } else {
      console.log("  tenantId: null (unresolved)");
      console.log("  tenantName: null");
    }
    console.log("");
  }

  if (bridges.filter(b => (b.channels||[]).length >= 2).length === 0) {
    console.log("No active bridged calls. Make calls and re-run.");
  }
}

main().catch(console.error);
