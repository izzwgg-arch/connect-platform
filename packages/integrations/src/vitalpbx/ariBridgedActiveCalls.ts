/**
 * VitalPBX / Asterisk-aligned active calls from ARI bridges + channels (read-only).
 *
 * PBX truth (observed via `core show channels` on VitalPBX / Asterisk 20):
 * - Footer "N active channel(s)" / "N active call(s)" excludes `Message/*` helper
 *   while still listing that row (e.g. Message/ast_msg_queue + one PJSIP in VoiceMail
 *   → 1 active channel, 1 active call, zero mixing bridges).
 * - Connected two-party calls usually appear as a bridge with two non-Local legs;
 *   ringing may already be bridged, so requiring "Up" only would under-count vs PBX.
 *
 * Connect counts:
 * 1) One call per qualifying bridge: ≥2 non-Local, non-Down party channels.
 * 2) Plus unbridged party clusters: not on any bridge, not Message/ or Local/, not Down;
 *    grouped by linkedid when present on the ARI channel object.
 */

export type AriChannelDoc = {
  id?: string;
  name?: string;
  state?: string;
  caller?: { name?: string; number?: string };
  connected?: { name?: string; number?: string };
  dialplan?: {
    context?: string;
    exten?: string;
    priority?: string | number;
    app_name?: string;
    app_data?: string;
  };
};

export type AriBridgeDoc = {
  id?: string;
  channels?: string[];
  technology?: string;
  bridge_type?: string;
  bridge_class?: string;
  name?: string;
  creator?: string;
};

export type BridgedActiveCallRow = {
  bridgeId: string;
  channelCount: number;
  caller: string;
  callee: string;
  sourceKind: "bridge" | "orphan_leg";
  dialplanContext?: string;
  dialplanExten?: string;
};

export type BridgedActiveExcluded = { bridgeId: string; reason: string };

/** Per-bridge detail for VitalPBX parity checks (admin diagnostics only). */
export type QualifyingBridgeDiag = {
  bridgeId: string;
  bridgeType: string;
  totalMemberCount: number;
  validMemberCount: number;
  upCount: number;
  channelNames: string[];
  channelStates: string[];
};

export type ExcludedBridgeDiag = {
  bridgeId: string;
  bridgeType: string;
  exclusionReasons: string[];
  memberSummary: string;
};

export type BridgedActiveVerification = {
  rawBridgeCount: number;
  rawChannelCount: number;
  qualifyingBridgeCount: number;
  bridgeBackedCallCount: number;
  orphanLegCallCount: number;
  finalActiveCalls: number;
  qualifyingBridges: QualifyingBridgeDiag[];
  excludedBridges: ExcludedBridgeDiag[];
  orphanLegs: Array<{ groupKey: string; channelNames: string[] }>;
};

export type BridgedActiveResult = {
  activeCalls: number;
  bridges: BridgedActiveCallRow[];
  debug: {
    totalChannels: number;
    totalBridges: number;
    qualifyingBridges: number;
    orphanLegCalls: number;
    excluded: BridgedActiveExcluded[];
  };
  verification: BridgedActiveVerification;
};

function channelName(ch: AriChannelDoc): string {
  return String(ch.name ?? "").trim();
}

function isLocalHelperName(name: string): boolean {
  return name.startsWith("Local/");
}

function isDownState(state: string): boolean {
  const s = state.trim().toLowerCase();
  return s === "down" || s === "";
}

function isUpState(state: string): boolean {
  return state.trim().toLowerCase() === "up";
}

function partyLabel(ch: AriChannelDoc): string {
  const n =
    String(ch.caller?.number ?? "").trim() ||
    String(ch.connected?.number ?? "").trim() ||
    String(ch.caller?.name ?? "").trim() ||
    String(ch.connected?.name ?? "").trim();
  return n || "—";
}

function dialplanOf(ch: AriChannelDoc): { context: string; exten: string } {
  const d = ch.dialplan;
  return {
    context: String(d?.context ?? "").trim(),
    exten: String(d?.exten ?? "").trim(),
  };
}

function readLinkedId(ch: AriChannelDoc & Record<string, unknown>): string {
  const v =
    ch.linkedid ??
    ch.linked_id ??
    (typeof ch.channelvars === "object" && ch.channelvars !== null
      ? (ch.channelvars as Record<string, string>).LINKEDID
      : undefined);
  return String(v ?? "").trim();
}

/** PBX `core show channels` summary excludes Message/; Local/ is a helper leg on VitalPBX. */
function isExcludedOrphanHelperName(name: string): boolean {
  return name.startsWith("Message/") || name.startsWith("Local/");
}

function bridgeTypeLabel(br: AriBridgeDoc): string {
  const parts = [
    br.technology && `technology=${br.technology}`,
    br.bridge_type && `bridge_type=${br.bridge_type}`,
    br.bridge_class && `bridge_class=${br.bridge_class}`,
    br.name && `name=${br.name}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "(unknown)";
}

function buildMemberSummary(
  memberIds: string[],
  byId: Map<string, AriChannelDoc>,
): string {
  if (memberIds.length === 0) return "(no members)";
  return memberIds
    .map((mid) => {
      const ch = byId.get(mid);
      if (!ch) return `${mid}:not_in_channel_snapshot`;
      const nm = channelName(ch) || "(empty name)";
      const st = String(ch.state ?? "?");
      return `${mid}→${nm}(${st})`;
    })
    .join(" | ");
}

function twoPartyLabels(group: AriChannelDoc[]): { caller: string; callee: string } {
  if (group.length === 0) return { caller: "—", callee: "—" };
  if (group.length === 1) {
    const ch = group[0]!;
    const a = String(ch.caller?.number ?? "").trim();
    const b = String(ch.connected?.number ?? "").trim();
    return {
      caller: a || partyLabel(ch),
      callee: b || "—",
    };
  }
  return {
    caller: partyLabel(group[0]!),
    callee: partyLabel(group[1]!) || partyLabel(group[0]!),
  };
}

function pickDialplanForGroup(group: AriChannelDoc[]): { context: string; exten: string } {
  for (const ch of group) {
    const { context, exten } = dialplanOf(ch);
    if (context) return { context, exten };
  }
  return dialplanOf(group[0]!);
}

/**
 * @param bridges — from GET /ari/bridges
 * @param channels — from GET /ari/channels
 */
export function computeBridgedActiveCalls(
  bridges: AriBridgeDoc[],
  channels: AriChannelDoc[],
): BridgedActiveResult {
  const byId = new Map<string, AriChannelDoc>();
  for (const c of channels) {
    const id = String(c.id ?? "");
    if (id) byId.set(id, c);
  }

  const allBridgedMemberIds = new Set<string>();
  for (const br of bridges) {
    const memberIds = Array.isArray(br.channels) ? br.channels.map(String) : [];
    for (const mid of memberIds) {
      if (mid) allBridgedMemberIds.add(mid);
    }
  }

  const excluded: BridgedActiveExcluded[] = [];
  const excludedBridges: ExcludedBridgeDiag[] = [];
  const rows: BridgedActiveCallRow[] = [];
  const qualifyingBridges: QualifyingBridgeDiag[] = [];

  for (const br of bridges) {
    const bridgeId = String(br.id ?? "");
    const bType = bridgeTypeLabel(br);

    if (!bridgeId) {
      const reasons = ["no_bridge_id"];
      excluded.push({ bridgeId: "(missing)", reason: reasons[0] });
      excludedBridges.push({
        bridgeId: "(missing)",
        bridgeType: bType,
        exclusionReasons: reasons,
        memberSummary: "(n/a)",
      });
      continue;
    }

    const memberIds = Array.isArray(br.channels) ? br.channels.map(String) : [];
    const totalMemberCount = memberIds.length;

    if (memberIds.length === 0) {
      const reasons = ["no_channels_on_bridge"];
      excluded.push({ bridgeId, reason: reasons[0] });
      excludedBridges.push({
        bridgeId,
        bridgeType: bType,
        exclusionReasons: reasons,
        memberSummary: "(empty member list)",
      });
      continue;
    }

    const resolved: AriChannelDoc[] = [];
    const missingIds: string[] = [];
    for (const mid of memberIds) {
      const ch = byId.get(mid);
      if (!ch) missingIds.push(mid);
      else resolved.push(ch);
    }

    const valid: AriChannelDoc[] = [];
    let localSkipped = 0;
    let downSkipped = 0;
    let emptyNameSkipped = 0;
    for (const ch of resolved) {
      const name = channelName(ch);
      const state = String(ch.state ?? "");
      if (!name) {
        emptyNameSkipped++;
        continue;
      }
      if (isLocalHelperName(name)) {
        localSkipped++;
        continue;
      }
      if (isDownState(state)) {
        downSkipped++;
        continue;
      }
      valid.push(ch);
    }

    const memberSummaryFull = buildMemberSummary(memberIds, byId);

    if (missingIds.length > 0) {
      const reasons = [
        "channel_not_in_snapshot",
        `missing_channel_ids=${missingIds.join(",")}`,
      ];
      excluded.push({
        bridgeId,
        reason: reasons.join(";"),
      });
      excludedBridges.push({
        bridgeId,
        bridgeType: bType,
        exclusionReasons: reasons,
        memberSummary: memberSummaryFull,
      });
      continue;
    }

    if (valid.length < 2) {
      const reasons = [
        "lt2_valid_channels",
        `valid=${valid.length}`,
        `local_skipped=${localSkipped}`,
        `down_skipped=${downSkipped}`,
        `empty_name_skipped=${emptyNameSkipped}`,
      ];
      excluded.push({
        bridgeId,
        reason: `lt2_valid(valid=${valid.length},local=${localSkipped},down=${downSkipped},emptyName=${emptyNameSkipped})`,
      });
      excludedBridges.push({
        bridgeId,
        bridgeType: bType,
        exclusionReasons: reasons,
        memberSummary: memberSummaryFull,
      });
      continue;
    }

    const upCount = valid.filter((ch) => isUpState(String(ch.state ?? ""))).length;

    const labels = valid.map(partyLabel);
    const caller = labels[0] ?? "—";
    const callee = labels[1] ?? labels[0] ?? "—";

    let ctx = "";
    let ext = "";
    for (const ch of valid) {
      const dp = dialplanOf(ch);
      if (dp.context) {
        ctx = dp.context;
        ext = dp.exten;
        break;
      }
    }

    rows.push({
      bridgeId,
      channelCount: valid.length,
      caller,
      callee,
      sourceKind: "bridge",
      dialplanContext: ctx || undefined,
      dialplanExten: ext || undefined,
    });

    qualifyingBridges.push({
      bridgeId,
      bridgeType: bType,
      totalMemberCount,
      validMemberCount: valid.length,
      upCount,
      channelNames: valid.map((ch) => channelName(ch) || "(unnamed)"),
      channelStates: valid.map((ch) => String(ch.state ?? "")),
    });
  }

  const orphanGroups = new Map<string, AriChannelDoc[]>();
  for (const ch of channels) {
    const id = String(ch.id ?? "");
    if (!id || allBridgedMemberIds.has(id)) continue;
    const name = channelName(ch);
    if (!name || isExcludedOrphanHelperName(name)) continue;
    if (isDownState(String(ch.state ?? ""))) continue;

    const lid = readLinkedId(ch as AriChannelDoc & Record<string, unknown>);
    const gkey = lid.length > 0 ? `linked:${lid}` : `solo:${id}`;
    const list = orphanGroups.get(gkey);
    if (list) list.push(ch);
    else orphanGroups.set(gkey, [ch]);
  }

  const orphanLegs: Array<{ groupKey: string; channelNames: string[] }> = [];
  for (const [groupKey, group] of orphanGroups) {
    group.sort((a, b) => channelName(a).localeCompare(channelName(b)));
    const { caller, callee } = twoPartyLabels(group);
    const { context, exten } = pickDialplanForGroup(group);
    rows.push({
      bridgeId: `orphan:${groupKey}`,
      channelCount: group.length,
      caller,
      callee,
      sourceKind: "orphan_leg",
      dialplanContext: context || undefined,
      dialplanExten: exten || undefined,
    });
    orphanLegs.push({
      groupKey,
      channelNames: group.map((c) => channelName(c) || String(c.id ?? "?")),
    });
  }

  const bridgeBackedCallCount = rows.filter((r) => r.sourceKind === "bridge").length;
  const orphanLegCallCount = rows.filter((r) => r.sourceKind === "orphan_leg").length;

  const verification: BridgedActiveVerification = {
    rawBridgeCount: bridges.length,
    rawChannelCount: channels.length,
    qualifyingBridgeCount: qualifyingBridges.length,
    bridgeBackedCallCount,
    orphanLegCallCount,
    finalActiveCalls: rows.length,
    qualifyingBridges,
    excludedBridges,
    orphanLegs,
  };

  return {
    activeCalls: rows.length,
    bridges: rows,
    debug: {
      totalChannels: channels.length,
      totalBridges: bridges.length,
      qualifyingBridges: bridgeBackedCallCount,
      orphanLegCalls: orphanLegCallCount,
      excluded,
    },
    verification,
  };
}
